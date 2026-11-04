import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { Effect, Result } from 'effect';
import { ContentError } from '@lody/e2ee-core/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSqliteKeyDistribution, type DistributionMailboxRemote } from './harness';
import { makeSqliteProtectedEpochKeys } from './harness';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeSqliteRecipientMailbox } from './harness';
import { envelopeFixture, recipientPair } from './fixture';
import { synthetic } from './protection-fixture';

const ok = Result.getOrThrow,
  hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const dirs: string[] = [];
const directory = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2ee-distribution-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const rows = (file: string) => {
  const db = new Database(file);
  try {
    return db.prepare('SELECT * FROM distribution_tasks ORDER BY id').all() as {
      id: string;
      phase: string;
      revision: number;
      consumed: number;
    }[];
  } finally {
    db.close();
  }
};
const saved = (file: string) => {
  const db = new Database(file);
  try {
    return (
      db.prepare('SELECT slot,frame FROM epoch_delivery ORDER BY slot').all() as {
        slot: string;
        frame: Uint8Array;
      }[]
    ).map((r) => ({ slot: r.slot, frame: new Uint8Array(r.frame) }));
  } finally {
    db.close();
  }
};
async function setup(kind: 0 | 1 | 2 = 0) {
  const f = envelopeFixture(kind),
    dir = directory(),
    pair = await recipientPair(),
    protect = synthetic().protector;
  const file = (name: string) => path.join(dir, `${name}.sqlite`);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const keys = yield* makeSqliteProtectedEpochKeys({
          path: file('keys'),
          mode: 'create',
          genesis: f.context.genesis,
          recipient: f.owner.publicKey,
          ledger: f.ledger,
          protector: protect,
        });
        yield* keys.saveAndReload(0, f.secret);
      })
    )
  );
  const config = {
    path: file('receive'),
    mode: 'create' as 'create' | 'open',
    genesis: f.context.genesis,
    signer: f.owner.signer,
    pair,
    ledger: f.ledger,
    keyStore: { path: file('keys'), mode: 'open' as const, protector: protect },
    repairStore: { path: file('repair'), mode: 'create' as 'create' | 'open' },
    sendStore: { path: file('send'), mode: 'create' as 'create' | 'open' },
    outboxStore: { path: file('outbox'), mode: 'create' as 'create' | 'open' },
    currentPublication: () => Effect.succeed(f.genesisRecord),
  };
  const reopen = () => ({
    ...config,
    mode: 'open' as const,
    repairStore: { ...config.repairStore, mode: 'open' as const },
    sendStore: { ...config.sendStore, mode: 'open' as const },
    outboxStore: { ...config.outboxStore, mode: 'open' as const },
  });
  return { f, dir, file, config, reopen, pair, protect };
}

describe('verified targets and durable finite distribution', () => {
  it('registered Recovery receives but cannot schedule or send epoch keys', async () => {
    const { f, file, config, protect } = await setup(2);
    expect(f.view().inspectState().devices.get(hex(f.phone.raw))!.kind).toBe('recovery');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const keys = yield* makeSqliteProtectedEpochKeys({
            path: file('recovery-keys'),
            mode: 'create',
            genesis: f.context.genesis,
            recipient: f.phone.publicKey,
            ledger: f.ledger,
            protector: protect,
          });
          yield* keys.saveAndReload(0, f.secret);
          const host = yield* makeSqliteKeyMailbox({
              path: file('host'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            remote = ok(host.bind(f.phone.publicKey));
          const client = yield* makeSqliteKeyDistribution({
            ...config,
            signer: f.phone.signer,
            keyStore: { ...config.keyStore, path: file('recovery-keys') },
            currentPublication: () => Effect.succeed(null),
            remote,
          });
          expect(yield* client.reconcileCurrentEpoch()).toEqual({
            scheduled: 0,
            blocked: [],
            next: null,
          });
          expect(yield* client.resumePendingDeliveries()).toEqual({
            processed: 0,
            blocked: [],
            next: null,
          });
          expect(rows(file('send'))).toEqual([]);
          expect(saved(file('outbox'))).toEqual([]);
        })
      )
    );
  });
  it.each([0, 1, 2] as const)(
    'discovers registered kind%s without a server target list, sends actual HPKE and reconstructs publisher reports',
    async (kind) => {
      const { f, file, config, pair, protect } = await setup(kind);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeSqliteKeyMailbox({
              path: file('host'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            });
            const owner = ok(host.bind(f.owner.publicKey)),
              phone = ok(host.bind(f.phone.publicKey));
            const client = yield* makeSqliteKeyDistribution({
              ...config,
              remote: {
                ...owner,
                list: () => Effect.succeed({ items: [], next: null }),
              } as DistributionMailboxRemote,
            });
            expect(yield* client.reconcileCurrentEpoch()).toEqual({
              scheduled: 1,
              blocked: [],
              next: null,
            });
            expect(rows(file('send'))[0]!.phase).toBe('Pending');
            expect(yield* client.resumePendingDeliveries()).toMatchObject({
              processed: 1,
              blocked: [],
            });
            expect(saved(file('outbox'))).toHaveLength(1);
            expect((yield* client.deliveryResults()).items[0]!.outcome).toBe('Observed');
            // Original verified genesis + actual protected-key readback creates our report.
            yield* client.flushReports();
            expect(
              (yield* owner.status({
                genesis: hex(f.context.genesis.toBytes()),
                epoch: 0,
                recipient: hex(f.owner.raw),
              })).status
            ).toBe('InstallationReported');
            const receiver = yield* makeSqliteRecipientMailbox({
              path: file('phone-receive'),
              mode: 'create',
              genesis: f.context.genesis,
              signer: f.phone.signer,
              pair,
              ledger: f.ledger,
              remote: phone,
              keyStore: { path: file('phone-keys'), mode: 'create', protector: protect },
              repairStore: { path: file('phone-repair'), mode: 'create' },
            });
            expect(yield* receiver.fetchAndInstall()).toEqual({ processed: 1, next: null });
            yield* receiver.flushReports();
            expect(
              (yield* phone.status({
                genesis: hex(f.context.genesis.toBytes()),
                epoch: 0,
                recipient: hex(f.phone.raw),
              })).status
            ).toBe('InstallationReported');
            const original = saved(file('outbox'));
            expect(yield* client.reconcileCurrentEpoch()).toEqual({
              scheduled: 0,
              blocked: [],
              next: null,
            });
            expect(saved(file('outbox'))).toEqual(original);
          })
        )
      );
    }
  );
  it('reopens exact pending ciphertext after lost readback, without signing again, and retains acknowledged history through repair', async () => {
    const { f, file, config, reopen } = await setup();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: file('host'),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const owner = ok(host.bind(f.owner.publicKey));
          const client = yield* makeSqliteKeyDistribution({
            ...config,
            remote: { ...owner, read: () => Effect.succeed(null) },
          });
          yield* client.reconcileCurrentEpoch();
          expect((yield* client.resumePendingDeliveries()).blocked).toHaveLength(1);
          expect(rows(file('send'))[0]!.phase).toBe('Pending');
        })
      )
    );
    const original = saved(file('outbox'));
    const noSign = {
      ...f.owner.signer,
      sign: () => Effect.fail(new ContentError({ code: 'bad-signature' })),
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: file('host'),
            mode: 'open',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const owner = ok(host.bind(f.owner.publicKey)),
            phone = ok(host.bind(f.phone.publicKey));
          const client = yield* makeSqliteKeyDistribution({
            ...reopen(),
            signer: noSign,
            remote: owner,
          });
          expect((yield* client.resumePendingDeliveries()).blocked).toEqual([]);
          const first = (yield* client.deliveryResults()).items[0]!;
          yield* client.acknowledgeDelivery(first.id);
          expect((yield* client.deliveryResults()).items).toEqual([]);
          yield* phone.repair(
            { genesis: hex(f.context.genesis.toBytes()), epoch: 0, recipient: hex(f.phone.raw) },
            'repair-one'
          );
          // Hint may trigger another attempt, but never replaces the old result or ciphertext.
          const clientWithoutPublication = yield* makeSqliteKeyDistribution({
            ...reopen(),
            signer: noSign,
            remote: owner,
            currentPublication: () => Effect.succeed(null),
          });
          expect((yield* clientWithoutPublication.reconcileCurrentEpoch()).scheduled).toBe(1);
          expect(rows(file('send')).find((r) => r.id === first.id)).toMatchObject({
            phase: 'Observed',
            revision: 0,
            consumed: 1,
          });
          expect((yield* clientWithoutPublication.resumePendingDeliveries()).blocked).toEqual([]);
          expect((yield* clientWithoutPublication.deliveryResults()).items[0]!.revision).toBe(1);
          expect(saved(file('outbox'))).toEqual(original);
        })
      )
    );
  });
  it('another real OS process reopens the original protected key/outbox/task/report stores without a signer', async () => {
    const { f, dir, file, config } = await setup();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: file('host'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: f.ledger,
            }),
            owner = ok(host.bind(f.owner.publicKey));
          const client = yield* makeSqliteKeyDistribution({
            ...config,
            remote: { ...owner, read: () => Effect.succeed(null) },
          });
          yield* client.reconcileCurrentEpoch();
          expect((yield* client.resumePendingDeliveries()).blocked).toHaveLength(1);
        })
      )
    );
    const original = saved(file('outbox'));
    const child = await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      path.resolve('test/keys/distribution-reopen.mts'),
      dir,
    ]);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({
      processed: 1,
      blocked: [],
      outcome: 'Observed',
      publication: 'InstallationReported',
    });
    expect(saved(file('outbox'))).toEqual(original);
    expect(rows(file('send'))[0]!.phase).toBe('Observed');
  });
  it('does not terminalize or grant permission from malicious remote hints, and retains a known genuine revocation', async () => {
    const { f, file, config } = await setup();
    const initial = f.view();
    let view = initial;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
              path: file('host'),
              mode: 'create',
              genesis: f.context.genesis,
              ledger: () => Effect.succeed(initial),
            }),
            owner = ok(host.bind(f.owner.publicKey));
          const client = yield* makeSqliteKeyDistribution({
            ...config,
            ledger: () => Effect.succeed(view),
            remote: {
              ...owner,
              status: (target) => Effect.succeed({ ...target, revision: 0, status: 'Obsolete' }),
              put: () => Effect.fail(new Error('offline')),
              read: () => Effect.succeed(null),
            },
          });
          yield* client.reconcileCurrentEpoch();
          expect((yield* client.resumePendingDeliveries()).blocked).toHaveLength(1);
          expect(rows(file('send'))[0]!.phase).toBe('Pending');
          f.append([5, f.phone.raw]);
          view = f.view();
          expect((yield* client.resumePendingDeliveries()).blocked).toEqual([]);
          expect((yield* client.deliveryResults()).items[0]!.outcome).toBe('Revoked');
          const before = saved(file('outbox'));
          view = initial;
          expect(Result.isFailure(yield* Effect.result(client.reconcileCurrentEpoch()))).toBe(true);
          expect(saved(file('outbox'))).toEqual(before);
        })
      )
    );
  });
  it.each(['IGNORE', 'rewrite'] as const)(
    'retains pending on actual %s terminal-write fault; same original succeeds after removing it',
    async (fault) => {
      const { f, file, config } = await setup();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeSqliteKeyMailbox({
                path: file('host'),
                mode: 'create',
                genesis: f.context.genesis,
                ledger: f.ledger,
              }),
              owner = ok(host.bind(f.owner.publicKey));
            const client = yield* makeSqliteKeyDistribution({ ...config, remote: owner });
            yield* client.reconcileCurrentEpoch();
            const db = new Database(file('send'));
            try {
              db.exec(
                fault === 'IGNORE'
                  ? 'CREATE TRIGGER broken BEFORE UPDATE ON distribution_tasks BEGIN SELECT RAISE(IGNORE); END;'
                  : "CREATE TRIGGER broken AFTER UPDATE ON distribution_tasks BEGIN UPDATE distribution_tasks SET phase='Pending' WHERE id=NEW.id; END;"
              );
            } finally {
              db.close();
            }
            const failed = yield* Effect.result(client.resumePendingDeliveries());
            expect(Result.isFailure(failed)).toBe(true);
            if (Result.isFailure(failed))
              expect(failed.failure).toMatchObject({ reason: 'corrupt' });
            expect(rows(file('send'))[0]!.phase).toBe('Pending');
            const original = saved(file('outbox'));
            const fixed = new Database(file('send'));
            try {
              fixed.exec('DROP TRIGGER broken');
            } finally {
              fixed.close();
            }
            expect((yield* client.resumePendingDeliveries()).blocked).toEqual([]);
            expect(saved(file('outbox'))).toEqual(original);
          })
        )
      );
    }
  );
});

it('bounds unacknowledged tasks while acknowledgements free capacity without deleting originals', async () => {
  const { f, file, config, reopen } = await setup(0);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* makeSqliteKeyMailbox({
          path: file('host'),
          mode: 'create',
          genesis: f.context.genesis,
          ledger: f.ledger,
        });
        const owner = ok(host.bind(f.owner.publicKey)),
          phone = ok(host.bind(f.phone.publicKey));
        const client = yield* makeSqliteKeyDistribution({
          ...config,
          remote: owner,
          sendStore: { ...config.sendStore, maxTasks: 1 },
        });
        expect((yield* client.reconcileCurrentEpoch()).scheduled).toBe(1);
        expect((yield* client.resumePendingDeliveries()).processed).toBe(1);
        let result = (yield* client.deliveryResults()).items[0]!;
        const ciphertext = saved(file('outbox'));
        for (let revision = 1; revision <= 3; revision++) {
          yield* phone.repair(
            { genesis: hex(f.context.genesis.toBytes()), epoch: 0, recipient: hex(f.phone.raw) },
            `bounded-repair-${revision}`
          );
          const before = rows(file('send'));
          expect(yield* client.reconcileCurrentEpoch()).toMatchObject({
            scheduled: 0,
            blocked: [hex(f.phone.raw)],
          });
          expect(rows(file('send'))).toEqual(before);
          yield* client.acknowledgeDelivery(result.id);
          const originals = rows(file('send'));
          expect((yield* client.deliveryResults()).items).toEqual([]);
          expect(yield* client.reconcileCurrentEpoch()).toMatchObject({
            scheduled: 1,
            blocked: [],
          });
          expect((yield* client.resumePendingDeliveries()).blocked).toEqual([]);
          result = (yield* client.deliveryResults()).items[0]!;
          expect(result.revision).toBe(revision);
          const retained = rows(file('send'));
          expect(retained).toHaveLength(revision + 1);
          expect(retained.filter((row) => row.id !== result.id)).toEqual(originals);
          expect(saved(file('outbox'))).toEqual(ciphertext);
        }
      })
    )
  );
  const retained = rows(file('send')),
    ciphertext = saved(file('outbox'));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* makeSqliteKeyMailbox({
          path: file('host'),
          mode: 'open',
          genesis: f.context.genesis,
          ledger: f.ledger,
        });
        const owner = ok(host.bind(f.owner.publicKey)),
          phone = ok(host.bind(f.phone.publicKey));
        const client = yield* makeSqliteKeyDistribution({
          ...reopen(),
          remote: owner,
          sendStore: { path: file('send'), mode: 'open', maxTasks: 1 },
        });
        const previous = (yield* client.deliveryResults()).items[0]!;
        expect(previous.revision).toBe(3);
        yield* client.acknowledgeDelivery(previous.id);
        yield* phone.repair(
          { genesis: hex(f.context.genesis.toBytes()), epoch: 0, recipient: hex(f.phone.raw) },
          'bounded-repair-after-reopen'
        );
        expect((yield* client.reconcileCurrentEpoch()).scheduled).toBe(1);
        expect((yield* client.resumePendingDeliveries()).blocked).toEqual([]);
        const current = (yield* client.deliveryResults()).items[0]!;
        expect(current.revision).toBe(4);
        expect(rows(file('send')).filter((row) => row.id !== current.id)).toEqual(
          retained.map((row) => (row.id === previous.id ? { ...row, consumed: 1 } : row))
        );
        expect(saved(file('outbox'))).toEqual(ciphertext);
      })
    )
  );
});
