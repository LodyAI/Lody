import { Cause, Effect, Exit, Scope } from 'effect';
import {
  getServerNow,
  createLoroStreamsTokenProviderLegacy,
  type LoroStreamsTokenProvider,
  type MachineId,
  type SessionId,
  type SessionStatus,
  type WorkspaceId,
} from '@lody/shared';
import type { ApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  LoginShellCacheShutdownFailed,
  recoverLoginShellCacheShutdown,
} from '@lody/shared/node/login-shell-env';
import {
  WorkspacePresenceOwners,
  PresenceUnavailable,
  PresenceReleaseFailed,
  recoverWorkspacePresenceShutdown,
  type PresenceRemoteOptions,
  type WorkspacePresence,
} from './workspace-presence';

/** Complete owning Cause, including every retained cleanup owner, crosses this door. */
export class WorkspacePresenceLegacyFailure extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super('Workspace presence operation failed');
    this.name = 'WorkspacePresenceLegacyFailure';
  }
}
let application: ApplicationRuntime<WorkspacePresenceOwners, never> | undefined;

/** @deprecated Application-entry binding; it owns the runtime, never the presence service. */
export const bindWorkspacePresenceApplicationLegacy = (
  owner: ApplicationRuntime<WorkspacePresenceOwners, never>
): void => {
  if (application && !application.isReleased())
    throw new Error('Presence application owner already bound');
  application = owner;
};

/** @deprecated One execution facade for doc/bridge and current session/relay consumers.
 * Delete after those owners compose WorkspacePresenceOwners directly.
 */
export const createCliPresenceRuntimeLegacy = async (workspaceId: WorkspaceId) => {
  const root = application;
  if (!root || root.isClosing()) throw new Error('Presence application owner unavailable');
  const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
    const exit = await root.runtime.runPromiseExit(effect, { signal });
    if (Exit.isFailure(exit)) throw new WorkspacePresenceLegacyFailure(exit.cause);
    return exit.value;
  };
  const acquired = await root.runtime.runPromiseExit(
    Effect.flatMap(WorkspacePresenceOwners, (owners) => owners.create(workspaceId))
  );
  if (Exit.isFailure(acquired)) throw new WorkspacePresenceLegacyFailure(acquired.cause);
  const owner: WorkspacePresence = acquired.value;
  return {
    createStreamsTokens: async (
      factory: Effect.Effect<LoroStreamsTokenProvider, never, Scope.Scope>
    ) => {
      const native = await run(owner.createTokenProvider(factory));
      return {
        native,
        legacy: createLoroStreamsTokenProviderLegacy({ provider: native, executor: root.runtime }),
      };
    },
    attachStreams: (options: PresenceRemoteOptions) => run(owner.attach(options)),
    detachStreams: () => run(owner.detach),
    stop: () => run(owner.stop),
    retryCleanup: () => run(owner.retryCleanup),
    waitUntilJoined: async (timeoutMs: number, signal?: AbortSignal): Promise<boolean> => {
      const exit = await root.runtime.runPromiseExit(owner.waitUntilJoined(timeoutMs), { signal });
      if (Exit.isSuccess(exit)) return true;
      // Only an isolated bootstrap/unavailable failure projects to unknown liveness.
      // Interruption, defects and mixed cleanup Causes stay observable.
      const reason = exit.cause.reasons[0];
      if (
        exit.cause.reasons.length === 1 &&
        reason &&
        Cause.isFailReason(reason) &&
        reason.error instanceof PresenceUnavailable
      )
        return false;
      throw new WorkspacePresenceLegacyFailure(exit.cause);
    },
    encodeLocalOriginPresence: () => owner.replica.encodeLocalOriginPresence(),
    subscribeLocalOriginPresence: (listener: () => void) =>
      owner.replica.subscribeLocalOriginPresence(listener),
    getPresenceStates: () => owner.replica.getPresenceStates(),
    subscribe: owner.replica.subscribe.bind(owner.replica),
    setMachineOnline: (machineId: MachineId) =>
      owner.replica.setMachineOnline(machineId, getServerNow()),
    setSessionPresence: (args: {
      sessionId: SessionId;
      machineId: MachineId | undefined;
      status: SessionStatus | undefined;
    }) => owner.replica.setSessionPresence(args, getServerNow()),
    clearSessionPresence: (sessionId: SessionId) => owner.replica.clearSessionPresence(sessionId),
  };
};
export type CliPresenceRuntimeLegacy = Awaited<ReturnType<typeof createCliPresenceRuntimeLegacy>>;

/** The CLI root owns both services; recovery keeps each transferred domain owner. */
export const recoverCliPresenceApplicationShutdown = Effect.fnUntraced(function* (
  cause: Cause.Cause<unknown>
) {
  const exits = yield* Effect.forEach(
    cause.reasons,
    (reason) => {
      const single = Cause.fromReasons([reason]);
      if (Cause.isDieReason(reason) && reason.defect instanceof LoginShellCacheShutdownFailed)
        return recoverLoginShellCacheShutdown(single).pipe(Effect.exit);
      const error = Cause.isDieReason(reason)
        ? reason.defect
        : Cause.isFailReason(reason)
          ? reason.error
          : undefined;
      return (
        error instanceof PresenceReleaseFailed
          ? recoverWorkspacePresenceShutdown(single)
          : Effect.failCause(single)
      ).pipe(Effect.exit);
    },
    { concurrency: 'unbounded' }
  );
  const failures = exits.filter(Exit.isFailure);
  if (failures.length)
    return yield* Effect.failCause(failures.map((failed) => failed.cause).reduce(Cause.combine));
  return undefined;
});
