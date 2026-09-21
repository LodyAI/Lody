import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteLedgerStore } from '@lody/e2ee-core/ledger-node';
import { composeDurability, composeIntegrity } from './judge';
import { inspectClient, type HonestInspect, type PublicReport } from './attack-lab';
import type { HonestClient } from './actors';
import type { LabBackend } from './backend';
import { fingerprintOf, type FailureFingerprint } from './fingerprint';
import { loroCursorPath, loroDocPath } from './platform/persist';

export type KnownDefect = 'skip-verify' | 'cursor-before-document' | 'wrong-context-journal';

/** Flip one byte of a persisted journal record so verify fails on reload. */
export async function injectSkipVerify(clientDir: string): Promise<void> {
  const store = new SqliteLedgerStore(join(clientDir, 'ledger.sqlite'));
  await store.exclusive(async (tx) => {
    const journal = await tx.load();
    if (!journal || journal.records.length === 0) throw new Error('defect-no-journal');
    const last = new Uint8Array(journal.records[journal.records.length - 1]!);
    last[last.byteLength - 1] = (last[last.byteLength - 1] ?? 0) ^ 0xff;
    const records = journal.records.slice();
    records[records.length - 1] = last;
    await tx.save({ ...journal, records });
  });
}

/** Persist a cursor without the matching document snapshot. */
export function injectCursorBeforeDocument(clientDir: string, genesisHex: string): void {
  mkdirSync(clientDir, { recursive: true });
  const doc = loroDocPath(clientDir);
  if (existsSync(doc)) rmSync(doc);
  writeFileSync(
    loroCursorPath(clientDir),
    JSON.stringify({
      streamUrl: `http://127.0.0.1/ds/${genesisHex}/loro`,
      nextOffset: '999',
      serverLowerBoundVersion: { '1': 99 },
    })
  );
}

/** Replace the target journal with another Org's verified bytes. */
export async function injectWrongContextJournal(
  targetDir: string,
  foreignDir: string
): Promise<void> {
  const source = new SqliteLedgerStore(join(foreignDir, 'ledger.sqlite'));
  const dest = new SqliteLedgerStore(join(targetDir, 'ledger.sqlite'));
  const journal = await source.exclusive((tx) => tx.load());
  if (!journal) throw new Error('defect-no-foreign-journal');
  await dest.exclusive(async (tx) => {
    await tx.save(journal);
  });
}

export async function applyKnownDefect(
  kind: KnownDefect,
  input: { clientDir: string; genesisHex: string; foreignDir?: string }
): Promise<void> {
  if (kind === 'skip-verify') {
    await injectSkipVerify(input.clientDir);
    return;
  }
  if (kind === 'cursor-before-document') {
    injectCursorBeforeDocument(input.clientDir, input.genesisHex);
    return;
  }
  if (!input.foreignDir) throw new Error('defect-missing-foreign');
  await injectWrongContextJournal(input.clientDir, input.foreignDir);
}

export function reportFromInspect(inspect: HonestInspect): PublicReport {
  const observed =
    inspect.unmeasured !== true &&
    inspect.unverifiedAccepted !== undefined &&
    inspect.cursorAhead !== undefined &&
    inspect.durableLoss !== undefined;
  return {
    confidentiality: 'pass',
    integrity: composeIntegrity({
      observed,
      acceptedUnauthorized: (inspect.unverifiedAccepted ?? 0) > 0,
      unauthorizedContentAccepted: inspect.unauthorizedContentAccepted,
      wrongContextAccepted: inspect.wrongContextAccepted,
    }),
    durability: composeDurability({
      observed,
      cursorAheadOfDocument: inspect.cursorAhead === true,
      lostDurableData: inspect.durableLoss === true,
    }),
    detectability: inspect.wrongContextAccepted ? 'violation' : 'pass',
    budgetExceeded: false,
    claims: 0,
  };
}

export function fingerprintFromInspect(inspect: HonestInspect): FailureFingerprint {
  const report = reportFromInspect(inspect);
  if (inspect.wrongContextAccepted && report.integrity !== 'violation') {
    return fingerprintOf(
      { ...report, integrity: 'violation' },
      {
        unverifiedAccepted: inspect.unverifiedAccepted,
        cursorAhead: inspect.cursorAhead,
        durableLoss: inspect.durableLoss,
        wrongContextAccepted: true,
        acceptedUnauthorized: (inspect.unverifiedAccepted ?? 0) > 0,
        verifiedRecords: inspect.verifiedRecords,
      }
    );
  }
  return fingerprintOf(report, {
    unverifiedAccepted: inspect.unverifiedAccepted,
    cursorAhead: inspect.cursorAhead,
    durableLoss: inspect.durableLoss,
    wrongContextAccepted: inspect.wrongContextAccepted,
    acceptedUnauthorized: (inspect.unverifiedAccepted ?? 0) > 0,
    verifiedRecords: inspect.verifiedRecords,
  });
}

export async function measureClient(
  client: HonestClient,
  host: LabBackend
): Promise<{ inspect: HonestInspect; fingerprint: FailureFingerprint; report: PublicReport }> {
  const inspect = await inspectClient(client, host)();
  const fingerprint = fingerprintFromInspect(inspect);
  return { inspect, fingerprint, report: reportFromInspect(inspect) };
}
