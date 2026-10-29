import { Cause, Clock, Effect, Exit, Result, Semaphore, type Layer } from 'effect';
import type { E2eeWorkspaceRuntime, E2eeRuntimeStatus, E2eeContentRoom } from '@lody/platform';
import { encryptedWorkspaceRoom } from '@lody/shared/workspace-streams-content';
import {
  Bytes,
  exportVerifiedState,
  hasVerifiedCheckpoint,
  hashRecordBytes,
  type LedgerView,
} from '@lody/e2ee-core/protocol';
import { makeOwnedPersonalDeviceHost, type PersonalHostPorts } from './owned-host';
import { PersonalPairingOfferSchema, type PersonalPairingOffer } from './pairing';
import { fail, PersonalRuntimeFailure } from './errors';
import { fromHex, toHex } from './bytes';
import { captureSeal, captureOpen, capturePage } from './runtime-input';

type Host = Effect.Success<ReturnType<typeof makeOwnedPersonalDeviceHost>>;
type Session = Effect.Success<ReturnType<Host['open']>>;
/** Real application ports for one pinned workspace. No backend or identity creation is implicit. */
export interface PersonalRuntimeOptions<E> {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly genesisHash: string;
  readonly ports: Layer.Layer<PersonalHostPorts, E>;
  /** Local retained original only. The host re-verifies it and refuses missing ready custody. */
  readonly retainedOffer: () => Effect.Effect<PersonalPairingOffer | null, unknown>;
  /** Live account identity. A token/login is never desktop approval. */
  readonly account: (options?: {
    token?: string;
  }) => Effect.Effect<{ userId: string; source: 'network' | 'offline' } | null, unknown>;
  /** Local original rows, not a second remote history authority. Each hash/absolute position is checked against the genuine view. */
  readonly ledgerRecords: (
    view: LedgerView
  ) => Effect.Effect<readonly { position: number; record: Uint8Array }[], unknown>;
  /** Application entry executor. Keeps Effect execution out of native composition; retain its environment through confirmed Scope retirement. */
  readonly run: <A>(program: Effect.Effect<A, unknown>) => Promise<A>;
  /** Optional real creation host; never supplied for a pairing-only assembly. */
  readonly recordCreated?: (
    input: Parameters<E2eeWorkspaceRuntime['recordCreated']>[0]
  ) => Effect.Effect<void, unknown>;
}

/**
 * Existing platform contract over the owned personal host. The consumer Scope owns
 * the complete host Layer; close timeouts retain its recovery owner. A reader lease
 * is only local ownership, never authority. No call opens ordinary transport.
 */
export const makePersonalWorkspaceRuntime = Effect.fnUntraced(function* <E>(
  configuration: PersonalRuntimeOptions<E>
) {
  const options = Object.freeze({ ...configuration });
  const { accountId, workspaceId, genesisHash } = options;
  if (!accountId || !workspaceId || !/^[0-9a-f]{64}$/.test(genesisHash))
    return yield* fail('invalid-input');
  const host = yield* makeOwnedPersonalDeviceHost(options.ports);
  if (
    host.scope.accountId !== accountId ||
    host.scope.workspaceId !== workspaceId ||
    toHex(host.scope.genesis.toBytes()) !== genesisHash
  ) {
    yield* host.close();
    return yield* fail('scope-mismatch');
  }
  const ownerId = yield* Effect.try({
    try: () => crypto.randomUUID(),
    catch: (cause) => fail('protection-unavailable', cause),
  });
  const setup = yield* Semaphore.make(1);
  let entry: { session: Session; closing: boolean; readers: Set<string> } | undefined;
  const pendingReaders = new Map<string, { closed: boolean }>();
  let nextReader = 0;
  let opening: string | undefined,
    retired = false;
  const account = options.account.bind(configuration),
    execute = options.run.bind(configuration),
    retained = options.retainedOffer.bind(configuration),
    readLocalRecords = options.ledgerRecords.bind(configuration),
    recordCreated = options.recordCreated?.bind(configuration);
  const run = <A>(program: Effect.Effect<A, unknown>): Promise<A> =>
    execute(Effect.exit(program)).then((result) => {
      if (Exit.isSuccess(result)) return result.value;
      // The owned host interrupted this retired assembly's operation. Keep mixed
      // failures intact; an interruption alone is the reader's closed outcome.
      if (retired && Cause.hasInterruptsOnly(result.cause)) throw fail('closed');
      if (result.cause.reasons.length === 1) throw Cause.squash(result.cause);
      throw new PersonalRuntimeFailure({ code: 'runtime-failed', cause: result.cause });
    });
  const guard = Effect.fnUntraced(function* (id: string, expected = accountId) {
    if (retired) return yield* fail('closed');
    if (id !== workspaceId || expected !== accountId) return yield* fail('scope-mismatch');
    if ((yield* account())?.userId !== accountId) {
      retired = true;
      yield* host.close();
      return yield* fail('scope-mismatch');
    }
    return undefined;
  });
  const offer = Effect.fnUntraced(function* () {
    const value = yield* retained();
    if (!value) return yield* fail('identity-lost');
    const parsed = yield* Effect.try({
      try: () => PersonalPairingOfferSchema.parse(value),
      catch: () => fail('corrupt'),
    });
    if (parsed.workspaceId !== workspaceId || parsed.genesisHash !== genesisHash)
      return yield* fail('scope-mismatch');
    return parsed;
  });
  const active = Effect.fnUntraced(function* (id: string) {
    yield* guard(id);
    if (!entry || entry.closing || !entry.readers.size) return yield* fail('closed');
    return entry;
  });
  const check = Effect.fnUntraced(function* (lease: NonNullable<typeof entry>) {
    yield* guard(workspaceId);
    if (entry !== lease || lease.closing || !lease.readers.size) return yield* fail('closed');
    return undefined;
  });
  const withSession = <A>(
    id: string,
    operation: (session: Session) => Effect.Effect<A, unknown>,
    wipe?: (value: A) => void
  ) =>
    Effect.gen(function* () {
      const lease = yield* active(id);
      const work = operation(lease.session);
      // Secret output and cleanup registration cannot be separated by cancellation.
      if (wipe)
        return yield* Effect.acquireUseRelease(
          work,
          (value) => check(lease).pipe(Effect.as(value)),
          (value, outcome) =>
            Effect.sync(() => {
              if (Exit.isFailure(outcome)) wipe(value);
            })
        );
      const value = yield* work;
      yield* check(lease);
      return value;
    });
  const status = Effect.fnUntraced(function* (
    session: Session,
    snapshot?: Effect.Success<ReturnType<Session['ledgerState']>>
  ): Effect.fn.Return<E2eeRuntimeStatus, unknown> {
    const current = snapshot ?? (yield* session.ledgerState()),
      view = current.view,
      state = view.inspectState();
    const saved = yield* Effect.fromResult(exportVerifiedState(view));
    const selfKey = toHex(session.binding.device.toBytes()),
      self = state.devices.get(selfKey);
    // Key-store failure is not a ledger failure. Each actual content operation still checks admission and its own key.
    const keys = yield* Effect.result(session.status());
    const available = Result.isSuccess(keys) ? keys.success.usableEpoch : null;
    const writeEpoch = available !== null && available <= state.epoch.number ? available : null;
    return {
      workspaceId,
      genesisHash,
      length: view.length,
      headHash: toHex(view.head.toBytes()),
      stateDigest: toHex(saved.stateDigest.toBytes()),
      position: current.bootstrap ? null : current.offset,
      epoch: state.epoch.number,
      rotationRequired: state.epoch.rotationRequired,
      signingPublicKey: selfKey,
      membershipId: self ? toHex(self.membershipId.toBytes()) : null,
      memberRole: self
        ? (state.members.get(toHex(self.membershipId.toBytes()))?.role ?? null)
        : null,
      deviceKind: self?.kind ?? null,
      hasCurrentKey: writeEpoch === state.epoch.number,
      writeEpoch,
      hasDeviceCredential: true,
      continuityPending: false,
    };
  });
  const hasKey = Effect.fnUntraced(function* (session: Session) {
    if ((yield* session.status()).usableEpoch === null) return yield* fail('keys-unavailable');
    return undefined;
  });
  const installKeys = Effect.fnUntraced(function* (session: Session) {
    for (let pass = 0; pass < 4; pass++) {
      if (!(yield* session.keyRound()).refreshRequired) return undefined;
      yield* session.refresh();
    }
    return undefined;
  });
  const room = (input: E2eeContentRoom) =>
    Effect.try({
      try: () => encryptedWorkspaceRoom(workspaceId, input),
      catch: () => fail('invalid-input'),
    });
  const retainedRequest = Effect.fnUntraced(function* (id: string, sessionId: string) {
    yield* guard(id);
    const saved = yield* offer();
    if (saved.pairingSessionId !== sessionId) return yield* fail('scope-mismatch');
    return saved;
  });
  const finish = Effect.fnUntraced(function* (
    session: Session,
    command: Parameters<Session['execute']>[0]
  ) {
    const result = yield* session.execute(command);
    yield* session.acknowledge(result);
    if (result.outcome !== 'Committed') return yield* fail('conflict');
    return undefined;
  });
  const runtime: E2eeWorkspaceRuntime = {
    readerLeases: 'preallocated-v1',
    account: (input) => run(account(input)),
    open: (id, supplied, expected, requestedOwner) => {
      const observed = supplied ? { ...supplied } : undefined;
      const readerOwner = requestedOwner ?? `${ownerId}:${++nextReader}`;
      return run(
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            if (typeof readerOwner !== 'string' || !readerOwner.length || readerOwner.length > 256)
              return yield* fail('invalid-input');
            if (pendingReaders.has(readerOwner) || entry?.readers.has(readerOwner))
              return yield* fail('conflict');
            const pending = { closed: false };
            pendingReaders.set(readerOwner, pending);
            return pending;
          }),
          (pending) =>
            Effect.gen(function* () {
              yield* guard(id, expected);
              return yield* setup.withPermit(
                Effect.gen(function* () {
                  yield* guard(id, expected);
                  if (pending.closed) return yield* fail('closed');
                  if (
                    observed &&
                    (observed.genesisHash !== genesisHash ||
                      !Number.isSafeInteger(observed.length) ||
                      observed.length < 1 ||
                      !/^[0-9a-f]{64}$/.test(observed.headHash))
                  )
                    return yield* fail('scope-mismatch');
                  if (entry?.closing) {
                    yield* entry.session.close();
                    entry = undefined;
                  }
                  let created = false;
                  if (!entry) {
                    const saved = yield* offer();
                    if (pending.closed) return yield* fail('closed');
                    opening = readerOwner;
                    yield* Effect.acquireUseRelease(
                      host.open(saved, false, true),
                      (session) =>
                        Effect.sync(() => {
                          entry = { session, closing: retired, readers: new Set() };
                          created = true;
                        }),
                      (session, result) =>
                        Exit.isFailure(result) ? session.close().pipe(Effect.orDie) : Effect.void
                    ).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (opening === readerOwner) opening = undefined;
                        })
                      )
                    );
                  }
                  const lease = entry!;
                  const result = yield* Effect.exit(
                    Effect.gen(function* () {
                      const view = yield* lease.session.ledger();
                      if (
                        observed &&
                        !Result.getOrThrow(
                          hasVerifiedCheckpoint(view, {
                            length: observed.length,
                            head: Result.getOrThrow(Bytes.recordHash(fromHex(observed.headHash))),
                          })
                        )
                      )
                        return yield* fail('conflict');
                      const value = yield* status(lease.session);
                      yield* guard(id, expected);
                      if (lease.closing || pending.closed) return yield* fail('closed');
                      lease.readers.add(readerOwner);
                      return { ...value, readerOwner };
                    })
                  );
                  if (Exit.isFailure(result) && created) {
                    lease.closing = true;
                    yield* lease.session.close();
                    if (entry === lease) entry = undefined;
                  }
                  return yield* result;
                })
              );
            }),
          () =>
            Effect.sync(() => {
              pendingReaders.delete(readerOwner);
            })
        )
      );
    },
    close: (id, expected = accountId, readerOwner) =>
      run(
        Effect.gen(function* () {
          // Closing the captured account remains possible after logout; it cannot touch another account's lease.
          if (id !== workspaceId || expected !== accountId) return yield* fail('scope-mismatch');
          const pending = readerOwner ? pendingReaders.get(readerOwner) : undefined;
          if (pending) pending.closed = true;
          if (!readerOwner) for (const request of pendingReaders.values()) request.closed = true;
          const lease = entry;
          // A pending lease borrowing an already-owned shared session owns no release
          // of the other readers. Its callback will refuse publication; the shared
          // session continues to own all physical work until its last reader closes.
          if (pending && lease?.readers.size && !lease.readers.has(readerOwner!)) return undefined;
          if (readerOwner && !pending && lease?.readers.size && !lease.readers.has(readerOwner))
            return undefined;
          if (retired || (opening && (!readerOwner || opening === readerOwner))) {
            retired = true;
            yield* host.close();
            return undefined;
          }
          if (!lease) return undefined;
          if (readerOwner && !pending && !lease.readers.has(readerOwner) && !lease.closing)
            return undefined;
          if (readerOwner) lease.readers.delete(readerOwner);
          else lease.readers.clear();
          if (lease.readers.size) return undefined;
          lease.closing = true;
          yield* lease.session.close();
          if (entry === lease) entry = undefined;
          return undefined;
        })
      ),
    status: (id) => run(withSession(id, status)),
    refresh: (id, input) =>
      run(
        withSession(id, (session) =>
          Effect.gen(function* () {
            yield* session.refresh();
            if (input?.installKeys) yield* installKeys(session);
            return yield* status(session);
          })
        )
      ),
    readIdentity: (input) =>
      run(
        Effect.gen(function* () {
          yield* guard(input.workspaceId, input.accountId);
          const saved = yield* offer();
          return yield* Effect.acquireUseRelease(
            host.open(saved, false, true),
            (s) =>
              s
                .ledger()
                .pipe(
                  Effect.andThen(guard(input.workspaceId, input.accountId)),
                  Effect.as({ workspaceId, genesisHash })
                ),
            (s) => s.close().pipe(Effect.orDie)
          );
        })
      ),
    recordCreated: (input) =>
      run(
        Effect.gen(function* () {
          yield* guard(input.workspaceId);
          if (input.genesisHash !== genesisHash) return yield* fail('scope-mismatch');
          if (!recordCreated) return yield* fail('unsupported');
          yield* recordCreated(input);
          yield* guard(input.workspaceId);
          return undefined;
        })
      ),
    contentStreamsToken: (id, rejectedToken, requestSnapshotFor, rpcOnly) =>
      run(
        withSession(id, (session) =>
          Effect.gen(function* () {
            yield* hasKey(session);
            if (
              (rejectedToken !== undefined &&
                (typeof rejectedToken !== 'string' || rejectedToken.length > 16384)) ||
              (requestSnapshotFor !== undefined &&
                (typeof requestSnapshotFor !== 'string' || requestSnapshotFor.length > 2048)) ||
              (rpcOnly !== undefined && rpcOnly !== true)
            )
              return yield* fail('invalid-input');
            const grant = yield* session.contentToken({
              ...(rejectedToken !== undefined ? { rejectedToken } : {}),
              ...(requestSnapshotFor !== undefined ? { requestSnapshotFor } : {}),
              ...(rpcOnly ? { rpcOnly } : {}),
            });
            const now = yield* Clock.currentTimeMillis;
            if (
              !grant ||
              typeof grant.token !== 'string' ||
              !grant.token ||
              grant.token.length > 16384 ||
              typeof grant.bucketId !== 'string' ||
              !grant.bucketId ||
              grant.bucketId === 'lody' ||
              !Number.isFinite(grant.expiresIn) ||
              grant.expiresIn <= 0 ||
              grant.expiresIn > 900 ||
              !Number.isFinite(grant.expiresAt) ||
              grant.expiresAt <= now ||
              (grant.attachmentToken !== undefined &&
                (typeof grant.attachmentToken !== 'string' ||
                  !grant.attachmentToken ||
                  grant.attachmentToken.length > 16384))
            )
              return yield* fail('invalid-input');
            yield* Effect.try({
              try: () => {
                if (new URL(grant.gatewayBaseUrl).protocol !== 'https:') throw new Error();
              },
              catch: () => fail('invalid-input'),
            });
            return { ...grant };
          })
        )
      ),
    seal: (id, source) => {
      const captured = captureSeal(source);
      return run(
        Effect.acquireUseRelease(
          Effect.fromResult(captured),
          (input) =>
            withSession(id, (session) =>
              Effect.gen(function* () {
                const descriptor = yield* room(input.room),
                  document = yield* session.document(
                    descriptor.resource,
                    descriptor.model,
                    input.epoch
                  );
                return yield* document.seal({
                  ...input,
                  additionalData: () => input.additionalData,
                });
              })
            ),
          (input) => Effect.sync(() => input.plaintext.fill(0))
        )
      );
    },
    openContent: (id, source) => {
      const captured = captureOpen(source);
      return run(
        Effect.fromResult(captured).pipe(
          Effect.flatMap((input) =>
            withSession(
              id,
              (session) =>
                Effect.gen(function* () {
                  const descriptor = yield* room(input.room),
                    document = yield* session.document(descriptor.resource, descriptor.model);
                  return yield* document.open(input);
                }),
              (bytes) => bytes.fill(0)
            )
          )
        )
      );
    },
    ledgerView: (id) =>
      run(
        withSession(id, (session) =>
          Effect.gen(function* () {
            const snapshot = yield* session.ledgerState(),
              view = snapshot.view,
              exported = yield* Effect.fromResult(exportVerifiedState(view));
            const borrowed = yield* readLocalRecords(view);
            const rows: { position: number; record: Uint8Array }[] = [];
            let previous = -1,
              bytes = 0;
            if (borrowed.length > 16384) return yield* fail('corrupt');
            for (const original of borrowed) {
              const record = original.record,
                position = original.position;
              if (
                !(record instanceof Uint8Array) ||
                record.length > 8192 ||
                (bytes += record.length) > 32 * 1024 * 1024
              )
                return yield* fail('corrupt');
              const row = { position, record: new Uint8Array(record) };
              if (
                !(row.record instanceof Uint8Array) ||
                !Number.isSafeInteger(row.position) ||
                row.position >= view.length ||
                row.record.length > 8192 ||
                row.position <= previous ||
                !Result.getOrThrow(
                  hasVerifiedCheckpoint(view, {
                    length: row.position + 1,
                    head: hashRecordBytes(row.record),
                  })
                )
              )
                return yield* fail('corrupt');
              previous = row.position;
              rows.push(row);
            }
            return {
              status: yield* status(session, snapshot),
              stateHex: toHex(exported.bytes),
              recordsHex: rows.map((row) => toHex(row.record)),
              recordPositions: rows.map((row) => row.position),
            };
          })
        )
      ),
    ingestLedgerRecords: (id, supplied) => {
      const captured = capturePage(supplied);
      return run(
        Effect.fromResult(captured).pipe(
          Effect.flatMap((page) =>
            withSession(id, (session) =>
              Effect.gen(function* () {
                if (page.workspaceId !== workspaceId || page.genesisHash !== genesisHash)
                  return yield* fail('scope-mismatch');
                const end = page.startIndex + page.recordsHex.length;
                if (
                  !Number.isSafeInteger(end) ||
                  end > page.checkpoint.length ||
                  (!page.nextCursor && end !== page.checkpoint.length)
                )
                  return yield* fail('invalid-input');
                const points = page.recordsHex.map((record, index) => ({
                  length: page.startIndex + index + 1,
                  head: hashRecordBytes(fromHex(record)),
                }));
                if (!page.nextCursor)
                  points.push({
                    length: page.checkpoint.length,
                    head: Result.getOrThrow(Bytes.recordHash(fromHex(page.checkpoint.headHash))),
                  });
                let view = yield* session.ledger();
                const contains = (candidate: LedgerView) =>
                  Effect.forEach(points, (point) =>
                    Effect.fromResult(hasVerifiedCheckpoint(candidate, point))
                  ).pipe(Effect.map((results) => results.every(Boolean)));
                if (!(yield* contains(view))) view = yield* session.refresh();
                if (!(yield* contains(view))) return yield* fail('conflict');
                // The existing feed owner persists and verifies. Relay pages never create a parallel trusted cache or advance an opaque cursor themselves.
                return yield* status(session);
              })
            )
          )
        )
      );
    },
    preparePersonalJoin: (supplied) =>
      run(
        Effect.gen(function* () {
          yield* guard(supplied.workspaceId);
          if (supplied.genesisHash !== genesisHash) return yield* fail('scope-mismatch');
          const prepared = yield* host.prepare(supplied);
          const result = yield* host.begin(supplied);
          yield* guard(supplied.workspaceId);
          return {
            pairingSessionId: prepared.pairingSessionId,
            signingPublicKey: prepared.signingPublicKey,
            status: result.status,
          };
        })
      ),
    pendingPersonalJoin: (id) =>
      run(
        Effect.gen(function* () {
          yield* guard(id);
          const saved = yield* retained();
          if (!saved) return null;
          if (saved.workspaceId !== workspaceId || saved.genesisHash !== genesisHash)
            return yield* fail('scope-mismatch');
          return { pairingSessionId: saved.pairingSessionId, offer: saved };
        })
      ),
    claimPersonalJoin: (id, pairingId) =>
      run(
        Effect.gen(function* () {
          const result = yield* host.claim(yield* retainedRequest(id, pairingId));
          yield* guard(id);
          return { ready: result.status === 'approved', status: result.status };
        })
      ),
    cancelPersonalJoin: (id, pairingId) =>
      run(
        Effect.gen(function* () {
          const result = yield* host.cancel(yield* retainedRequest(id, pairingId));
          yield* guard(id);
          if (result.status !== 'cancelled') return yield* fail('conflict');
          return { status: 'cancelled' as const };
        })
      ),
    managementState: (id) => run(withSession(id, (session) => session.managementState())),
    updateKeys: (id) =>
      run(
        withSession(id, (session) =>
          Effect.gen(function* () {
            yield* session.refresh();
            yield* installKeys(session);
            yield* session.recoverHistory();
            const pending = yield* session.resumeRotation();
            if (pending) {
              yield* session.refresh();
              yield* session.acknowledgeRotation(pending);
              if (pending.outcome !== 'Committed') return yield* fail('conflict');
            }
            if ((yield* session.ledger()).inspectState().epoch.rotationRequired) {
              const result = yield* session.rotate();
              yield* session.refresh();
              yield* session.acknowledgeRotation(result);
              if (result.outcome !== 'Committed') return yield* fail('conflict');
            }
            yield* session.keyRound();
            return undefined;
          })
        )
      ),
    revokeDevice: (id, key) =>
      run(
        withSession(id, (session) =>
          Effect.gen(function* () {
            if (!/^[0-9a-f]{64}$/.test(key)) return yield* fail('invalid-input');
            yield* finish(session, {
              _tag: 'RevokeDevice',
              target: Result.getOrThrow(Bytes.signingPublicKey(fromHex(key))),
            });
            return undefined;
          })
        )
      ),
    removeMember: (id, membership) =>
      run(
        withSession(id, (session) =>
          Effect.gen(function* () {
            if (!/^[0-9a-f]{32}$/.test(membership)) return yield* fail('invalid-input');
            const result = yield* session.removeMember(
              Result.getOrThrow(Bytes.membershipId(fromHex(membership)))
            );
            yield* session.refresh();
            yield* session.acknowledgeRotation(result);
            if (result.outcome !== 'Committed') return yield* fail('conflict');
            return undefined;
          })
        )
      ),
    setMemberRole: (id, membership, role) =>
      run(
        withSession(id, (session) =>
          Effect.gen(function* () {
            if (!/^[0-9a-f]{32}$/.test(membership) || !['admin', 'member'].includes(role))
              return yield* fail('invalid-input');
            yield* finish(session, {
              _tag: 'SetRole',
              membershipId: Result.getOrThrow(Bytes.membershipId(fromHex(membership))),
              role,
            });
            return undefined;
          })
        )
      ),
    ...(host.capabilities.rpc
      ? ({
          prepareDispatch: (id, target, input) =>
            run(withSession(id, (session) => session.prepareDispatch(target, input))),
          acceptDispatchResponse: (id, target, input, frame) =>
            run(withSession(id, (session) => session.acceptResponse(target, input, frame))),
          prepareFeatureRpc: (id, input) =>
            run(withSession(id, (session) => session.prepareFeature(input))),
          acceptFeatureRpcResponse: (id, input, frame) =>
            run(withSession(id, (session) => session.acceptFeatureResponse(input, frame))),
        } satisfies Pick<
          E2eeWorkspaceRuntime,
          | 'prepareDispatch'
          | 'acceptDispatchResponse'
          | 'prepareFeatureRpc'
          | 'acceptFeatureRpcResponse'
        >)
      : {}),
    ...(host.capabilities.machineSharing
      ? ({
          readMachineSharing: (id, machine) =>
            run(withSession(id, (session) => session.readMachineSharing(machine))),
          updateMachineSharing: (id, machine, generation, requestId, change) =>
            run(
              withSession(id, (session) =>
                session.updateMachineSharing(machine, generation, requestId, change)
              )
            ),
        } satisfies Pick<E2eeWorkspaceRuntime, 'readMachineSharing' | 'updateMachineSharing'>)
      : {}),
  };
  return Object.freeze(runtime);
});
