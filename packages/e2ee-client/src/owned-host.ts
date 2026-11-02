import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Scope,
  Semaphore,
} from 'effect';
import { makePersonalDeviceHost } from './host';
import { fail } from './errors';
import { handoffOwnedResult } from './handoff';
import { PersonalHostPlatform, PersonalHostRemote } from './platform';
import {
  ClientInstallationStore,
  ClientCustodyWriter,
  ClientPairingOriginalStore,
} from '@lody/e2ee-core/services';
import { sameBinding } from './installation';

/** Real, resource-owning ports built inside the retained host scope. */
export type PersonalHostPorts = Exclude<
  Effect.Services<ReturnType<typeof makePersonalDeviceHost>>,
  Scope.Scope
>;
/** Trusted recovery handle. Retain it on incomplete shutdown; it exposes no secrets or general execution capability. */
export interface PersonalCloseOwner {
  /** Actual drain completion, including a failed drain; never inferred from a deadline. */
  settled(): Effect.Effect<boolean>;
  /** Explicit recovery wait for actual settlement; unlike product close, this has no deadline. */
  awaitSettled(): Effect.Effect<void, unknown>;
}
/** Product close did not complete. This owner retains the work and its resource scope. */
export class PersonalCloseIncomplete extends Data.TaggedError('PersonalCloseIncomplete')<{
  readonly code: 'close-incomplete';
  readonly owner: PersonalCloseOwner;
}> {}
/** One shared, finite wait budget per close attempt's retained drain. */
export const PERSONAL_CLOSE_BUDGET_MS = 5000;
type RawHost = Effect.Success<ReturnType<typeof makePersonalDeviceHost>>;
type RawSession = Effect.Success<ReturnType<RawHost['open']>>;
type RawDocument = Effect.Success<ReturnType<RawSession['document']>>;
type Ticket = {
  readonly wait: Effect.Effect<void, unknown>;
  readonly drain: Effect.Effect<void, unknown>;
};
type Session = { readonly raw: RawSession; closing: boolean; ticket?: Ticket };

/**
 * Own the complete port Layer and scoped host separately from the caller's Scope.
 * Close fences immediately; a bounded waiter reports incomplete while the retained
 * owner continues actual drain. Keep the incomplete owner's full failure for recovery.
 * Supply resource-owning Layers; borrowed ports must outlive confirmed retirement.
 */
export const makeOwnedPersonalDeviceHost = Effect.fnUntraced(function* <E>(
  ports: Layer.Layer<PersonalHostPorts, E>
) {
  const parent = yield* Scope.Scope;
  const programScope = yield* Scope.make(),
    tasksScope = yield* Scope.make(),
    controlScope = yield* Scope.make();
  const tasks = yield* Scope.provide(FiberSet.make(), tasksScope);
  const closeClock = yield* Clock.Clock;
  const ticketSetup = yield* Semaphore.make(1);
  const sessions = new Set<Session>();
  let host: RawHost | undefined,
    closing = false,
    rootTicket: Ticket | undefined;
  const guard = (session?: Session) =>
    Effect.suspend(() => (closing || session?.closing ? Effect.fail(fail('closed')) : Effect.void));
  const ticket = Effect.fnUntraced(function* (work: Effect.Effect<void, unknown>) {
    const expired = yield* Deferred.make<void>();
    const raw = yield* Effect.forkIn(Effect.uninterruptible(work), controlScope);
    // Canceling these observers never interrupts the retained physical drain.
    yield* Effect.forkIn(
      Effect.raceFirst(
        Effect.interruptible(Fiber.await(raw).pipe(Effect.asVoid)),
        Effect.interruptible(
          Effect.sleep(PERSONAL_CLOSE_BUDGET_MS).pipe(
            Effect.andThen(Deferred.succeed(expired, undefined))
          )
        )
      ).pipe(Effect.provideService(Clock.Clock, closeClock)),
      controlScope
    );
    const recovery: PersonalCloseOwner = Object.freeze({
      settled: () => Effect.sync(() => raw.pollUnsafe() !== undefined),
      awaitSettled: () => Fiber.join(raw),
    });
    const wait = Effect.suspend(() => {
      const completed = raw.pollUnsafe();
      if (completed) return completed;
      return Effect.raceFirst(
        Effect.interruptible(Fiber.join(raw)),
        Effect.interruptible(
          Deferred.await(expired).pipe(
            Effect.andThen(
              Effect.fail(
                new PersonalCloseIncomplete({ code: 'close-incomplete', owner: recovery })
              )
            )
          )
        )
      );
    });
    return { wait, drain: Fiber.join(raw) } satisfies Ticket;
  });
  const startSessionClose = Effect.fnUntraced(
    function* (session: Session) {
      session.closing = true;
      if (!session.ticket) {
        session.ticket = yield* ticket(session.raw.close());
        // Removal waits for actual successful cleanup, including late settlement.
        yield* Effect.forkIn(
          session.ticket.drain.pipe(
            Effect.tap(() => Effect.sync(() => sessions.delete(session))),
            Effect.ignore
          ),
          controlScope
        );
      }
      return session.ticket;
    },
    ticketSetup.withPermit,
    Effect.uninterruptible
  );
  const closeSession = (session: Session) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(startSessionClose(session), (entry) => restore(entry.wait))
    );
  const close = () =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        closing = true;
        for (const session of sessions) session.closing = true;
        const entry = yield* ticketSetup.withPermit(
          Effect.gen(function* () {
            rootTicket ??= yield* ticket(
              Effect.gen(function* () {
                // Start every sibling before waiting. A concurrent child close shares its actual drain.
                for (const session of sessions) yield* startSessionClose(session);
                const outcomes: Exit.Exit<void, unknown>[] = [
                  yield* Effect.exit(Scope.close(tasksScope, Exit.void)),
                ];
                // Any late open result was registered before its task could release ownership.
                for (const session of sessions)
                  outcomes.push(yield* Effect.exit((yield* startSessionClose(session)).drain));
                const reasons = outcomes.flatMap((result) =>
                  Exit.isFailure(result) ? result.cause.reasons : []
                );
                if (reasons.length) return yield* Effect.failCause(Cause.fromReasons(reasons));
                if (host) yield* host.close();
                yield* Scope.close(programScope, Exit.void);
                return undefined;
              })
            );
            return rootTicket;
          })
        );
        return yield* restore(entry.wait);
      })
    );
  yield* Scope.provide(
    Effect.addFinalizer(() => close().pipe(Effect.orDie)),
    parent
  );
  const run = <A, F>(
    operation: Effect.Effect<A, F>,
    session?: Session,
    dispose?: (value: A) => void
  ) =>
    Effect.gen(function* () {
      yield* guard(session);
      const use = (value: A) => guard(session).pipe(Effect.as(value));
      if (dispose) return yield* handoffOwnedResult(tasks, operation, guard(session), dispose);
      const fiber = yield* FiberSet.run(tasks, operation.pipe(Effect.flatMap(use)));
      return yield* Fiber.join(fiber);
    });
  const ownSession = (raw: RawSession) =>
    Effect.sync(() => {
      const state: Session = { raw, closing: false };
      sessions.add(state);
      const call = <A, F>(operation: Effect.Effect<A, F>, dispose?: (value: A) => void) =>
        run(operation, state, dispose);
      return Object.freeze({
        binding: raw.binding,
        close: () => closeSession(state),
        ledger: () => call(raw.ledger()),
        refresh: () => call(raw.refresh()),
        keyRound: () => call(raw.keyRound()),
        status: () => call(raw.status()),
        execute: (...args: Parameters<RawSession['execute']>) => call(raw.execute(...args)),
        resume: () => call(raw.resume()),
        acknowledge: (...args: Parameters<RawSession['acknowledge']>) =>
          call(raw.acknowledge(...args)),
        removeMember: (...args: Parameters<RawSession['removeMember']>) =>
          call(raw.removeMember(...args)),
        rotate: () => call(raw.rotate()),
        recoverHistory: () => call(raw.recoverHistory()),
        resumeRotation: () => call(raw.resumeRotation()),
        contentToken: (...args: Parameters<RawSession['contentToken']>) =>
          call(raw.contentToken(...args)),
        managementState: () => call(raw.managementState()),
        readMachineSharing: (...args: Parameters<RawSession['readMachineSharing']>) =>
          call(raw.readMachineSharing(...args)),
        updateMachineSharing: (...args: Parameters<RawSession['updateMachineSharing']>) =>
          call(raw.updateMachineSharing(...args)),
        ledgerState: () => call(raw.ledgerState()),
        acknowledgeRotation: (...args: Parameters<RawSession['acknowledgeRotation']>) =>
          call(raw.acknowledgeRotation(...args)),
        prepareDispatch: (...args: Parameters<RawSession['prepareDispatch']>) =>
          call(raw.prepareDispatch(...args)),
        acceptResponse: (...args: Parameters<RawSession['acceptResponse']>) =>
          call(raw.acceptResponse(...args)),
        prepareFeature: (...args: Parameters<RawSession['prepareFeature']>) =>
          call(raw.prepareFeature(...args)),
        acceptFeatureResponse: (...args: Parameters<RawSession['acceptFeatureResponse']>) =>
          call(raw.acceptFeatureResponse(...args)),
        document: (...args: Parameters<RawSession['document']>) =>
          call(
            raw.document(...args).pipe(
              Effect.map((document) =>
                Object.freeze({
                  seal: (...input: Parameters<RawDocument['seal']>) =>
                    call(document.seal(...input)),
                  open: (...input: Parameters<RawDocument['open']>) =>
                    call(document.open(...input), (body) => body.fill(0)),
                  openAuthenticated: (...input: Parameters<RawDocument['openAuthenticated']>) =>
                    call(document.openAuthenticated(...input), (opened) =>
                      opened.plaintext.fill(0)
                    ),
                })
              )
            )
          ),
      });
    });
  const acquire = run(
    Effect.gen(function* () {
      const context = Context.pick(
        PersonalHostPlatform,
        PersonalHostRemote,
        ClientInstallationStore,
        ClientCustodyWriter,
        ClientPairingOriginalStore
      )(yield* Layer.buildWithScope(ports, programScope));
      const platform = Context.get(context, PersonalHostPlatform);
      const externalDrain = platform.drainOld?.bind(platform);
      const ownedPlatform = externalDrain
        ? {
            ...platform,
            custody: platform.custody.bind(platform),
            control: platform.control.bind(platform),
            keys: platform.keys.bind(platform),
            evidence: platform.evidence.bind(platform),
            rpc: platform.rpc?.bind(platform),
            contentToken: platform.contentToken?.bind(platform),
            machineSharing: platform.machineSharing?.bind(platform),
            drainOld: Effect.fnUntraced(function* (binding: Parameters<typeof externalDrain>[0]) {
              const matching = [...sessions].filter((session) =>
                sameBinding(session.raw.binding, binding)
              );
              const entries = yield* Effect.forEach(matching, startSessionClose);
              for (const entry of entries) yield* entry.wait;
              yield* externalDrain(binding);
            }),
          }
        : platform;
      host = yield* makePersonalDeviceHost().pipe(
        Effect.provide(context.pipe(Context.add(PersonalHostPlatform, ownedPlatform))),
        Scope.provide(programScope)
      );
    })
  );
  yield* acquire.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? close().pipe(Effect.orDie) : Effect.void))
  );
  return Object.freeze({
    close,
    scope: host!.scope,
    capabilities: host!.capabilities,
    prepare: (...args: Parameters<RawHost['prepare']>) => run(host!.prepare(...args)),
    begin: (...args: Parameters<RawHost['begin']>) => run(host!.begin(...args)),
    claim: (...args: Parameters<RawHost['claim']>) => run(host!.claim(...args)),
    cancel: (...args: Parameters<RawHost['cancel']>) => run(host!.cancel(...args)),
    open: (...args: Parameters<RawHost['open']>) =>
      run(
        Effect.acquireUseRelease(
          host!.open(...args),
          (raw) => ownSession(raw),
          (raw, result) => (Exit.isFailure(result) ? raw.close().pipe(Effect.orDie) : Effect.void)
        )
      ),
  });
});
