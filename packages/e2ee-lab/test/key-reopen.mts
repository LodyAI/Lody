import Database from 'better-sqlite3';
import { commitEpochKey, recoverLedgerHistory } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { verifyLedger, epochHistoryPacket } from '@lody/e2ee-core/protocol';
import { makeSqliteRecipientMailbox } from '@lody/e2ee-core/internal';
import { makeLabMailboxRemote } from '../src/platform/key-mailbox';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
const [directory, baseUrl, stage] = process.argv.slice(2);
if (
  stage !== undefined &&
  stage !== 'epoch1' &&
  stage !== 'installed-only' &&
  stage !== 'crash-before-report'
)
  throw new Error('unknown synthetic key stage');
const installedOnly = stage === 'installed-only';
let crashArmed = false;
const epoch1 = stage === 'epoch1' || installedOnly;
const prefix = epoch1 ? 'epoch1-recovery' : 'recovery';
const mode = epoch1 ? 'create' : 'open';
const ok = Result.getOrThrow;
// This fixture is written only by the parent test: synthetic local keys/public
// signed records in file0600, not a production credential/recovery-vault format.
const fixture = JSON.parse(readFileSync(join(directory!, 'recovery-device.json'), 'utf8')) as {
  genesis: string;
  records: string[];
  checkpoint: { head: string; length: number };
  privateKey: string;
  publicKey: string;
};
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const genesis = ok(Bytes.genesisHash(bytes(fixture.genesis)));
const view = ok(
  verifyLedger({
    anchor: genesis,
    records: fixture.records.map(bytes),
    checkpoint: {
      head: ok(Bytes.recordHash(bytes(fixture.checkpoint.head))),
      length: fixture.checkpoint.length,
    },
  })
);
const key = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 102),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const signer = {
  publicKey: ok(
    Bytes.signingPublicKey(
      new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32))
    )
  ),
  sign: (message: Uint8Array) =>
    Effect.sync(() => {
      if (stage === 'crash-before-report' && crashArmed) process.exit(73);
      return ok(Bytes.signature(new Uint8Array(sign(null, message, key))));
    }),
};
// Restricted A: local protected originals only. No sender eligibility check,
// HPKE private-handle import, envelope reopen, report retry or network operation.
if (installedOnly) {
  const commitments = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const keys = yield* makeSqliteProtectedEpochKeys({
          path: join(directory!, `${prefix}-keys.sqlite`),
          mode: 'open',
          genesis,
          recipient: signer.publicKey,
          ledger: () => Effect.succeed(view),
          protector: labSyntheticProtector,
        });
        const result: { epoch: number; matches: boolean }[] = [];
        for (const epoch of [0, 1]) {
          const installedKey = yield* keys.read(epoch);
          result.push({
            epoch,
            matches: ok(commitEpochKey(genesis, epoch, installedKey)).equals(
              ok(epochHistoryPacket(view, epoch)).commitment
            ),
          });
        }
        return result;
      })
    )
  );
  process.stdout.write(JSON.stringify({ commitments, localOnly: true }) + '\n');
} else {
  // Locked HPKE serializes the public handle to bind recipient bytes; private DH
  // remains non-extractable. No algorithm/public-core change or custody claim.
  const pair = {
    privateKey: await crypto.subtle.importKey('pkcs8', bytes(fixture.privateKey), 'X25519', false, [
      'deriveBits',
    ]),
    publicKey: await crypto.subtle.importKey('raw', bytes(fixture.publicKey), 'X25519', true, []),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const identity = yield* makeLabHttpIdentity({ baseUrl: baseUrl!, genesis });
        const session = yield* identity.authenticate(signer);
        const remote = yield* makeLabMailboxRemote(session);
        const receiver = yield* makeSqliteRecipientMailbox({
          path: join(directory!, `${prefix}-receive.sqlite`),
          mode,
          genesis,
          signer,
          pair,
          ledger: () => Effect.succeed(view),
          remote,
          keyStore: {
            path: join(directory!, `${prefix}-keys.sqlite`),
            mode,
            protector: labSyntheticProtector,
          },
          repairStore: { path: join(directory!, `${prefix}-repair.sqlite`), mode },
        });
        crashArmed = true;
        const installed = yield* receiver.fetchAndInstall(); // Actual HPKE opens pending original frame and saves/readbacks.
        yield* receiver.flushReports(); // Actual protected-key read/commitment and signed HTTP report/ACK.
        const outcomes = (yield* receiver.results()).map((result) => result.outcome);
        let history;
        if (epoch1) {
          const keys = yield* makeSqliteProtectedEpochKeys({
            path: join(directory!, `${prefix}-keys.sqlite`),
            mode: 'open',
            genesis,
            recipient: signer.publicKey,
            ledger: () => Effect.succeed(view),
            protector: labSyntheticProtector,
          });
          const db = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Database(join(directory!, `${prefix}-keys.sqlite`), {
                  fileMustExist: true,
                  readonly: true,
                })
            ),
            (handle) => Effect.sync(() => handle.close())
          );
          const epochs = () =>
            (
              db.prepare('SELECT epoch FROM installed_epoch_keys ORDER BY epoch').all() as {
                epoch: number;
              }[]
            ).map((row) => row.epoch);
          const beforeHistory = epochs();
          // Only the actual installed latest key is read; no old key or plaintext
          // material is supplied by the parent, and no private core helper is imported.
          const latest = yield* keys.read(1);
          const recovered = ok(recoverLedgerHistory(view, latest));
          const original = ok(commitEpochKey(genesis, 0, recovered.get(0)!));
          const expected = ok(epochHistoryPacket(view, 0)).commitment;
          const historyCommitmentMatchesOriginal = original.equals(expected);
          yield* keys.saveAndReload(0, recovered.get(0)!);
          history = { beforeHistory, afterHistory: epochs(), historyCommitmentMatchesOriginal };
        }
        process.stdout.write(JSON.stringify({ installed, outcomes, ...history }) + '\n');
      })
    )
  );
}
