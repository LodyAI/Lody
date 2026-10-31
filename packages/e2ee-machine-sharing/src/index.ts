import { DatabaseSync } from 'node:sqlite';
import { Clock, Data, Effect, Fiber, Result, Scope, Semaphore } from 'effect';
import { z } from 'zod';
import {
  Bytes,
  contentPermissions,
  type MachineSharingAdmission,
  type VerifiedMachineSharingGeneration,
  ContentError,
  machineSharingContentScope,
  scopedDocumentKey,
  machineSharingDigest,
  sealMachineSharingPolicy,
  openMachineSharingPolicy,
  verifyMachineSharingHistoryStep,
  readMachineSharingHistoryStep,
  authorizeMachineExecution,
  updateMachineSharingState,
  type DeviceSigner,
  type LedgerView,
  type MachineSharingBinding,
  type MachineSharingChange,
  type MachineSharingPolicy,
  type MachineSharingHead,
  type VerifiedMachineSharingPolicy,
} from '@lody/e2ee-core/protocol';
import { machineSharingGenerationFromHistory } from './generation';
import type {
  E2eeMachineSharingTransport,
  E2eeMachineSharingHeadState,
  E2eeMachineSharingVersion,
  E2eeMachineSharingRequests,
  E2eeMachineSharingReplies,
  E2eeMachineSharingView,
  E2eeMachineSharingWriteResult,
} from '@lody/platform';

export class MachineSharingError extends Data.TaggedError('MachineSharingError')<{
  readonly code:
    | 'machine_not_shared'
    | 'machine_not_owned'
    | 'sharing_conflict'
    | 'sharing_unavailable'
    | 'sharing_storage'
    | 'sharing_invalid'
    | 'closed';
}> {}
const fail = (code: MachineSharingError['code']) => new MachineSharingError({ code });
export { sharingChangeSchema, sharingReplySchemas } from './schemas';
import { id, requestId, sharingChangeSchema, sharingReplySchemas } from './schemas';
export type SharingRemote = {
  [K in keyof E2eeMachineSharingTransport]: (
    input: E2eeMachineSharingRequests[K]
  ) => Effect.Effect<E2eeMachineSharingReplies[K], unknown>;
} & { refreshLedger?: () => Effect.Effect<void, unknown> };
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const unhex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const parse = <A>(schema: z.ZodType<A>, value: unknown) =>
  Effect.try({ try: () => schema.parse(value), catch: () => fail('sharing_invalid') });
const sql = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (e) => (e instanceof MachineSharingError ? e : fail('sharing_storage')),
  });
const key = (binding: MachineSharingBinding) =>
  JSON.stringify([
    binding.workspaceId,
    binding.genesisHash,
    binding.machineId,
    binding.ownerMembershipId,
    binding.generation,
  ]);
const matches = (binding: MachineSharingBinding, value: MachineSharingBinding) =>
  key(binding) === key(value);
const sameHead = (a: MachineSharingHead | null, b: MachineSharingHead | null) =>
  a?.revision === b?.revision && a?.digest === b?.digest;
const ttl = 900_000;
type Stamp = { wall: number; mono: bigint };
export const sharingStamp = Effect.gen(function* () {
  return { wall: yield* Clock.currentTimeMillis, mono: yield* Clock.monotonicTimeNanos };
});
export const sharingFresh = (a: Stamp, b: Stamp) =>
  b.wall >= a.wall &&
  b.wall - a.wall < ttl &&
  b.mono >= a.mono &&
  b.mono - a.mono < BigInt(ttl) * 1_000_000n;
type Pending = {
  intent: string;
  request: E2eeMachineSharingRequests['commit'];
  state: 'pending' | 'saved' | 'conflict' | 'removed';
};

// Preserve the policy-independent same-member rule even when policy storage or history is damaged.
const authorizeOwner = Effect.fnUntraced(function* (
  options: { ledger: () => Effect.Effect<LedgerView, unknown>; genesisHash: string },
  machineId: string,
  requester: string,
  localProjectId: string | undefined
) {
  // Same-member authority is independent of sharing history or policy storage.
  if (
    !id.safeParse(machineId).success ||
    (localProjectId !== undefined && !id.safeParse(localProjectId).success)
  )
    return undefined;
  const current = yield* options.ledger();
  if (hex(current.genesis.toBytes()) !== options.genesisHash) return undefined;
  const state = current.inspectState();
  const requesterDevice = state.devices.get(requester);
  const machines = [...state.devices.entries()].filter(
    ([, d]) => d.kind === 'machine' && d.machineId === machineId
  );
  if (machines.length === 1 && requesterDevice) {
    const [device, machine] = machines[0]!;
    const signer = yield* Effect.fromResult(Bytes.signingPublicKey(unhex(requester)));
    const machineKey = yield* Effect.fromResult(Bytes.signingPublicKey(unhex(device)));
    const a = contentPermissions(current, signer),
      b = contentPermissions(current, machineKey);
    if (
      requesterDevice.membershipId.equals(machine.membershipId) &&
      Result.isSuccess(a) &&
      a.success.mayWriteDocument &&
      Result.isSuccess(b) &&
      b.success.mayWriteDocument
    )
      return { allowed: true as const, reason: 'owner' as const };
  }
  return undefined;
});

/** Native, workspace-scoped owner. SQLite retains ciphertext/pins, never keys, credentials or freshness.
 * Atomic SQLite writes fence concurrent results; no lock spans crypto/network work. */
export const makeMachineSharingHost = Effect.fn('MachineSharingHost.make')(function* (options: {
  filename: string;
  workspaceId: string;
  genesisHash: string;
  signer: DeviceSigner;
  ledger: () => Effect.Effect<LedgerView, unknown>;
  admissionHistory: (
    ledger: LedgerView
  ) => Effect.Effect<readonly MachineSharingAdmission[], unknown>;
  readEpochKey: (epoch: number) => Effect.Effect<Bytes.EpochKey, unknown>;
  /** Refresh verified ledger before any authenticated latest read or write. */
  refreshLedger: () => Effect.Effect<void, unknown>;
  credential: string | (() => Effect.Effect<string, unknown>);
}) {
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const db = yield* Effect.acquireRelease(
    sql(() => {
      const connection = new DatabaseSync(options.filename);
      try {
        connection.exec(
          'PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sharing_pins(resource TEXT PRIMARY KEY, head TEXT NOT NULL, original TEXT); CREATE TABLE IF NOT EXISTS sharing_requests(resource TEXT NOT NULL, request_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(resource,request_id));'
        );
        return connection;
      } catch (e) {
        connection.close();
        throw e;
      }
    }),
    (connection) => sql(() => connection.close()).pipe(Effect.orDie)
  );
  const credential = () =>
    typeof options.credential === 'string'
      ? Effect.succeed(options.credential)
      : options.credential();
  const self = hex(options.signer.publicKey.toBytes());
  const cache = new Map<string, { policy: VerifiedMachineSharingPolicy; stamp: Stamp }>();
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      cache.clear();
    })
  );
  const guard = () => (closed ? Effect.fail(fail('closed')) : Effect.void);
  const admitted = <A, E>(work: Effect.Effect<A, E>) => guard().pipe(Effect.andThen(work));
  const target = Effect.fnUntraced(function* (machineId: string) {
    yield* parse(id, machineId);
    const ledger = yield* options.ledger();
    const devices = [...ledger.inspectState().devices.entries()].filter(
      ([, d]) => d.kind === 'machine' && d.machineId === machineId
    );
    if (devices.length !== 1) return yield* fail('machine_not_shared');
    const [device, machine] = devices[0]!;
    const machineGeneration = yield* machineSharingGenerationFromHistory({
      ledger,
      machineId,
      device: yield* Effect.fromResult(Bytes.signingPublicKey(unhex(device))),
      originals: yield* options.admissionHistory(ledger),
    });
    return {
      binding: {
        workspaceId: options.workspaceId,
        genesisHash: options.genesisHash,
        machineId,
        ownerMembershipId: hex(machine.membershipId.toBytes()),
        generation: machineGeneration.generation,
      },
      device,
      ledger,
      machineGeneration,
    };
  });
  const pin = (binding: MachineSharingBinding) =>
    sql(() => {
      const row = db
        .prepare('SELECT head, original FROM sharing_pins WHERE resource=?')
        .get(key(binding));
      if (!row) return null;
      return {
        head: sharingReplySchemas.readHead.parse(JSON.parse(String(row.head))),
        original:
          row.original === null
            ? null
            : (sharingReplySchemas.readVersion.parse(
                JSON.parse(String(row.original))
              ) as E2eeMachineSharingVersion),
      };
    });
  const remember = (
    binding: MachineSharingBinding,
    head: E2eeMachineSharingHeadState,
    original: E2eeMachineSharingVersion | null,
    allowSuperseded = false
  ) =>
    sql(() => {
      if (closed) throw fail('closed');
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT head FROM sharing_pins WHERE resource=?').get(key(binding));
        const previous = row
          ? sharingReplySchemas.readHead.parse(JSON.parse(String(row.head)))
          : null;
        if (previous && allowSuperseded && head.revision < previous.revision) {
          db.exec('COMMIT');
          return;
        }
        if (
          previous &&
          (head.revision < previous.revision ||
            (head.revision === previous.revision &&
              (head.digest !== previous.digest ||
                (previous.status === 'removed' && head.status !== 'removed'))))
        )
          throw fail('sharing_conflict');
        cache.delete(key(binding));
        db.prepare(
          'INSERT INTO sharing_pins VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET head=excluded.head,original=excluded.original'
        ).run(key(binding), JSON.stringify(head), original ? JSON.stringify(original) : null);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  const pending = (binding: MachineSharingBinding, rid: string) =>
    sql(() => {
      const row = db
        .prepare('SELECT value FROM sharing_requests WHERE resource=? AND request_id=?')
        .get(key(binding), rid);
      if (!row) return null;
      const value = JSON.parse(String(row.value)) as Pending;
      // Credentials are reconstructed, never persisted.
      sharingReplySchemas.commit.parse({
        status: 'committed',
        version: {
          ...value.request,
          digest: Result.getOrThrow(machineSharingDigest(unhex(value.request.frameHex))),
        },
      });
      if (
        typeof value.intent !== 'string' ||
        !['pending', 'saved', 'conflict', 'removed'].includes(value.state)
      )
        throw fail('sharing_storage');
      return { ...value, request: { ...value.request, credential: '' } };
    });
  const retain = (binding: MachineSharingBinding, value: Pending, adoptExisting = false) =>
    sql(() => {
      const { credential: _, ...original } = value.request;
      const next = { ...value, request: original };
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db
          .prepare('SELECT value FROM sharing_requests WHERE resource=? AND request_id=?')
          .get(key(binding), original.requestId);
        if (row) {
          const previous = JSON.parse(String(row.value)) as Pending;
          if (previous.intent !== value.intent) throw fail('sharing_conflict');
          // Concurrent exact retries may both finish signing before either has retained.
          // The first durable original wins; later callers adopt it, never publish their alternate frame.
          if (adoptExisting) {
            db.exec('COMMIT');
            return { ...previous, request: { ...previous.request, credential: '' } };
          }
          if (
            previous.intent !== value.intent ||
            JSON.stringify(previous.request) !== JSON.stringify(original) ||
            (previous.state !== 'pending' && previous.state !== value.state)
          )
            throw fail('sharing_conflict');
        }
        db.prepare(
          'INSERT INTO sharing_requests VALUES(?,?,?) ON CONFLICT(resource,request_id) DO UPDATE SET value=excluded.value'
        ).run(key(binding), original.requestId, JSON.stringify(next));
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  const readFrame = Effect.fnUntraced(function* (
    binding: MachineSharingBinding,
    version: E2eeMachineSharingVersion,
    machineGeneration: VerifiedMachineSharingGeneration,
    previous: MachineSharingHead | null,
    final: boolean,
    management = false
  ) {
    if (!matches(binding, version)) return yield* fail('sharing_invalid');
    const frame = unhex(version.frameHex);
    const epoch = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
      1,
      false
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const contentScope = yield* Effect.fromResult(machineSharingContentScope(binding, epoch));
        const documentKey = yield* scopedDocumentKey(
          contentScope,
          yield* options.readEpochKey(epoch)
        );
        const input = {
          ledger: yield* options.ledger(),
          binding,
          machineGeneration,
          epoch,
          documentKey,
          frame,
          expectedHead: version,
          previous,
        };
        if (!final)
          return {
            head: yield* Effect.fromResult(verifyMachineSharingHistoryStep(input)),
            policy: null,
            state: null,
          };
        if (management) {
          const active = openMachineSharingPolicy(input);
          if (Result.isSuccess(active)) {
            const body = active.success.inspect();
            if (
              body.requestId !== version.requestId ||
              body.previousDigest !== version.previousDigest
            )
              return yield* fail('sharing_invalid');
            return { head: active.success.head, policy: active.success, state: body };
          }
          const historical = yield* Effect.fromResult(readMachineSharingHistoryStep(input));
          if (
            historical.policy.requestId !== version.requestId ||
            historical.policy.previousDigest !== version.previousDigest
          )
            return yield* fail('sharing_invalid');
          return { head: historical.head, policy: null, state: historical.policy };
        }
        const policy = yield* Effect.fromResult(openMachineSharingPolicy(input));
        const body = policy.inspect();
        if (body.requestId !== version.requestId || body.previousDigest !== version.previousDigest)
          return yield* fail('sharing_invalid');
        return { head: policy.head, policy, state: body };
      })
    );
  });
  const latest = Effect.fnUntraced(function* (
    binding: MachineSharingBinding,
    remote: SharingRemote,
    machineGeneration: VerifiedMachineSharingGeneration,
    force = false,
    management = false
  ) {
    const resource = key(binding);
    const cached = cache.get(resource);
    if (!force && cached && sharingFresh(cached.stamp, yield* sharingStamp))
      return {
        policy: cached.policy,
        state: cached.policy.inspect(),
        head: { ...binding, ...cached.policy.head, status: 'active' as const },
      };
    cache.delete(resource);
    const started = yield* sharingStamp;
    yield* options.refreshLedger();
    yield* remote.refreshLedger?.() ?? Effect.void;
    const access = { ...binding, credential: yield* credential() };
    const head = yield* parse(sharingReplySchemas.readHead, yield* remote.readHead(access));
    yield* guard();
    const saved = yield* pin(binding);
    if (head && !matches(binding, head)) return yield* fail('sharing_invalid');
    if (
      saved?.head &&
      (!head ||
        head.revision < saved.head.revision ||
        (head.revision === saved.head.revision && head.digest !== saved.head.digest))
    )
      return yield* fail('sharing_conflict');
    if (!head) return { policy: null, state: null, head };
    if (head.status === 'removed') {
      yield* remember(binding, head, saved?.original ?? null);
      return { policy: null, state: null, head };
    }
    // Removal is terminal within a generation. Re-admission has a separate resource.
    if (saved?.head?.status === 'removed') return yield* fail('sharing_conflict');
    let previous: MachineSharingHead | null = saved?.original
      ? { revision: saved.original.revision, digest: saved.original.digest }
      : null;
    let policy: VerifiedMachineSharingPolicy | null = null;
    let fullState: MachineSharingPolicy | null = null;
    if (head.revision - (previous?.revision ?? 0) > 4096) return yield* fail('sharing_unavailable');
    for (
      let revision =
        previous && previous.revision === head.revision
          ? previous.revision
          : (previous?.revision ?? 0) + 1;
      revision <= head.revision;
      revision++
    ) {
      if (!sharingFresh(started, yield* sharingStamp)) return yield* fail('sharing_unavailable');
      const raw =
        saved?.original?.revision === revision
          ? saved.original
          : yield* parse(
              sharingReplySchemas.readVersion,
              yield* remote.readVersion({ ...access, revision })
            );
      if (!raw || 'status' in raw || raw.revision !== revision)
        return yield* fail('sharing_unavailable');
      const read = yield* readFrame(
        binding,
        raw,
        machineGeneration,
        previous,
        revision === head.revision,
        management
      );
      previous = read.head;
      policy = read.policy;
      fullState = read.state;
      if (revision === head.revision) {
        if (!sameHead(read.head, head)) return yield* fail('sharing_conflict');
        yield* guard();
        if (read.policy) yield* remember(binding, head, raw);
      }
    }
    if ((!policy && !management) || !fullState || !sharingFresh(started, yield* sharingStamp))
      return yield* fail('sharing_unavailable');
    if (policy)
      yield* sql(() => {
        const row = db.prepare('SELECT head FROM sharing_pins WHERE resource=?').get(resource);
        const current = row
          ? sharingReplySchemas.readHead.parse(JSON.parse(String(row.head)))
          : null;
        if (closed || current?.status !== 'active' || !sameHead(current, policy.head))
          throw fail('sharing_conflict');
        cache.set(resource, { policy, stamp: started });
      });
    return { policy, state: fullState, head };
  });
  const read = Effect.fnUntraced(function* (
    machineId: string,
    remote: SharingRemote,
    force = true
  ) {
    const { binding, machineGeneration } = yield* target(machineId);
    return yield* admitted(
      Effect.gen(function* () {
        const unfinished = yield* sql(() => {
          const rows = db
            .prepare(
              'SELECT request_id,value FROM sharing_requests WHERE resource=? ORDER BY request_id'
            )
            .all(key(binding));
          const row = rows.find(
            (value) => (JSON.parse(String(value.value)) as Pending).state === 'pending'
          );
          if (!row) return undefined;
          return {
            requestId: String(row.request_id),
            change: sharingChangeSchema.parse(
              JSON.parse((JSON.parse(String(row.value)) as Pending).intent)
            ),
          };
        });
        const checked = yield* Effect.result(
          latest(binding, remote, machineGeneration, force, true)
        );
        if (Result.isFailure(checked) && !unfinished) return yield* Effect.fail(checked.failure);
        const policy = Result.isSuccess(checked) ? checked.success.policy : null;
        const saved = yield* pin(binding);
        const body = Result.isSuccess(checked) ? checked.success.state : null;
        const current = yield* target(machineId);
        if (!matches(binding, current.binding)) return yield* fail('sharing_conflict');
        const selfDevice = current.ledger.inspectState().devices.get(self);
        const permissions = contentPermissions(current.ledger, options.signer.publicKey);
        const canManage =
          selfDevice?.kind === 'personal' &&
          hex(selfDevice.membershipId.toBytes()) === binding.ownerMembershipId &&
          Result.isSuccess(permissions) &&
          permissions.success.mayWriteDocument;
        const decision = authorizeMachineExecution({
          ledger: current.ledger,
          policy,
          signer: options.signer.publicKey,
          machineGeneration: current.machineGeneration,
          target: {
            ...binding,
            device: Result.getOrThrow(Bytes.signingPublicKey(unhex(current.device))),
          },
        });
        return {
          machineId,
          ownerMembershipId: binding.ownerMembershipId,
          generation: binding.generation,
          head:
            Result.isSuccess(checked) && body
              ? {
                  revision: checked.success.head!.revision,
                  digest: checked.success.head!.digest as string,
                }
              : null,
          sharedWithTeam: body?.sharedWithTeam ?? false,
          projects: body?.projects ?? [],
          canManage,
          signer: body?.signer ?? null,
          needsResign:
            !!body &&
            (!policy ||
              (() => {
                const signer = current.ledger.inspectState().devices.get(body.signer);
                const permission = contentPermissions(
                  current.ledger,
                  Result.getOrThrow(Bytes.signingPublicKey(unhex(body.signer)))
                );
                return (
                  signer?.kind !== 'personal' ||
                  hex(signer.membershipId.toBytes()) !== binding.ownerMembershipId ||
                  Result.isFailure(permission) ||
                  !permission.success.mayWriteDocument
                );
              })()),
          ...(!decision.allowed ? { deniedReason: 'e2ee_machine_not_shared' as const } : {}),
          removed: saved?.head?.status === 'removed',
          ...(unfinished ? { pendingRequest: unfinished } : {}),
          ...(Result.isFailure(checked) ? { unavailable: true as const } : {}),
        } satisfies E2eeMachineSharingView;
      })
    );
  });
  type Target = Effect.Success<ReturnType<typeof target>>;
  type Decide = (
    ledger: LedgerView,
    policy: VerifiedMachineSharingPolicy | null
  ) => ReturnType<typeof authorizeMachineExecution>;
  // The resource's accepted pin advances only on a newer verified head, and a failed or
  // timed-out refresh never rewrites it. A pinned denial therefore stays known until a
  // newer verified policy replaces it; it never grants anything. Its issuer only had to
  // be eligible when it signed: a later revocation invalidates grants, never a denial.
  const pinnedDenial = (initial: Target, decide: Decide, localProjectId: string | undefined) =>
    Effect.gen(function* () {
      const saved = yield* pin(initial.binding);
      const original = saved?.original;
      if (
        saved?.head?.status !== 'active' ||
        !original ||
        original.revision !== saved.head.revision ||
        original.digest !== saved.head.digest
      )
        return undefined;
      const retained = yield* readFrame(
        initial.binding,
        original,
        initial.machineGeneration,
        { revision: original.revision, digest: original.digest },
        true,
        true
      );
      if (!retained.policy) {
        // Historically authenticated owner-personal state: usable only as a denial.
        if (!retained.state) return undefined;
        if (!retained.state.sharedWithTeam)
          return { allowed: false as const, reason: 'machine-not-shared' as const };
        if (localProjectId !== undefined && !retained.state.projects.includes(localProjectId))
          return { allowed: false as const, reason: 'project-not-shared' as const };
        return undefined;
      }
      const decision = decide(yield* options.ledger(), retained.policy);
      return !decision.allowed &&
        (decision.reason === 'machine-not-shared' || decision.reason === 'project-not-shared')
        ? decision
        : undefined;
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const decider = Effect.fnUntraced(function* (
    machineId: string,
    requester: string,
    localProjectId: string | undefined
  ) {
    const qualified = yield* Effect.result(target(machineId));
    if (Result.isFailure(qualified)) return undefined;
    const initial = qualified.success;
    const signer = yield* Effect.fromResult(Bytes.signingPublicKey(unhex(requester)));
    const decide: Decide = (ledger, policy) =>
      authorizeMachineExecution({
        ledger,
        machineGeneration: initial.machineGeneration,
        policy,
        signer,
        localProjectId,
        target: {
          workspaceId: options.workspaceId,
          genesisHash: options.genesisHash,
          machineId,
          generation: initial.binding.generation,
          device: Result.getOrThrow(Bytes.signingPublicKey(unhex(initial.device))),
        },
      });
    return { initial, decide };
  });
  /** Local only: the verified denial retained for this resource, without any network read. */
  const knownDenial = Effect.fnUntraced(function* (
    machineId: string,
    requester: string,
    localProjectId: string | undefined
  ) {
    yield* guard();
    if (yield* authorizeOwner(options, machineId, requester, localProjectId)) return undefined;
    const resolved = yield* decider(machineId, requester, localProjectId);
    if (!resolved || resolved.decide(resolved.initial.ledger, null).allowed) return undefined;
    return yield* pinnedDenial(resolved.initial, resolved.decide, localProjectId);
  });
  const authorize = Effect.fnUntraced(function* (
    machineId: string,
    requester: string,
    localProjectId: string | undefined,
    remote: SharingRemote
  ) {
    yield* guard();
    const owner = yield* authorizeOwner(options, machineId, requester, localProjectId);
    if (owner) return owner;
    const resolved = yield* decider(machineId, requester, localProjectId);
    if (!resolved) return { allowed: false as const, reason: 'policy-unavailable' as const };
    const { initial, decide } = resolved;
    const own = decide(initial.ledger, null);
    if (own.allowed) return own;
    if (own.reason !== 'policy-unavailable') return own;
    const unknown = () =>
      Effect.map(
        pinnedDenial(initial, decide, localProjectId),
        (denial) => denial ?? { allowed: false as const, reason: 'policy-unavailable' as const }
      );
    return yield* admitted(
      Effect.gen(function* () {
        const uncertain = yield* sql(() =>
          db
            .prepare('SELECT value FROM sharing_requests WHERE resource=?')
            .all(key(initial.binding))
            .some((row) => (JSON.parse(String(row.value)) as Pending).state === 'pending')
        );
        if (uncertain) return yield* unknown();
        const refreshed = yield* Effect.result(
          latest(initial.binding, remote, initial.machineGeneration)
        );
        if (Result.isFailure(refreshed)) {
          const denial = yield* pinnedDenial(initial, decide, localProjectId);
          if (denial) return denial;
          return yield* Effect.fail(refreshed.failure);
        }
        const { policy, head } = refreshed.success;
        yield* guard();
        // An authenticated read found no policy for this generation (a new or re-paired
        // machine is private by default) or its removal: a known denial, not unknown.
        if (!policy && (head === null || head.status === 'removed'))
          return { allowed: false as const, reason: 'machine-not-shared' as const };
        const cached = cache.get(key(initial.binding));
        if (!cached || cached.policy !== policy || !sharingFresh(cached.stamp, yield* sharingStamp))
          return yield* unknown();
        // Capture a synchronous final fence for the journal's no-yield actual-start boundary.
        const ledger = yield* options.ledger();
        const isCurrent = () =>
          !closed &&
          cache.get(key(initial.binding)) === cached &&
          sharingFresh(cached.stamp, {
            wall: clock.currentTimeMillisUnsafe(),
            mono: clock.monotonicTimeNanosUnsafe(),
          });
        if (!isCurrent()) return { allowed: false as const, reason: 'policy-unavailable' as const };
        return { ...decide(ledger, policy), isCurrent };
      })
    );
  });
  const write = Effect.fnUntraced(function* (
    machineId: string,
    generation: string,
    rid: string,
    change: MachineSharingChange,
    remote: SharingRemote
  ) {
    yield* parse(requestId, rid);
    const normalized = yield* parse(sharingChangeSchema, change);
    const accessCredential = yield* credential();
    yield* options.refreshLedger();
    yield* remote.refreshLedger?.() ?? Effect.void;
    const { binding, ledger, machineGeneration } = yield* target(machineId);
    if (generation !== binding.generation) return yield* fail('sharing_conflict');
    const own = ledger.inspectState().devices.get(self);
    if (
      !own ||
      own.kind !== 'personal' ||
      hex(own.membershipId.toBytes()) !== binding.ownerMembershipId
    )
      return yield* fail('machine_not_owned');
    return yield* admitted(
      Effect.gen(function* (): Effect.fn.Return<E2eeMachineSharingWriteResult, unknown> {
        const intent = JSON.stringify(normalized);
        let retained = yield* pending(binding, rid);
        if (
          retained &&
          (!matches(binding, retained.request) ||
            retained.request.requestId !== rid ||
            retained.intent !== intent)
        )
          return yield* fail('sharing_conflict');
        if (!retained) {
          const unfinished = yield* sql(() =>
            db
              .prepare('SELECT value FROM sharing_requests WHERE resource=?')
              .all(key(binding))
              .some((row) => (JSON.parse(String(row.value)) as Pending).state === 'pending')
          );
          if (unfinished) return yield* fail('sharing_conflict');
          const current = yield* latest(binding, remote, machineGeneration, true, true);
          const expectedHead = current.head;
          if (expectedHead?.status === 'removed') return { status: 'removed', requestId: rid };
          const state = current.state ?? { sharedWithTeam: false, projects: [] };
          const next = yield* Effect.fromResult(updateMachineSharingState(state, normalized));
          const view = yield* options.ledger();
          const epoch = view.inspectState().epoch.number;
          const frame = yield* Effect.scoped(
            Effect.gen(function* () {
              const contentScope = yield* Effect.fromResult(
                machineSharingContentScope(binding, epoch)
              );
              const documentKey = yield* scopedDocumentKey(
                contentScope,
                yield* options.readEpochKey(epoch)
              );
              return yield* sealMachineSharingPolicy({
                machineGeneration,
                policy: {
                  ...binding,
                  ...next,
                  revision: (expectedHead?.revision ?? 0) + 1,
                  previousDigest: expectedHead?.digest ?? null,
                  requestId: rid,
                  signer: self,
                  issuedAt: yield* Clock.currentTimeMillis,
                },
                epoch,
                documentKey,
                signer: options.signer,
                ledger: () =>
                  options
                    .ledger()
                    .pipe(
                      Effect.mapError(() => new ContentError({ code: 'invalid-policy-ledger' }))
                    ),
              });
            })
          );
          retained = {
            intent,
            state: 'pending',
            request: {
              ...binding,
              credential: accessCredential,
              expectedHead,
              revision: (expectedHead?.revision ?? 0) + 1,
              previousDigest: expectedHead?.digest ?? null,
              requestId: rid,
              frameHex: hex(frame),
            },
          };
          retained = yield* retain(binding, retained, true);
        }
        const original = {
          ...retained,
          request: { ...retained.request, credential: accessCredential },
        };
        if (original.state !== 'pending') return { status: original.state, requestId: rid };
        // A local withdrawal fences cached grants even if publication becomes uncertain.
        cache.delete(key(binding));
        const reconcile = yield* Effect.result(
          remote
            .readRequest({ ...binding, credential: accessCredential, requestId: rid })
            .pipe(Effect.flatMap((v) => parse(sharingReplySchemas.readRequest, v)))
        );
        if (Result.isFailure(reconcile)) return { status: 'pending', requestId: rid };
        let result: E2eeMachineSharingReplies['commit'];
        if (reconcile.success) {
          result =
            'status' in reconcile.success
              ? { status: 'removed', head: reconcile.success }
              : { status: 'committed', version: reconcile.success };
        } else {
          const sent = yield* Effect.result(
            remote
              .commit(original.request)
              .pipe(Effect.flatMap((v) => parse(sharingReplySchemas.commit, v)))
          );
          if (Result.isFailure(sent)) return { status: 'pending', requestId: rid };
          result = sent.success;
        }
        let state: Pending['state'];
        if (result.status === 'committed') {
          const version = result.version;
          if (
            !matches(binding, version) ||
            version.requestId !== rid ||
            version.frameHex !== original.request.frameHex ||
            version.revision !== original.request.revision ||
            version.previousDigest !== original.request.previousDigest
          )
            return yield* fail('sharing_conflict');
          yield* Effect.fromResult(machineSharingDigest(unhex(version.frameHex)));
          const previous =
            original.request.expectedHead && original.request.expectedHead.revision > 0
              ? {
                  revision: original.request.expectedHead.revision,
                  digest: original.request.expectedHead.digest as string,
                }
              : null;
          yield* readFrame(binding, version, machineGeneration, previous, true);
          yield* remember(
            binding,
            { ...binding, revision: version.revision, digest: version.digest, status: 'active' },
            version,
            true
          );
          state = 'saved';
        } else {
          const head = result.head;
          if (head && !matches(binding, head)) return yield* fail('sharing_invalid');
          state = result.status;
        }
        yield* retain(binding, { ...original, state });
        return { status: state, requestId: rid };
      })
    );
  });
  const owned = Effect.fnUntraced(function* <A, E>(work: Effect.Effect<A, E>) {
    yield* guard();
    const fiber = yield* Effect.forkIn(work, scope);
    return yield* Fiber.join(fiber);
  });
  // Observe retained RAM only. This is not an execution decision and deliberately
  // does not check/extend freshness, resolve a target or initialize an owner.
  const inspectCache = (machineId: string) => {
    let cachedPolicies = 0,
      cachedExecutionGrants = 0;
    for (const entry of cache.values()) {
      const policy = entry.policy.inspect();
      if (policy.machineId !== machineId) continue;
      cachedPolicies++;
      if (policy.sharedWithTeam) cachedExecutionGrants++;
    }
    return { cachedPolicies, cachedExecutionGrants };
  };
  return {
    /** Passive counts of retained policies/team grants, never current authorization. */
    inspectCache,
    read: (...args: Parameters<typeof read>) => owned(read(...args)),
    write: (...args: Parameters<typeof write>) => owned(write(...args)),
    authorize: (...args: Parameters<typeof authorize>) => owned(authorize(...args)),
    /** A retained verified denial, read locally; `undefined` is unknown, never permission. */
    knownDenial: (...args: Parameters<typeof knownDenial>) => owned(knownDenial(...args)),
    invalidate: () => cache.clear(),
    stop: () => {
      closed = true;
      cache.clear();
    },
  };
});

/** Adapter at native application composition; SDK I/O never owns policy state. */
export function sharingRemoteFromTransport(transport: E2eeMachineSharingTransport): SharingRemote {
  const call = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: () => fail('sharing_unavailable') });
  return {
    readHead: (input) => call(() => transport.readHead(input)),
    readVersion: (input) => call(() => transport.readVersion(input)),
    readRequest: (input) => call(() => transport.readRequest(input)),
    commit: (input) => call(() => transport.commit(input)),
  };
}

/** Policy storage is independent of content/ledger availability. Defer opening it
 * until a policy-dependent operation; a broken policy database cannot stop reads
 * or same-member execution. Failed opens remain retryable in this owner scope. */
export const makeLazyMachineSharingHost = Effect.fnUntraced(function* (
  options: Parameters<typeof makeMachineSharingHost>[0]
) {
  const scope = yield* Effect.scope;
  const serial = yield* Semaphore.make(1);
  let owner: Effect.Success<ReturnType<typeof makeMachineSharingHost>> | undefined;
  let stopped = false;
  const get = serial.withPermit(
    Effect.gen(function* () {
      if (stopped) return yield* fail('closed');
      owner ??= yield* makeMachineSharingHost(options).pipe(Scope.provide(scope));
      return owner;
    })
  );
  const stop = () => {
    stopped = true;
    owner?.stop();
  };
  yield* Effect.addFinalizer(() => Effect.sync(stop));
  return {
    /** Count an existing owner only; observing an unopened host never opens storage. */
    inspectCache: (machineId: string) =>
      owner?.inspectCache(machineId) ?? { cachedPolicies: 0, cachedExecutionGrants: 0 },
    read: (
      ...args: Parameters<Effect.Success<ReturnType<typeof makeMachineSharingHost>>['read']>
    ) => Effect.flatMap(get, (value) => value.read(...args)),
    write: (
      ...args: Parameters<Effect.Success<ReturnType<typeof makeMachineSharingHost>>['write']>
    ) => Effect.flatMap(get, (value) => value.write(...args)),
    authorize: (
      ...args: Parameters<Effect.Success<ReturnType<typeof makeMachineSharingHost>>['authorize']>
    ) =>
      Effect.gen(function* () {
        if (stopped) return yield* fail('closed');
        const ownDecision = yield* authorizeOwner(options, args[0], args[1], args[2]);
        if (ownDecision) return ownDecision;
        return yield* Effect.flatMap(get, (value) => value.authorize(...args));
      }),
    knownDenial: (
      ...args: Parameters<Effect.Success<ReturnType<typeof makeMachineSharingHost>>['knownDenial']>
    ) => Effect.flatMap(get, (value) => value.knownDenial(...args)),
    invalidate: () => owner?.invalidate(),
    stop,
  };
});
