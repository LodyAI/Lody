// Synthetic app entry for real-browser storage acceptance; no product transport.
import { Context, Effect, Exit, Layer, Result, Scope } from 'effect';
import { indexedDbClientStores } from '@lody/e2ee-core/adapters/indexeddb';
import {
  LedgerPinStore,
  LedgerFeedStore,
  SubmissionJournal,
  ClientPairingOriginalStore,
  WorkspaceScope,
} from '@lody/e2ee-core/services';
import * as Bytes from '../../src/internal/foundation/bytes';
import vector from '../ledger-v1-vector.json';
import {
  verifyLedger,
  exportVerifiedState,
  restoreVerifiedState,
} from '../../src/internal/ledger/replay';

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
const ok = <A, E>(value: Result.Result<A, E>) => Result.getOrThrow(value);
const genesis = ok(Bytes.genesisHash(bytes(vector.anchor)));
const record = (index: number) => bytes(vector.records[index]!.hex);
const checkpoint = (index: number) => ({
  head: ok(Bytes.recordHash(bytes(vector.records[index]!.hash))),
  length: index + 1,
});
const tail = (index: number) => ({
  head: bytes(vector.records[index]!.hash),
  count: index + 1,
  offset: String(index),
  bootstrap: false,
  bytes: vector.records.slice(0, index + 1).reduce((total, row) => total + row.hex.length / 2, 0),
});
const retainedAt = (index: number) =>
  ok(
    exportVerifiedState(
      ok(
        verifyLedger({
          anchor: genesis,
          records: vector.records.slice(0, index + 1).map((_, i) => record(i)),
          checkpoint: checkpoint(index),
        })
      )
    )
  );
const retained = retainedAt(1);
let listCursor: string | null = null;
const key = {
  accountId: 'synthetic-account',
  workspaceId: 'synthetic-workspace',
  genesis,
  device: ok(
    Bytes.signingPublicKey(
      bytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
    )
  ),
  installationId: '11'.repeat(32),
  pairingSessionId: '22'.repeat(16),
  purpose: 'request' as const,
};
let ownerScope: Scope.Closeable | undefined;
let ports:
  | Context.Context<
      LedgerPinStore | LedgerFeedStore | SubmissionJournal | ClientPairingOriginalStore
    >
  | undefined;
let retainedPin: LedgerPinStore['Service'] | undefined;
export async function boot(
  name: string,
  accountId?: string,
  mode?: 'create-or-open' | 'open-existing'
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      ownerScope = yield* Scope.make();
      ports = yield* Layer.buildWithScope(
        indexedDbClientStores({
          databaseName: name,
          accountId: accountId ?? key.accountId,
          workspaceId: key.workspaceId,
          mode: mode ?? 'create-or-open',
        }).pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis }))),
        ownerScope
      );
      retainedPin = Context.get(ports, LedgerPinStore);
      yield* Context.get(ports, LedgerFeedStore).tail();
      return true;
    })
  );
}

function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return hex(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    if ('toBytes' in value && typeof value.toBytes === 'function') return hex(value.toBytes());
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}
export async function invoke(action: string, n = 0) {
  if (!ports) throw new Error('fixture not booted');
  const outcome = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const pins = yield* LedgerPinStore,
          feed = yield* LedgerFeedStore,
          submissions = yield* SubmissionJournal,
          pairings = yield* ClientPairingOriginalStore;
        switch (action) {
          case 'readPin':
            return yield* pins.read();
          case 'writePin':
            return yield* pins.write(checkpoint(n));
          case 'initialize':
            return yield* feed.initialize(record(0), 1, tail(0));
          case 'append':
            return yield* feed.append(tail(0), [record(1)], tail(1));
          case 'appendThird':
            return yield* feed.append(tail(1), [record(2)], tail(2));
          case 'rebaseThird': {
            const saved = retainedAt(2);
            return yield* feed.rebase(tail(2), saved.bytes, 3, {
              ...tail(2),
              bytes: saved.bytes.length,
            });
          }
          case 'appendInvalid':
            return yield* feed.append(tail(1), [record(2)], { ...tail(2), count: 99 });
          case 'rebase':
            return yield* feed.rebase(tail(1), retained.bytes, 2, {
              ...tail(1),
              bytes: retained.bytes.length,
            });
          case 'restore': {
            const saved = yield* feed.load(100);
            if (!saved) throw new Error('missing fixture feed');
            const restored = restoreVerifiedState({ ...retained, bytes: saved.origin });
            return Result.isSuccess(restored)
              ? { head: restored.success.head.toBytes(), length: restored.success.length }
              : { rejected: true };
          }
          case 'prepare':
            return yield* submissions.prepare(genesis, record(n || 1));
          case 'finish':
            return yield* submissions.finish(genesis, record(1), 'Committed', null, checkpoint(1));
          case 'rollbackSubmission':
            return yield* submissions.observe(genesis, record(1), checkpoint(1), checkpoint(0));
          case 'acknowledge':
            return yield* submissions.acknowledge(genesis, {
              record: record(1),
              outcome: 'Committed',
            });
          case 'pairPrepare':
            return yield* pairings.compareAndSet(key, null, {
              revision: 1,
              original: record(0),
              receipt: null,
            });
          case 'pairReceipt':
            return yield* pairings.compareAndSet(key, 1, {
              revision: 2,
              original: record(0),
              receipt: Uint8Array.of(0x81, n || 1),
            });
          case 'pairReplace':
            return yield* pairings.compareAndSet(key, 2, {
              revision: 3,
              original: record(1),
              receipt: Uint8Array.of(0x81, 1),
            });
          case 'pairPrepareApproval':
            return yield* pairings.compareAndSet({ ...key, purpose: 'approval' }, null, {
              revision: 1,
              original: record(0),
              receipt: null,
            });
          case 'pairPrepareClaim':
            return yield* pairings.compareAndSet({ ...key, purpose: 'claim' }, null, {
              revision: 1,
              original: record(1),
              receipt: null,
            });
          case 'listFirst': {
            const page = yield* pairings.list(key, null, n || 1);
            listCursor = page.next;
            return page;
          }
          case 'listNext':
            return yield* pairings.list(key, listCursor, n || 1);
          case 'pairRetryReceipt': {
            const saved = yield* pairings.load(key);
            if (!saved) throw new Error('missing fixture pairing');
            return yield* pairings.compareAndSet(key, 1, saved);
          }
          case 'pairReplacePending':
            return yield* pairings.compareAndSet(key, 1, {
              revision: 2,
              original: record(1),
              receipt: Uint8Array.of(0x81, 1),
            });
          case 'pairWrongScope':
            return yield* pairings.load({ ...key, accountId: 'another-account' });
          case 'snapshot':
            return {
              pin: yield* pins.read(),
              feed: yield* feed.load(100),
              submission: yield* submissions.load(genesis),
              pairing: yield* pairings.load(key),
            };
          case 'capacity':
            return yield* feed.load(0);
          case 'prepareAndHold': {
            yield* submissions.prepare(genesis, record(1));
            (globalThis as unknown as { commitReached: boolean }).commitReached = true;
            return yield* Effect.never;
          }
          default:
            throw new Error('unknown fixture action');
        }
      })
    ).pipe(Effect.provide(ports))
  );
  return Result.isSuccess(outcome)
    ? { ok: true, value: plain(outcome.success) }
    : { ok: false, reason: outcome.failure.reason };
}
export async function stop() {
  if (ownerScope) await Effect.runPromise(Scope.close(ownerScope, Exit.void));
}
export async function readAfterClose() {
  const result = await Effect.runPromise(Effect.result(retainedPin!.read()));
  return Result.isFailure(result) ? result.failure.reason : 'unexpected-success';
}
