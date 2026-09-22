/** Four-class 1000-record gates: full replay, incremental extend, snapshot start, journal recovery.
 * Local measurement only; no CI timing assertion and no restored 10k/100ms target. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/ledger';
import { SqliteLedgerStore } from '../src/ledger/node-store';
import { buildChain } from './chain';

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function measure(warmup: number, runs: number, work: () => Promise<void>): Promise<number[]> {
  for (let i = 0; i < warmup; i++) await work();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await work();
    samples.push(performance.now() - start);
  }
  return samples;
}

async function main() {
  const count = 1000;
  const warmup = 3;
  const runs = 10;
  process.stderr.write(`building ${count} signed records\n`);
  const { owner, created, records, ledger } = await buildChain(count);
  const prefix = records.slice(0, count - 1);
  const last = records.slice(count - 1);
  const proposal = ledger.prepareSnapshot(owner.publicKey);
  const snapshot = await Ledger.finalizeSnapshot(proposal, await owner.sign(proposal.signingBytes));
  const headSignature = await owner.sign(proposal.headAttestationSigningBytes);
  const trust = {
    genesis: proposal.genesis,
    endorser: owner.publicKey,
    head: proposal.head,
    headSignature,
  };
  const dir = mkdtempSync(join(tmpdir(), 'e2ee-effect-classes-'));
  const path = join(dir, 'journal.sqlite');
  try {
    const store = new SqliteLedgerStore(path, { createFile: true, initializeSchema: true });
    await store.exclusive((tx) =>
      tx.save({
        genesis: created.anchor,
        records,
        pending: null,
        offset: 'empty:/+',
      })
    );

    const replay = await measure(warmup, runs, async () => {
      const verified = await Ledger.verify({ anchor: created.anchor, records });
      if (verified.length !== count) throw new Error('replay-length');
    });
    const base = await Ledger.verify({ anchor: created.anchor, records: prefix });
    if (base.length !== count - 1) throw new Error('incremental-base');
    const incremental = await measure(warmup, runs, async () => {
      const next = await base.extend(last);
      if (next.length !== count) throw new Error('incremental-length');
    });
    const snapshotStart = await measure(warmup, runs, async () => {
      const joined = await Ledger.verifySnapshot({ trust, snapshot });
      if (joined.length !== count) throw new Error('snapshot-length');
    });
    const recovery = await measure(warmup, runs, async () => {
      const reopened = new SqliteLedgerStore(path, { createFile: false, initializeSchema: false });
      const journal = await reopened.exclusive((tx) => tx.load());
      if (!journal || journal.records.length !== count) throw new Error('recovery-journal');
      const verified = await Ledger.verify({
        anchor: journal.genesis,
        records: journal.records,
      });
      if (verified.length !== count) throw new Error('recovery-length');
    });

    console.log(
      JSON.stringify({
        node: process.version,
        records: count,
        warmup,
        runs,
        replayMedianMs: median(replay),
        incrementalMedianMs: median(incremental),
        snapshotMedianMs: median(snapshotStart),
        recoveryMedianMs: median(recovery),
        replayMs: replay,
        incrementalMs: incremental,
        snapshotMs: snapshotStart,
        recoveryMs: recovery,
      })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
