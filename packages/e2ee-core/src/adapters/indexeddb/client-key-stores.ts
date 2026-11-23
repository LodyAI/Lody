import { Context, Effect, Layer, Schema } from 'effect';
import {
  InstalledKeyStore,
  ReceiveJournal,
  RepairJournal,
  DistributionJournal,
  DeliveryOutbox,
  EpochCandidateStore,
  type EpochCandidateRow,
} from '../../services/stores';
import { DeviceIdentity } from '../../services/workspace';
import type { ClientCustodyBinding } from '../../services/client-custody';
import { MAX_PROTECTED_EPOCH_BYTES } from '../../internal/keys/installed-keys';
import {
  openClientDatabase,
  bindingRaw,
  bindingId,
  sameScope,
  sameBinding,
  BindingSchema,
  safeInt,
  boundedBytes,
  attempt,
  decode,
  writeRow,
  equal,
} from './client-database';
import { failure, type Transaction } from './database';

/** Stable key-journal routing; old incarnations retain their original partition after replacement. */
export interface IndexedDbClientKeyStoreOptions {
  /** Stable shared custody database, separate from the ledger database. */
  readonly databaseName: string;
  /** Complete local owner; DeviceIdentity independently supplies its signing public key. */
  readonly binding: ClientCustodyBinding;
  /** Returning installations require open-existing. */
  readonly mode: 'create-or-open' | 'open-existing';
  /** Bound on unconsumed distribution tasks; defaults to 10000. Capacity never deletes tasks. */
  readonly maxTasks?: number;
}
const S = Schema;
const Receive = S.Struct({
  id: S.String,
  body: S.Uint8Array,
  frame: S.NullOr(S.Uint8Array),
  publication: S.NullOr(S.Uint8Array),
  report: S.NullOr(S.Uint8Array),
  phase: S.Literals(['Install', 'Report', 'Reported', 'Obsolete', 'Revoked']),
  consumed: S.Boolean,
});
const Repair = S.Struct({
  id: S.String,
  epoch: S.Int,
  rejected: S.NullOr(S.String),
  phase: S.Literals(['Pending', 'Repaired', 'Obsolete', 'Revoked']),
  consumed: S.Boolean,
});
const Distribution = S.Struct({
  id: S.String,
  epoch: S.Int,
  recipient: S.String,
  revision: S.Int,
  phase: S.Literals(['Pending', 'Observed', 'Obsolete', 'Revoked']),
  consumed: S.Boolean,
});
const Candidate = S.Struct({
  id: S.String,
  parent: S.Uint8Array,
  parentCount: S.Int,
  epoch: S.Int,
  commitment: S.Uint8Array,
  record: S.Uint8Array,
  envelopes: S.Uint8Array,
  blob: S.Uint8Array,
  outcome: S.NullOr(S.Literals(['Committed', 'Conflict'])),
  binding: S.NullOr(S.Literals(['current', 'historical'])),
  consumed: S.Boolean,
});
const Installed = S.Struct({ epoch: S.Int, blob: S.Uint8Array });
const Outbox = S.Struct({ id: S.String, frame: S.Uint8Array });
const Cell = S.Struct({
  version: S.Literal(1),
  binding: BindingSchema,
  owner: S.String,
  namespace: S.String,
  id: S.String,
  phase: S.String,
  consumed: S.Int,
  value: S.Unknown,
});
const cellDecode = S.decodeUnknownSync(Cell, { onExcessProperty: 'error' });
const idOk = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 1024;
const epochOk = (n: number) => safeInt(n, 0, 0xffffffff);
const hashOk = (s: string) => /^[0-9a-f]{64}$/.test(s);
const rx = (v: unknown) =>
  decode('ReceiveJournal', () => {
    const r = S.decodeUnknownSync(Receive, { onExcessProperty: 'error' })(v);
    if (
      !idOk(r.id) ||
      !boundedBytes(r.body, 256) ||
      (r.frame !== null && !boundedBytes(r.frame, 512)) ||
      (r.publication !== null && !boundedBytes(r.publication, 8192)) ||
      (r.report !== null && !boundedBytes(r.report, 512)) ||
      (r.phase === 'Install' && r.report !== null) ||
      (['Report', 'Reported'].includes(r.phase) && r.report === null)
    )
      throw failure('ReceiveJournal', 'corrupt');
    return r;
  });
const repair = (v: unknown) =>
  decode('RepairJournal', () => {
    const r = S.decodeUnknownSync(Repair, { onExcessProperty: 'error' })(v);
    if (!idOk(r.id) || !epochOk(r.epoch) || (r.rejected !== null && !hashOk(r.rejected)))
      throw failure('RepairJournal', 'corrupt');
    return r;
  });
const distribution = (v: unknown) =>
  decode('DistributionJournal', () => {
    const r = S.decodeUnknownSync(Distribution, { onExcessProperty: 'error' })(v);
    if (!idOk(r.id) || !epochOk(r.epoch) || !hashOk(r.recipient) || !safeInt(r.revision))
      throw failure('DistributionJournal', 'corrupt');
    return r;
  });
const candidate = (v: unknown) =>
  decode('EpochCandidateStore', () => {
    const r = S.decodeUnknownSync(Candidate, { onExcessProperty: 'error' })(v);
    if (
      !hashOk(r.id) ||
      r.parent.length !== 32 ||
      !safeInt(r.parentCount, 1) ||
      !epochOk(r.epoch) ||
      r.commitment.length !== 32 ||
      !boundedBytes(r.record, 8192) ||
      !boundedBytes(r.envelopes, 2 * 1024 * 1024) ||
      !boundedBytes(r.blob, 24576, r.outcome === 'Conflict' ? 0 : 1) ||
      (r.binding !== null && r.outcome !== 'Committed') ||
      (r.consumed && r.outcome === null)
    )
      throw failure('EpochCandidateStore', 'corrupt');
    return r;
  });
const installed = (v: unknown) =>
  decode('InstalledKeyStore', () => {
    const r = S.decodeUnknownSync(Installed, { onExcessProperty: 'error' })(v);
    if (!epochOk(r.epoch) || !boundedBytes(r.blob, MAX_PROTECTED_EPOCH_BYTES))
      throw failure('InstalledKeyStore', 'corrupt');
    return r;
  });
const outbox = (v: unknown) =>
  decode('DeliveryOutbox', () => {
    const r = S.decodeUnknownSync(Outbox, { onExcessProperty: 'error' })(v);
    if (!idOk(r.id) || !boundedBytes(r.frame, 512)) throw failure('DeliveryOutbox', 'corrupt');
    return r;
  });
function cells<V extends object>(
  b: ReturnType<typeof bindingRaw>,
  namespace: string,
  parse: (v: unknown) => V
) {
  const fields = (value: V) => ({
    phase: 'phase' in value && typeof value.phase === 'string' ? value.phase : '',
    consumed: 'consumed' in value && value.consumed === true ? 1 : 0,
    id: 'id' in value ? value.id : undefined,
  });
  const owner = bindingId(b),
    key = (id: string) => [owner, namespace, id];
  const row = (v: unknown, id: string) =>
    decode(namespace, () => {
      const r = cellDecode(v),
        value = parse(r.value);
      if (
        r.id !== id ||
        r.owner !== owner ||
        r.namespace !== namespace ||
        !sameBinding(r.binding, b) ||
        r.phase !== fields(value).phase ||
        r.consumed !== fields(value).consumed ||
        (fields(value).id !== undefined && fields(value).id !== id)
      )
        throw failure(namespace, 'corrupt');
      return { ...r, value };
    });
  const get = (tx: Transaction, id: string, done: (v: V | null) => void) => {
    if (!idOk(id)) throw failure(namespace, 'corrupt');
    tx.request(tx.store('data').get(key(id)), (v) =>
      done(v === undefined ? null : structuredClone(row(v, id).value))
    );
  };
  const put = (tx: Transaction, id: string, value: V, done: (v: V) => void) => {
    const owned = parse(structuredClone(value)),
      r = {
        version: 1 as const,
        binding: b,
        owner,
        namespace,
        id,
        phase: fields(owned).phase,
        consumed: fields(owned).consumed,
        value: owned,
      };
    writeRow(
      tx,
      'data',
      key(id),
      r,
      (x) => row(x, id),
      (v) => done(structuredClone(v.value))
    );
  };
  const scan = (
    tx: Transaction,
    cursor: string | null,
    limit: number,
    predicate: (value: V) => boolean,
    done: (result: { rows: V[]; next: string | null }) => void,
    phase?: string,
    unconsumed = false
  ) => {
    if (!safeInt(limit, 1, 1024) || (cursor !== null && !idOk(cursor)))
      throw failure(namespace, 'capacity');
    const prefix: IDBValidKey[] =
      phase !== undefined
        ? [owner, namespace, phase]
        : unconsumed
          ? [owner, namespace, 0]
          : [owner, namespace];
    const source =
      phase !== undefined
        ? tx.store('data').index('phase')
        : unconsumed
          ? tx.store('data').index('unconsumed')
          : tx.store('data');
    const request = source.openCursor(
      IDBKeyRange.bound([...prefix, cursor ?? ''], [...prefix, []], cursor !== null, false)
    );
    const rows: V[] = [];
    let last: string | null = null;
    tx.request(request, (item) => {
      if (!item) {
        done({ rows, next: null });
        return;
      }
      const k = item.primaryKey;
      if (
        !Array.isArray(k) ||
        k.length !== 3 ||
        k[0] !== owner ||
        k[1] !== namespace ||
        typeof k[2] !== 'string'
      )
        throw failure(namespace, 'corrupt');
      const value = row(item.value, k[2]).value;
      if (predicate(value)) {
        if (rows.length === limit) {
          done({ rows, next: last });
          return;
        }
        rows.push(structuredClone(value));
        last = k[2];
      }
      item.continue();
    });
  };
  return { get, put, scan, key, owner };
}
/** Installed key, receive/report, distribution, immutable outbox, repair and epoch-candidate ports. All values remain untrusted; writes/readback/binding share one short transaction. */
export const indexedDbClientKeyStores = (input: IndexedDbClientKeyStoreOptions) => {
  const options = { ...input, binding: { ...input.binding } };
  return Layer.effectContext(
    Effect.gen(function* () {
      const b = yield* Effect.try({
          try: () => bindingRaw(options.binding),
          catch: () => failure('ClientKeyStores', 'corrupt'),
        }),
        identity = yield* DeviceIdentity;
      if (!identity.signer.publicKey.equals(options.binding.device))
        return yield* failure('ClientKeyStores', 'corrupt');
      const maxTasks = options.maxTasks ?? 10000;
      if (!safeInt(maxTasks, 1, 100000)) return yield* failure('ClientKeyStores', 'capacity');
      const db = yield* openClientDatabase({
        databaseName: options.databaseName,
        mode: options.mode,
        accountId: b.accountId,
        workspaceId: b.workspaceId,
      });
      if (!sameScope(b, db.bound)) return yield* failure('ClientKeyStores', 'corrupt');
      const i = cells(b, 'installed', installed),
        r = cells(b, 'receive', rx),
        p = cells(b, 'repair', repair),
        d = cells(b, 'distribution', distribution),
        o = cells(b, 'outbox', outbox),
        c = cells(b, 'candidate', candidate);
      const run = <A>(
        name: string,
        mode: IDBTransactionMode,
        work: (tx: Transaction, done: (v: A) => void) => void
      ) => db.run(name, ['data'], mode, work);
      const load = <V>(
        cell: { get: (tx: Transaction, id: string, done: (v: V | null) => void) => void },
        name: string,
        id: string
      ) => run<V | null>(name, 'readonly', (tx, done) => cell.get(tx, id, done));
      const installedPort = InstalledKeyStore.of({
        load: (epoch) =>
          attempt('InstalledKeyStore', () => {
            if (!epochOk(epoch)) throw failure('InstalledKeyStore', 'corrupt');
            return load(i, 'InstalledKeyStore', String(epoch)).pipe(
              Effect.map((v) => (v ? new Uint8Array(v.blob) : null))
            );
          }),
        insertIfAbsent: (epoch, blob) =>
          attempt('InstalledKeyStore', () => {
            if (!boundedBytes(blob, MAX_PROTECTED_EPOCH_BYTES))
              throw failure('InstalledKeyStore', 'corrupt');
            const n = installed({ epoch, blob: new Uint8Array(blob) });
            return run<void>('InstalledKeyStore', 'readwrite', (tx, done) =>
              i.get(tx, String(epoch), (v) => {
                if (v) {
                  done(undefined);
                  return;
                }
                i.put(tx, String(epoch), n, () => done(undefined));
              })
            );
          }),
        replace: (epoch, expected, next) =>
          attempt('InstalledKeyStore', () => {
            if (
              !boundedBytes(next, MAX_PROTECTED_EPOCH_BYTES) ||
              !boundedBytes(expected, MAX_PROTECTED_EPOCH_BYTES)
            )
              throw failure('InstalledKeyStore', 'corrupt');
            const n = installed({ epoch, blob: new Uint8Array(next) }),
              before = new Uint8Array(expected);
            return run<void>('InstalledKeyStore', 'readwrite', (tx, done) =>
              i.get(tx, String(epoch), (v) => {
                if (!v || !equal(v.blob, before)) {
                  done(undefined);
                  return;
                }
                i.put(tx, String(epoch), n, () => done(undefined));
              })
            );
          }),
      });
      const receivePort = ReceiveJournal.of({
        insertIfAbsent: (task) =>
          attempt('ReceiveJournal', () => {
            const n = structuredClone(
              rx({
                ...task,
                report: null,
                phase: 'Install',
                consumed: false,
              })
            );
            return run<void>('ReceiveJournal', 'readwrite', (tx, done) =>
              r.get(tx, n.id, (v) => {
                if (v) {
                  done(undefined);
                  return;
                }
                r.put(tx, n.id, n, () => done(undefined));
              })
            );
          }),
        load: (id) =>
          load(r, 'ReceiveJournal', id).pipe(
            Effect.map((v) => {
              if (!v) return null;
              const { consumed: _, ...value } = v;
              return value;
            })
          ),
        queueReport: (id, report) =>
          attempt('ReceiveJournal', () => {
            if (!boundedBytes(report, 512)) throw failure('ReceiveJournal', 'corrupt');
            const body = new Uint8Array(report);
            return run<void>('ReceiveJournal', 'readwrite', (tx, done) =>
              r.get(tx, id, (v) => {
                if (!v || v.phase !== 'Install' || v.report !== null)
                  throw failure('ReceiveJournal', 'conflict');
                const n = structuredClone(rx({ ...v, phase: 'Report', report: body }));
                r.put(tx, id, n, () => done(undefined));
              })
            );
          }),
        markReported: (id) =>
          run<void>('ReceiveJournal', 'readwrite', (tx, done) =>
            r.get(tx, id, (v) => {
              if (!v || v.phase !== 'Report') {
                done(undefined);
                return;
              }
              r.put(tx, id, rx({ ...v, phase: 'Reported', consumed: false }), () =>
                done(undefined)
              );
            })
          ),
        end: (id, phase) =>
          run<void>('ReceiveJournal', 'readwrite', (tx, done) =>
            r.get(tx, id, (v) => {
              if (!['Obsolete', 'Revoked'].includes(phase))
                throw failure('ReceiveJournal', 'corrupt');
              if (!v || !['Install', 'Report'].includes(v.phase)) {
                done(undefined);
                return;
              }
              r.put(tx, id, rx({ ...v, phase, consumed: false }), () => done(undefined));
            })
          ),
        pending: (phase, cursor, limit) =>
          run('ReceiveJournal', 'readonly', (tx, done) => {
            if (!['Install', 'Report'].includes(phase)) throw failure('ReceiveJournal', 'corrupt');
            r.scan(
              tx,
              cursor,
              limit,
              () => true,
              (v) => done({ ids: v.rows.map((x) => x.id), next: v.next }),
              phase
            );
          }),
        results: (limit) =>
          run('ReceiveJournal', 'readonly', (tx, done) =>
            r.scan(
              tx,
              null,
              limit,
              (v) => !['Install', 'Report'].includes(v.phase),
              (v) => done(v.rows.map(({ consumed: _, ...value }) => value)),
              undefined,
              true
            )
          ),
        acknowledge: (id) =>
          run<void>('ReceiveJournal', 'readwrite', (tx, done) =>
            r.get(tx, id, (v) => {
              if (!v || ['Install', 'Report'].includes(v.phase)) {
                done(undefined);
                return;
              }
              r.put(tx, id, { ...v, consumed: true }, () => done(undefined));
            })
          ),
      });
      const repairPort = RepairJournal.of({
        insertIfAbsent: (task) =>
          attempt('RepairJournal', () => {
            const n = repair({ ...task, phase: 'Pending', consumed: false });
            return run<void>('RepairJournal', 'readwrite', (tx, done) =>
              p.get(tx, n.id, (v) => {
                if (v) {
                  done(undefined);
                  return;
                }
                p.put(tx, n.id, n, () => done(undefined));
              })
            );
          }),
        load: (id) =>
          load(p, 'RepairJournal', id).pipe(
            Effect.map((v) => {
              if (!v) return null;
              const { consumed: _, ...value } = v;
              return value;
            })
          ),
        finish: (id, phase) =>
          run<void>('RepairJournal', 'readwrite', (tx, done) =>
            p.get(tx, id, (v) => {
              if (
                !v ||
                v.phase !== 'Pending' ||
                !['Repaired', 'Obsolete', 'Revoked'].includes(phase)
              )
                throw failure('RepairJournal', 'conflict');
              p.put(tx, id, repair({ ...v, phase }), () => done(undefined));
            })
          ),
        pending: (cursor, limit) =>
          run('RepairJournal', 'readonly', (tx, done) =>
            p.scan(
              tx,
              cursor,
              limit,
              () => true,
              (v) =>
                done({ tasks: v.rows.map(({ consumed: _, ...value }) => value), next: v.next }),
              'Pending'
            )
          ),
        results: (cursor, limit) =>
          run('RepairJournal', 'readonly', (tx, done) =>
            p.scan(
              tx,
              cursor,
              limit,
              (v) => v.phase !== 'Pending',
              (v) =>
                done({ tasks: v.rows.map(({ consumed: _, ...value }) => value), next: v.next }),
              undefined,
              true
            )
          ),
        acknowledge: (id) =>
          run<void>('RepairJournal', 'readwrite', (tx, done) =>
            p.get(tx, id, (v) => {
              if (!v || v.phase === 'Pending') {
                done(undefined);
                return;
              }
              p.put(tx, id, { ...v, consumed: true }, () => done(undefined));
            })
          ),
      });
      const distributionPort = DistributionJournal.of({
        insertIfAbsent: (task) =>
          attempt('DistributionJournal', () => {
            const n = distribution({ ...task, phase: 'Pending', consumed: false });
            return run<boolean>('DistributionJournal', 'readwrite', (tx, done) =>
              d.get(tx, n.id, (v) => {
                if (v) {
                  done(false);
                  return;
                }
                tx.request(
                  tx
                    .store('data')
                    .index('unconsumed')
                    .count(
                      IDBKeyRange.bound(
                        [d.owner, 'distribution', 0],
                        [d.owner, 'distribution', 0, []]
                      )
                    ),
                  (count) => {
                    if (count >= maxTasks) throw failure('DistributionJournal', 'capacity');
                    tx.request(
                      tx
                        .store('data')
                        .index('distribution-slot')
                        .get([d.owner, 'distribution', n.epoch, n.recipient, n.revision]),
                      (slot) => {
                        if (slot !== undefined) throw failure('DistributionJournal', 'conflict');
                        d.put(tx, n.id, n, () => done(true));
                      }
                    );
                  }
                );
              })
            );
          }),
        load: (id) => load(d, 'DistributionJournal', id),
        finish: (id, phase) =>
          run<void>('DistributionJournal', 'readwrite', (tx, done) =>
            d.get(tx, id, (v) => {
              if (
                !v ||
                v.phase !== 'Pending' ||
                !['Observed', 'Obsolete', 'Revoked'].includes(phase)
              )
                throw failure('DistributionJournal', 'conflict');
              d.put(tx, id, distribution({ ...v, phase }), () => done(undefined));
            })
          ),
        pending: (cursor, limit) =>
          run('DistributionJournal', 'readonly', (tx, done) =>
            d.scan(
              tx,
              cursor,
              limit,
              () => true,
              (v) => done({ ids: v.rows.map((x) => x.id), next: v.next }),
              'Pending'
            )
          ),
        results: (cursor, limit) =>
          run('DistributionJournal', 'readonly', (tx, done) =>
            d.scan(
              tx,
              cursor,
              limit,
              (v) => v.phase !== 'Pending',
              (v) => done({ tasks: v.rows, next: v.next }),
              undefined,
              true
            )
          ),
        acknowledge: (id) =>
          run<void>('DistributionJournal', 'readwrite', (tx, done) =>
            d.get(tx, id, (v) => {
              if (!v || v.phase === 'Pending') throw failure('DistributionJournal', 'conflict');
              d.put(tx, id, { ...v, consumed: true }, () => done(undefined));
            })
          ),
      });
      const outboxPort = DeliveryOutbox.of({
        load: (id) =>
          load(o, 'DeliveryOutbox', id).pipe(
            Effect.map((v) => (v ? new Uint8Array(v.frame) : null))
          ),
        saveOriginal: (id, frame) =>
          attempt('DeliveryOutbox', () => {
            if (!boundedBytes(frame, 512)) throw failure('DeliveryOutbox', 'corrupt');
            const n = outbox({ id, frame: new Uint8Array(frame) });
            return run<Uint8Array>('DeliveryOutbox', 'readwrite', (tx, done) =>
              o.get(tx, id, (v) => {
                if (v) {
                  done(new Uint8Array(v.frame));
                  return;
                }
                o.put(tx, id, n, (row) => done(new Uint8Array(row.frame)));
              })
            );
          }),
      });
      const active = (tx: Transaction, done: (v: EpochCandidateRow | null) => void) =>
        c.scan(
          tx,
          null,
          2,
          () => true,
          (v) => {
            if (v.rows.length > 1) throw failure('EpochCandidateStore', 'corrupt');
            done(v.rows[0] ?? null);
          },
          undefined,
          true
        );
      const candidatePort = EpochCandidateStore.of({
        active: () => run('EpochCandidateStore', 'readonly', active),
        load: (id) => load(c, 'EpochCandidateStore', id),
        insert: (row) =>
          attempt('EpochCandidateStore', () => {
            const n = structuredClone(candidate(row));
            if (n.consumed) throw failure('EpochCandidateStore', 'conflict');
            return run<void>('EpochCandidateStore', 'readwrite', (tx, done) =>
              active(tx, (v) => {
                if (v) throw failure('EpochCandidateStore', 'conflict');
                c.get(tx, n.id, (prior) => {
                  if (prior) throw failure('EpochCandidateStore', 'conflict');
                  c.put(tx, n.id, n, () => done(undefined));
                });
              })
            );
          }),
        replace: (expected, next) =>
          attempt('EpochCandidateStore', () => {
            const old = structuredClone(candidate(expected)),
              n = structuredClone(candidate(next));
            if (
              !equal(
                {
                  ...n,
                  outcome: old.outcome,
                  binding: old.binding,
                  blob: old.blob,
                  consumed: old.consumed,
                },
                old
              )
            )
              throw failure('EpochCandidateStore', 'corrupt');
            return run<void>('EpochCandidateStore', 'readwrite', (tx, done) =>
              c.get(tx, old.id, (v) => {
                if (!v || !equal(v, old)) throw failure('EpochCandidateStore', 'conflict');
                const commit = () => c.put(tx, n.id, n, () => done(undefined));
                if (n.consumed) commit();
                else
                  active(tx, (current) => {
                    if (current && current.id !== n.id)
                      throw failure('EpochCandidateStore', 'conflict');
                    commit();
                  });
              })
            );
          }),
      });
      return Context.make(InstalledKeyStore, installedPort).pipe(
        Context.add(ReceiveJournal, receivePort),
        Context.add(RepairJournal, repairPort),
        Context.add(DistributionJournal, distributionPort),
        Context.add(DeliveryOutbox, outboxPort),
        Context.add(EpochCandidateStore, candidatePort)
      );
    })
  );
};
