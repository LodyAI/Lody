import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { Clock, Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import * as P from '@lody/e2ee-core/protocol';
import { disposeEpochKey } from '@lody/e2ee-core/internal';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import { makeMachineSharingHost, makeLazyMachineSharingHost, type SharingRemote } from '../src';
import type { E2eeMachineSharingVersion, E2eeMachineSharingHeadState } from '@lody/platform';

const hex = (v: { toBytes(): Uint8Array }) => Buffer.from(v.toBytes()).toString('hex');
const ok = Result.getOrThrow;
const setup = Effect.fnUntraced(function* (directory: string) {
  const f = envelopeFixture(1);
  yield* Effect.addFinalizer(() => Effect.sync(() => disposeEpochKey(f.secret)));
  let view = f.view();
  const bob = f.ed(20);
  const request = yield* P.prepareJoinRequest({
    genesis: view.genesis,
    requestId: ok(P.Bytes.requestId(new Uint8Array(16).fill(20))),
    userId: ok(P.Bytes.userId(new Uint8Array(32).fill(20))),
    encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(new Uint8Array(32).fill(120))),
    expiresAt: null,
    signer: bob.signer,
  });
  const memberRecord = yield* P.signLedgerRecord(
    ok(
      P.prepareLedgerCommand(view, f.owner.publicKey, {
        _tag: 'AdmitMember',
        membershipId: ok(P.Bytes.membershipId(new Uint8Array(16).fill(20))),
        request,
      })
    ),
    f.owner.signer
  );
  view = ok(
    P.extendLedger(view, [memberRecord], {
      head: P.hashRecordBytes(memberRecord),
      length: view.length + 1,
    })
  );
  let originals = [...f.records(), memberRecord];
  let head: E2eeMachineSharingHeadState | null = null;
  const versions = new Map<number, E2eeMachineSharingVersion>();
  const requests = new Map<string, E2eeMachineSharingVersion>();
  const io = {
    proofUnavailable: false,
    offline: false,
    lost: false,
    wall: 100,
    mono: 100,
    reads: 0,
    commits: 0,
  };
  const network = <A>(work: () => A) =>
    Effect.try({
      try: () => {
        if (io.offline) throw new Error('offline');
        return work();
      },
      catch: (e) => e,
    });
  const remote: SharingRemote = {
    readHead: () =>
      network(() => {
        io.reads++;
        return head;
      }),
    readVersion: (input) => network(() => versions.get(input.revision) ?? null),
    readRequest: (input) => network(() => requests.get(input.requestId) ?? null),
    commit: (input) =>
      network(() => {
        io.commits++;
        if (
          input.expectedHead?.revision !== head?.revision ||
          input.expectedHead?.digest !== head?.digest ||
          input.expectedHead?.status !== head?.status
        )
          return { status: 'conflict' as const, head };
        const { credential: _, expectedHead: __, ...original } = input;
        const version = {
          ...original,
          digest: ok(P.machineSharingDigest(Buffer.from(input.frameHex, 'hex'))),
        };
        versions.set(input.revision, version);
        requests.set(input.requestId, version);
        const { revision, digest } = version;
        head = {
          workspaceId: input.workspaceId,
          genesisHash: input.genesisHash,
          machineId: input.machineId,
          ownerMembershipId: input.ownerMembershipId,
          generation: input.generation,
          status: 'active',
          revision,
          digest,
        };
        if (io.lost) throw new Error('lost acknowledgement');
        return { status: 'committed' as const, version };
      }),
  };
  const base = yield* Clock.Clock;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => io.wall,
    currentTimeNanosUnsafe: () => BigInt(io.wall) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(io.wall) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(io.mono) * 1_000_000n,
    sleep: base.sleep.bind(base),
    currentTimeMillis: Effect.sync(() => io.wall),
    monotonicTimeNanos: Effect.sync(() => BigInt(io.mono) * 1_000_000n),
  };
  const make = (name: string, signer = f.owner.signer) =>
    makeMachineSharingHost({
      filename: join(directory, `${name}.sqlite`),
      workspaceId: 'workspace',
      genesisHash: hex(view.genesis),
      signer,
      ledger: () => Effect.sync(() => view),
      refreshLedger: () => network(() => undefined),
      admissionHistory: () =>
        Effect.succeed(
          io.proofUnavailable
            ? []
            : originals.map((record, index) => ({ record, length: index + 1 }))
        ),
      readEpochKey: () => Effect.succeed(f.secret),
      credential: 'synthetic-secret',
    }).pipe(Effect.provideService(Clock.Clock, clock));
  const run = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(Effect.provideService(Clock.Clock, clock));
  const owner = yield* make('owner');
  const machine = yield* make('machine', f.phone.signer);
  return {
    f,
    bob,
    owner,
    machine,
    remote,
    io,
    make,
    run,
    versions,
    setHead: (value: E2eeMachineSharingHeadState | null) => {
      head = value;
    },
    newResource: () => {
      head = null;
      versions.clear();
      requests.clear();
    },
    append: Effect.fnUntraced(function* (command: Parameters<typeof P.prepareLedgerCommand>[2]) {
      const record = yield* P.signLedgerRecord(
        ok(P.prepareLedgerCommand(view, f.owner.publicKey, command)),
        f.owner.signer
      );
      view = ok(
        P.extendLedger(view, [record], { head: P.hashRecordBytes(record), length: view.length + 1 })
      );
      originals.push(record);
    }),
    head: () => head,
    view: () => view,
    setView: (v: P.LedgerView) => {
      view = v;
    },
  };
});
async function test(
  body: (
    f: Effect.Success<ReturnType<typeof setup>>
  ) => Effect.Effect<unknown, unknown, Scope.Scope>
) {
  const directory = await mkdtemp(join(tmpdir(), 'sharing-host-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* setup(directory);
          return yield* body(f);
        })
      )
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const change = { kind: 'project', localProjectId: 'project-a', sharedWithTeam: true } as const;
const rid = (n: number) => n.toString(16).padStart(32, '0');
describe('native machine-sharing control and execution', () => {
  it('reconciles a lost commit after restart using exact originals and no second publication', () =>
    test((f) =>
      Effect.gen(function* () {
        f.io.lost = true;
        const scope = yield* Scope.make();
        const owner = yield* f.make('writer').pipe(Scope.provide(scope));
        expect(
          yield* f.run(
            owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
          )
        ).toEqual({
          status: 'pending',
          requestId: rid(1),
        });
        const original = f.versions.get(1)?.frameHex;
        yield* Scope.close(scope, Exit.void);
        const reopened = yield* f.make('writer');
        f.io.offline = true;
        expect(yield* f.run(reopened.read('fixture-machine', f.remote))).toMatchObject({
          unavailable: true,
          pendingRequest: { requestId: rid(1), change },
        });
        f.io.offline = false;
        expect(
          yield* f.run(
            reopened.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
          )
        ).toEqual({
          status: 'saved',
          requestId: rid(1),
        });
        expect(f.versions.get(1)?.frameHex).toBe(original);
        expect(f.io.commits).toBe(1);
        expect(
          Result.isFailure(
            yield* Effect.result(
              reopened.write(
                'fixture-machine',
                hex(f.f.phone.publicKey),
                rid(1),
                { kind: 'machine', sharedWithTeam: false },
                f.remote
              )
            )
          )
        ).toBe(true);
      })
    ));
  it('requires both switches, honors known withdrawal, and rejects rollback after reopen', () =>
    test((f) =>
      Effect.gen(function* () {
        const lifetime = yield* Scope.make();
        const machine = yield* f
          .make('retained-machine', f.f.phone.signer)
          .pipe(Scope.provide(lifetime));
        yield* f.run(
          f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
        );
        const allow = () =>
          f.run(machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote));
        expect(yield* allow()).toMatchObject({ allowed: true, reason: 'team' });
        expect(
          yield* f.run(
            machine.authorize('fixture-machine', hex(f.bob.publicKey), 'private', f.remote)
          )
        ).toMatchObject({ allowed: false, reason: 'project-not-shared' });
        const old = f.head();
        yield* f.run(
          f.owner.write(
            'fixture-machine',
            hex(f.f.phone.publicKey),
            rid(2),
            { kind: 'machine', sharedWithTeam: false },
            f.remote
          )
        );
        yield* f.run(machine.read('fixture-machine', f.remote));
        expect(yield* allow()).toMatchObject({ allowed: false, reason: 'machine-not-shared' });
        f.setHead(old);
        machine.invalidate();
        expect(Result.isFailure(yield* Effect.result(allow()))).toBe(true);
        yield* Scope.close(lifetime, Exit.void);
        const reopened = yield* f.make('retained-machine', f.f.phone.signer);
        // The same durable resource remembers revision two after its owner has closed.
        expect(
          Result.isFailure(yield* Effect.result(f.run(reopened.read('fixture-machine', f.remote))))
        ).toBe(true);
      })
    ));
  it('uses strict read-start wall and monotonic freshness, and restart never renews it', () =>
    test((f) =>
      Effect.gen(function* () {
        yield* f.run(
          f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
        );
        const allow = () =>
          f.run(
            f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
          );
        expect(yield* allow()).toMatchObject({ allowed: true });
        f.io.offline = true;
        f.io.wall += 899_999;
        f.io.mono += 899_999;
        expect(yield* allow()).toMatchObject({ allowed: true });
        f.io.wall++;
        f.io.mono++;
        expect(Result.isFailure(yield* Effect.result(allow()))).toBe(true);
      })
    ));
});

it('retains private defaults for a missing policy and refuses a machine writer', () =>
  test((f) =>
    Effect.gen(function* () {
      expect(yield* f.run(f.owner.read('fixture-machine', f.remote))).toMatchObject({
        canManage: true,
        sharedWithTeam: false,
        head: null,
        signer: null,
        needsResign: false,
      });
      expect(yield* f.run(f.machine.read('fixture-machine', f.remote))).toMatchObject({
        canManage: false,
        sharedWithTeam: false,
      });
      const viewer = yield* f.make('viewer', f.bob.signer);
      expect(yield* f.run(viewer.read('fixture-machine', f.remote))).toMatchObject({
        canManage: false,
        sharedWithTeam: false,
        deniedReason: 'e2ee_machine_not_shared',
      });
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), undefined, f.remote)
        )
      ).toMatchObject({ allowed: false });
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.f.owner.publicKey), undefined, f.remote)
        )
      ).toMatchObject({ allowed: true, reason: 'owner' });
      expect(
        Result.isFailure(
          yield* Effect.result(
            f.machine.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
          )
        )
      ).toBe(true);
      expect(f.io.commits).toBe(0);
    })
  ));

it('does not rebase a confirmed CAS conflict or replace its original on retry', () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.run(
        f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
      );
      const race: SharingRemote = {
        ...f.remote,
        commit: () => Effect.succeed({ status: 'conflict', head: f.head() }),
      };
      expect(
        yield* f.run(
          f.owner.write(
            'fixture-machine',
            hex(f.f.phone.publicKey),
            rid(2),
            { kind: 'machine', sharedWithTeam: false },
            race
          )
        )
      ).toEqual({ status: 'conflict', requestId: rid(2) });
      expect(
        yield* f.run(
          f.owner.write(
            'fixture-machine',
            hex(f.f.phone.publicKey),
            rid(2),
            { kind: 'machine', sharedWithTeam: false },
            f.remote
          )
        )
      ).toEqual({ status: 'conflict', requestId: rid(2) });
      expect(f.io.commits).toBe(1);
      expect((yield* f.run(f.owner.read('fixture-machine', f.remote))).projects).toEqual([
        'project-a',
      ]);
    })
  ));

it('rejects stale policy signatures immediately after a known issuer revocation', () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.run(
        f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
      );
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )
      ).toMatchObject({ allowed: true });
      // Admit another personal device before the issuer revokes itself through that device.
      const second = f.f.ed(21);
      let view = f.view();
      const admission = yield* P.prepareDeviceAdmission({
        genesis: view.genesis,
        membershipId: view.inspectState().owner,
        encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(new Uint8Array(32).fill(121))),
        kind: 'personal',
        signer: second.signer,
      });
      const add = yield* P.signLedgerRecord(
        ok(P.prepareLedgerCommand(view, f.f.owner.publicKey, admission)),
        f.f.owner.signer
      );
      view = ok(
        P.extendLedger(view, [add], { length: view.length + 1, head: P.hashRecordBytes(add) })
      );
      const revoke = yield* P.signLedgerRecord(
        ok(
          P.prepareLedgerCommand(view, second.publicKey, {
            _tag: 'RevokeDevice',
            target: f.f.owner.publicKey,
          })
        ),
        second.signer
      );
      view = ok(
        P.extendLedger(view, [revoke], { length: view.length + 1, head: P.hashRecordBytes(revoke) })
      );
      f.setView(view);
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )
      ).toMatchObject({ allowed: false, reason: 'policy-signer-ineligible' });
      const secondHost = yield* f.make('second-personal', second.signer);
      expect(yield* f.run(secondHost.read('fixture-machine', f.remote))).toMatchObject({
        canManage: true,
        signer: hex(f.f.owner.publicKey),
        needsResign: true,
        sharedWithTeam: true,
        projects: ['project-a'],
        head: { revision: 1 },
      });
      expect(yield* f.run(f.machine.read('fixture-machine', f.remote))).toMatchObject({
        canManage: false,
        needsResign: true,
      });
      const denied = yield* Effect.result(
        f.run(f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote))
      );
      expect(Result.isFailure(denied) || !denied.success.allowed).toBe(true);
      expect(
        yield* f.run(
          secondHost.write(
            'fixture-machine',
            hex(f.f.phone.publicKey),
            rid(2),
            { kind: 'machine', sharedWithTeam: true },
            f.remote
          )
        )
      ).toMatchObject({ status: 'saved' });
      expect(yield* f.run(secondHost.read('fixture-machine', f.remote))).toMatchObject({
        signer: hex(second.publicKey),
        needsResign: false,
        head: { revision: 2 },
      });
      f.machine.invalidate();
      expect((yield* f.run(f.machine.read('fixture-machine', f.remote))).projects).toEqual([
        'project-a',
      ]);
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )
      ).toMatchObject({ allowed: true });
      const cold = yield* f.make('cold-after-revoke', f.f.phone.signer);
      expect(
        yield* f.run(cold.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote))
      ).toMatchObject({ allowed: true });
    })
  ));

it('persists removal barriers and cannot revive an older active head', () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.run(
        f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
      );
      yield* f.run(f.machine.read('fixture-machine', f.remote));
      const old = f.head()!;
      f.setHead({ ...old, status: 'removed' });
      expect((yield* f.run(f.machine.read('fixture-machine', f.remote))).removed).toBe(true);
      f.setHead(old);
      expect(
        Result.isFailure(yield* Effect.result(f.run(f.machine.read('fixture-machine', f.remote))))
      ).toBe(true);
    })
  ));

it('charges slow I/O to the cache lifetime and a backward clock never renews it', () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.run(
        f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
      );
      const slow: SharingRemote = {
        ...f.remote,
        readHead: (input) =>
          Effect.gen(function* () {
            f.io.wall += 120_000;
            f.io.mono += 120_000;
            return yield* f.remote.readHead(input);
          }),
      };
      expect(
        yield* f.run(f.machine.authorize('fixture-machine', hex(f.bob.publicKey), undefined, slow))
      ).toMatchObject({ allowed: true });
      f.io.offline = true;
      f.io.wall += 780_000;
      f.io.mono += 780_000;
      expect(
        Result.isFailure(
          yield* Effect.result(
            f.run(f.machine.authorize('fixture-machine', hex(f.bob.publicKey), undefined, slow))
          )
        )
      ).toBe(true);
      f.io.offline = false;
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), undefined, f.remote)
        )
      ).toMatchObject({ allowed: true });
      f.io.wall--;
      f.io.offline = true;
      expect(
        Result.isFailure(
          yield* Effect.result(
            f.run(f.machine.authorize('fixture-machine', hex(f.bob.publicKey), undefined, f.remote))
          )
        )
      ).toBe(true);
    })
  ));

it('opens policy storage lazily and retries a failed open without touching content owners', () =>
  test((f) =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'sharing-lazy-')));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(directory, { recursive: true, force: true }))
      );
      const host = yield* makeLazyMachineSharingHost({
        filename: join(directory, 'missing', 'policy.sqlite'),
        workspaceId: 'workspace',
        genesisHash: hex(f.view().genesis),
        signer: f.f.phone.signer,
        credential: 'synthetic-secret',
        ledger: () => Effect.succeed(f.view()),
        admissionHistory: () =>
          Effect.succeed(f.f.records().map((record, index) => ({ record, length: index + 1 }))),
        readEpochKey: () => Effect.succeed(f.f.secret),
        refreshLedger: () => Effect.void,
      });
      expect(
        (yield* host.authorize('fixture-machine', hex(f.f.owner.publicKey), 'project-a', f.remote))
          .allowed
      ).toBe(true);
      expect(Result.isFailure(yield* Effect.result(host.read('fixture-machine', f.remote)))).toBe(
        true
      );
      yield* Effect.promise(async () => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(directory, 'missing'));
      });
      expect((yield* host.read('fixture-machine', f.remote)).sharedWithTeam).toBe(false);
    })
  ));

it('does not publish a delayed old read over a newer verified withdrawal', () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.run(
        f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
      );
      yield* f.run(f.machine.read('fixture-machine', f.remote));
      const old = f.head();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const slow: SharingRemote = {
        ...f.remote,
        readHead: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(old)
          ),
      };
      const read = yield* Effect.forkChild(
        f.run(f.machine.read('fixture-machine', slow)).pipe(Effect.result)
      );
      yield* Deferred.await(entered);
      yield* f.run(
        f.owner.write(
          'fixture-machine',
          hex(f.f.phone.publicKey),
          rid(2),
          { kind: 'machine', sharedWithTeam: false },
          f.remote
        )
      );
      expect((yield* f.run(f.machine.read('fixture-machine', f.remote))).sharedWithTeam).toBe(
        false
      );
      yield* Deferred.succeed(release, undefined);
      expect(Result.isFailure(yield* Fiber.join(read))).toBe(true);
      f.io.offline = true;
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), undefined, f.remote)
        )
      ).toMatchObject({ allowed: false, reason: 'machine-not-shared' });
    })
  ));

it('concurrent retries of one intent adopt one retained original before publication', () =>
  test((f) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let signing = 0;
      const signer = {
        publicKey: f.f.owner.publicKey,
        sign: (message: Uint8Array) =>
          Effect.gen(function* () {
            signing++;
            if (signing === 2) yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(release);
            return yield* f.f.owner.signer.sign(message);
          }),
      };
      const first = yield* f.make('concurrent-writer', signer);
      const second = yield* f.make('concurrent-writer', signer);
      const a = yield* Effect.forkChild(
        f
          .run(first.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote))
          .pipe(Effect.result)
      );
      const b = yield* Effect.forkChild(
        f
          .run(second.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote))
          .pipe(Effect.result)
      );
      yield* Deferred.await(ready);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(a)).toMatchObject({ _tag: 'Success', success: { status: 'saved' } });
      expect(yield* Fiber.join(b)).toMatchObject({ _tag: 'Success', success: { status: 'saved' } });
      expect(f.versions.size).toBe(1);
      expect((yield* f.run(f.machine.read('fixture-machine', f.remote))).projects).toEqual([
        'project-a',
      ]);
    })
  ));

it('isolates pending originals, high water and live caches on same-member machine readmission', () =>
  test((f) =>
    Effect.gen(function* () {
      const old = hex(f.f.phone.publicKey);
      yield* f.run(f.owner.write('fixture-machine', old, rid(1), change, f.remote));
      yield* f.run(
        f.owner.write(
          'fixture-machine',
          old,
          rid(2),
          { kind: 'machine', sharedWithTeam: false },
          f.remote
        )
      );
      f.io.lost = true;
      expect(
        yield* f.run(f.owner.write('fixture-machine', old, rid(3), change, f.remote))
      ).toMatchObject({ status: 'pending' });
      const permitted = yield* f.run(
        f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
      );
      expect(permitted.allowed).toBe(true);
      const replacement = f.f.ed(29);
      yield* f.append({ _tag: 'RevokeDevice', target: f.f.phone.publicKey });
      const admission = yield* P.prepareDeviceAdmission({
        genesis: f.view().genesis,
        membershipId: f.view().inspectState().owner,
        encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(new Uint8Array(32).fill(29))),
        kind: 'machine',
        machineId: 'fixture-machine',
        signer: replacement.signer,
      });
      yield* f.append(admission);
      f.newResource();
      f.io.lost = false;
      const generation = hex(replacement.publicKey);
      const state = yield* f.run(f.owner.read('fixture-machine', f.remote));
      expect(state).toMatchObject({ generation, head: null, sharedWithTeam: false, projects: [] });
      expect(state.pendingRequest).toBeUndefined();
      expect(
        (yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )).allowed
      ).toBe(false);
      expect(
        Result.isFailure(
          yield* Effect.result(f.owner.write('fixture-machine', old, rid(3), change, f.remote))
        )
      ).toBe(true);
      // Reusing an ID in another generation cannot reconcile or retransmit the old original.
      expect(
        yield* f.run(f.owner.write('fixture-machine', generation, rid(3), change, f.remote))
      ).toMatchObject({ status: 'saved' });
      expect(f.head()).toMatchObject({ generation, revision: 1 });
      expect(
        (yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )).allowed
      ).toBe(true);
      const reopened = yield* f.make('machine');
      expect(
        (yield* f.run(
          reopened.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )).allowed
      ).toBe(true);
    })
  ));

it('keeps same-member authority when generation proof is unavailable and retries sharing after recovery', () =>
  test((f) =>
    Effect.gen(function* () {
      yield* f.run(
        f.owner.write('fixture-machine', hex(f.f.phone.publicKey), rid(1), change, f.remote)
      );
      expect(
        (yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )).allowed
      ).toBe(true);
      f.io.proofUnavailable = true;
      expect(
        (yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )).allowed
      ).toBe(false);
      expect(
        yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.f.owner.publicKey), 'project-a', f.remote)
        )
      ).toMatchObject({ allowed: true, reason: 'owner' });
      f.io.proofUnavailable = false;
      expect(
        (yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )).allowed
      ).toBe(true);
    })
  ));

it('qualifies compact ledger checkpoints from originals and preserves the generation across atomic key replacement', () =>
  test((f) =>
    Effect.gen(function* () {
      const generation = hex(f.f.phone.publicKey);
      yield* f.run(f.owner.write('fixture-machine', generation, rid(1), change, f.remote));
      const replacement = f.f.ed(30);
      const admission = yield* P.prepareDeviceAdmission({
        genesis: f.view().genesis,
        membershipId: f.view().inspectState().owner,
        encryptionPublicKey: ok(P.Bytes.encryptionPublicKey(new Uint8Array(32).fill(30))),
        kind: 'machine',
        machineId: 'fixture-machine',
        signer: replacement.signer,
      });
      yield* f.append({ ...admission, replaces: f.f.phone.publicKey });
      f.setView(ok(P.restoreVerifiedState(ok(P.exportVerifiedState(f.view())))));
      expect(yield* f.run(f.owner.read('fixture-machine', f.remote))).toMatchObject({
        generation,
        sharedWithTeam: true,
        head: { revision: 1 },
      });
      expect(
        (yield* f.run(
          f.machine.authorize('fixture-machine', hex(f.bob.publicKey), 'project-a', f.remote)
        )).allowed
      ).toBe(true);
      yield* f.run(
        f.owner.write(
          'fixture-machine',
          generation,
          rid(2),
          { kind: 'machine', sharedWithTeam: false },
          f.remote
        )
      );
      expect(f.head()).toMatchObject({ generation, revision: 2 });
    })
  ));
