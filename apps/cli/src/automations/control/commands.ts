import { Clock, Effect } from 'effect';
import { randomUUID } from 'node:crypto';
import {
  getSessionRoomId,
  type MachineId,
  type RpcSecretPublicKey,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  remoteAutomationIntentSchema,
  remoteAutomationOperationSchema,
  remoteAutomationProofSchema,
  type AutomationCommand,
  type AutomationProgramContext,
  type AutomationWait,
  type RemoteAutomationIntent,
  type RemoteAutomationOperation,
  type RemoteAutomationProof,
} from '@lody/shared/automations';
import type { Lody } from '@/lib/lody';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';
import { Automations } from '../runtime/engine';
import { ManagedRunsService } from '../runtime/managed-runs';
import { TERMINAL_STATES as TERMINAL_RECEIPT_STATES } from '../storage/schema';
import { resolveAutomationCwd } from '../context/exec';
import { evaluateAutomationProgram } from '../programs/codemode';
import { configureSessionPolicies, sessionPolicySettings } from '../policies/session';
import { startDeliveryEpoch, type DeliveryCoordinator } from '../policies/delivery';
import { readSessionMeta } from '../actions/authorization';
import { actionActivity, publicActivity, workActivity } from './activities';

export type RemoteAutomationVerifier = (input: {
  intent: RemoteAutomationIntent;
  requestToken: string;
}) => Promise<{ requesterUserId: string; expiresAt: number }>;

export type AutomationControlDeps = {
  ledger: AutomationLedger;
  lody: Lody;
  authority: SessionAutomationAuthority;
  workspaceId: string;
  machineId: MachineId;
  managedRunLogs: string;
  delivery: DeliveryCoordinator;
  isClosing(): boolean;
  ownedCall<A>(body: () => Promise<A>): Promise<A>;
  runEffect<A>(effect: Effect.Effect<A, unknown, Automations | ManagedRunsService>): Promise<A>;
  verifyRemoteControl?: RemoteAutomationVerifier;
};

function publicWait(ledger: AutomationLedger, wait: AutomationWait) {
  const receipt = wait.invocationId && ledger.receipt(wait.invocationId);
  return {
    ...wait,
    ...(receipt
      ? {
          continuation: {
            id: receipt.id,
            state: receipt.state,
            reason: receipt.reason,
            turnId: receipt.turnId,
            attempts: receipt.attempts,
            retryAt: receipt.retryAt,
          },
        }
      : {}),
  };
}

export function createAutomationController(deps: AutomationControlDeps) {
  const { ledger, lody, authority, workspaceId, machineId, managedRunLogs, delivery } = deps;
  const remoteNonce = randomUUID();
  const consumedRemoteRequests = new Map<string, number>();

  const liveWaits = (userId: string | undefined, sessionId: string | undefined) =>
    ledger.waits(userId, sessionId).filter((wait) => {
      if (['waiting', 'checking', 'failed'].includes(wait.state)) return true;
      if (wait.state !== 'matched') return false;
      const receipt = wait.invocationId && ledger.receipt(wait.invocationId);
      return !receipt || !TERMINAL_RECEIPT_STATES.has(receipt.state);
    });

  const requireSessionMeta = async (sessionId: string): Promise<SessionMeta> => {
    const read = await readSessionMeta(lody.documentManager, sessionId as SessionId);
    if (read.status !== 'ok' || read.meta.machineId !== machineId)
      throw new Error('AUTOMATION_SESSION_UNAVAILABLE');
    if (read.meta.isArchived) throw new Error('AUTOMATION_SESSION_ARCHIVED');
    return read.meta;
  };

  const assertCanEdit = async (sessionId: string, userId: string): Promise<void> => {
    const access = await authority.canEdit(sessionId as SessionId, userId);
    if (access === 'no') throw new Error('AUTOMATION_PERMISSION_DENIED');
    if (access === 'unknown') throw new Error('AUTOMATION_PERMISSION_UNCONFIRMED');
  };

  const sessionContext = async (
    sessionId: string,
    userId: string
  ): Promise<{ context: AutomationProgramContext; meta: SessionMeta }> => {
    const meta = await requireSessionMeta(sessionId);
    await assertCanEdit(sessionId, userId);
    return { context: { sessionId, workspaceId, now: Date.now() }, meta };
  };

  const executeEffect = Effect.fn('Automations.command')(function* (
    command: AutomationCommand,
    principal: string,
    requesterSessionId?: string
  ) {
    const runtime = yield* Automations;
    const managedRuns = yield* ManagedRunsService;
    const now = yield* Clock.currentTimeMillis;
    const promise = <A>(body: () => Promise<A>) =>
      Effect.tryPromise({ try: body, catch: (cause) => cause }).pipe(Effect.uninterruptible);
    const assertReadable = (wait: AutomationWait, userId: string) =>
      wait.ownerMachineId !== machineId
        ? Effect.fail(new Error('AUTOMATION_NOT_FOUND'))
        : promise(() => assertCanEdit(wait.sessionId, userId));

    switch (command.type) {
      case 'register': {
        const sessionId = command.sessionId ?? requesterSessionId;
        if (!sessionId) return yield* Effect.fail(new Error('AUTOMATION_SESSION_REQUIRED'));
        const { context } = yield* promise(() => sessionContext(sessionId, principal));
        if (command.expiresAt !== undefined && command.expiresAt <= now)
          return yield* Effect.fail(new Error('AUTOMATION_ALREADY_EXPIRED'));
        yield* evaluateAutomationProgram(
          command.program,
          context,
          () => Effect.fail(new Error('AUTOMATION_VALIDATION_HAS_NO_READS')),
          true
        );
        if (deps.isClosing()) return yield* Effect.fail(new Error('AUTOMATION_OWNER_CLOSING'));
        const { type: _type, sessionId: _session, ...registration } = command;
        const { wait, superseded } = ledger.registerWait(registration, sessionId, principal, now);
        for (const old of superseded) {
          yield* runtime.cancel(old.invocationId ?? old.id).pipe(Effect.ignore);
        }
        yield* runtime.wake;
        return {
          ...publicWait(ledger, wait),
          supersededIds: superseded.map((old) => old.id),
          activeWaits: ledger
            .waits(undefined, sessionId)
            .filter((item) => ['waiting', 'checking', 'matched'].includes(item.state))
            .map((item) => ({
              id: item.id,
              key: item.key ?? null,
              state: item.state,
              reason: item.reason ?? null,
            })),
        };
      }
      case 'run': {
        const sessionId = command.sessionId ?? requesterSessionId;
        if (!sessionId) return yield* Effect.fail(new Error('AUTOMATION_SESSION_REQUIRED'));
        yield* promise(() => sessionContext(sessionId, principal));
        const root = yield* promise(() => lody.resolveAutomationWorkdir(sessionId as SessionId));
        if (!root) return yield* Effect.fail(new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'));
        yield* resolveAutomationCwd(root, command.cwd);
        if (deps.isClosing()) return yield* Effect.fail(new Error('AUTOMATION_OWNER_CLOSING'));
        const { type: _type, sessionId: _session, ...run } = command;
        const wait = ledger.registerRun(run, sessionId, principal, managedRunLogs, now);
        yield* runtime.wake;
        return publicWait(ledger, wait);
      }
      case 'settings':
      case 'configure': {
        const sessionId = command.sessionId ?? requesterSessionId;
        if (!sessionId) return yield* Effect.fail(new Error('AUTOMATION_SESSION_REQUIRED'));
        const { meta } = yield* promise(() => sessionContext(sessionId, principal));
        if (command.type === 'configure') {
          const currentTurn =
            command.settings.recoverCapacity === true ? meta.latestUserMsgId : undefined;
          yield* delivery.withStatusLock(async (lockedNow) => {
            const previous = sessionPolicySettings(ledger, sessionId);
            const wasRecoveryEnabled = previous.recoverCapacity === true;
            const enablesDelivery =
              typeof command.settings.autoDeliver === 'object' &&
              typeof previous.autoDeliver !== 'object';
            ledger.configureSession(
              () => {
                if (enablesDelivery) startDeliveryEpoch(ledger, sessionId, lockedNow);
                configureSessionPolicies(ledger, sessionId, principal, command.settings, lockedNow);
              },
              sessionId,
              !wasRecoveryEnabled ? currentTurn : undefined,
              lockedNow
            );
            if (command.settings.autoDeliver === false) {
              await lody.documentManager.repo.upsertDocMeta(
                getSessionRoomId(sessionId as SessionId),
                { autoDelivery: null }
              );
            }
          });
          if (command.settings.autoDeliver === false) {
            yield* delivery.cancelOutstandingStep(sessionId, (id) => runtime.cancel(id));
          }
        }
        yield* runtime.wake;
        return sessionPolicySettings(ledger, sessionId);
      }
      case 'list': {
        const sessionId = command.sessionId ?? requesterSessionId;
        if (sessionId) yield* promise(() => assertCanEdit(sessionId, principal));
        return liveWaits(sessionId ? undefined : principal, sessionId).map((wait) =>
          publicWait(ledger, wait)
        );
      }
      case 'show': {
        const wait = ledger.wait(command.id);
        if (!wait) return yield* Effect.fail(new Error('AUTOMATION_NOT_FOUND'));
        yield* assertReadable(wait, principal);
        return publicWait(ledger, wait);
      }
      case 'activities': {
        const sessionId = command.sessionId ?? requesterSessionId;
        if (sessionId) yield* promise(() => assertCanEdit(sessionId, principal));
        const page = ledger.activityPage(
          sessionId ? undefined : principal,
          sessionId,
          command.limit,
          command.before
        );
        return { ...page, items: page.items.map(publicActivity) };
      }
      case 'cancel': {
        const wait = ledger.wait(command.id);
        if (wait) {
          yield* assertReadable(wait, principal);
          yield* runtime.cancel(wait.id);
          if (wait.run) yield* managedRuns.stop(wait.id);
          const current = ledger.wait(wait.id);
          return current && publicWait(ledger, current);
        }
        const receipt = ledger.receipt(command.id);
        if (!receipt) {
          const work = ledger.work(command.id);
          if (!work) return yield* Effect.fail(new Error('AUTOMATION_NOT_FOUND'));
          yield* promise(() => assertCanEdit(work.sessionId, principal));
          ledger.putWork({ ...work, state: 'cancelled', updatedAt: now });
          if (work.invocationId) yield* runtime.cancel(work.invocationId);
          yield* runtime.wake;
          const current = ledger.work(command.id);
          return current ? workActivity(current) : undefined;
        }
        yield* promise(() => assertCanEdit(receipt.sessionId, principal));
        yield* runtime.cancel(command.id);
        const current = ledger.receipt(command.id);
        return current ? actionActivity(current) : undefined;
      }
    }
    return yield* Effect.fail(new Error('AUTOMATION_COMMAND_UNSUPPORTED'));
  });

  const execute = (
    command: AutomationCommand,
    principal: string,
    requesterSessionId?: string
  ): Promise<unknown> => deps.runEffect(executeEffect(command, principal, requesterSessionId));

  return {
    sessionContext,
    execute,
    remoteControlNonce: deps.verifyRemoteControl ? remoteNonce : undefined,
    remoteControl: (input: {
      sessionId: string;
      requesterUserId: string;
      operation: RemoteAutomationOperation;
      proof: RemoteAutomationProof;
      responseKey: RpcSecretPublicKey;
    }) =>
      deps.ownedCall(async () => {
        const verify = deps.verifyRemoteControl;
        if (!verify) throw new Error('AUTOMATION_REMOTE_AUTH_UNAVAILABLE');
        const operation = remoteAutomationOperationSchema.parse(input.operation);
        const proof = remoteAutomationProofSchema.parse(input.proof);
        if (proof.runtimeNonce !== remoteNonce) throw new Error('AUTOMATION_RUNTIME_CHANGED');
        for (const [id, expiresAt] of consumedRemoteRequests)
          if (expiresAt <= Date.now()) consumedRemoteRequests.delete(id);
        if (consumedRemoteRequests.has(proof.requestId)) throw new Error('AUTOMATION_REQUEST_USED');
        await requireSessionMeta(input.sessionId);
        const verified = await verify({
          intent: remoteAutomationIntentSchema.parse({
            workspaceId,
            machineId,
            sessionId: input.sessionId,
            requesterUserId: input.requesterUserId,
            runtimeNonce: remoteNonce,
            requestId: proof.requestId,
            responseKey: input.responseKey,
            operation,
          }),
          requestToken: proof.requestToken,
        });
        const requester = verified.requesterUserId;
        if (requester !== input.requesterUserId || verified.expiresAt <= Date.now())
          throw new Error('AUTOMATION_PERMISSION_DENIED');
        if (consumedRemoteRequests.has(proof.requestId)) throw new Error('AUTOMATION_REQUEST_USED');
        consumedRemoteRequests.set(proof.requestId, verified.expiresAt);
        await sessionContext(input.sessionId, requester);
        if (operation.type === 'cancel') {
          const wait = ledger.wait(operation.id);
          if (!wait || wait.sessionId !== input.sessionId) throw new Error('AUTOMATION_NOT_FOUND');
          await execute({ type: 'cancel', id: operation.id }, requester);
          return { type: 'cancel' as const };
        }
        if (operation.type === 'list') {
          const all = liveWaits(undefined, input.sessionId);
          const start = operation.after
            ? all.findIndex((wait) => wait.id === operation.after) + 1
            : 0;
          if (operation.after && start === 0) throw new Error('AUTOMATION_CURSOR_INVALID');
          const waits = [];
          let size = 0;
          for (const wait of all.slice(start)) {
            const view = publicWait(ledger, wait);
            const item = {
              id: view.id,
              sessionId: view.sessionId,
              reason: view.reason,
              state: view.state,
              nextCheckAt: view.nextCheckAt,
              expiresAt: view.expiresAt,
              ...(view.continuation
                ? {
                    continuation: {
                      state: view.continuation.state,
                      reason: view.continuation.reason,
                    },
                  }
                : {}),
            };
            const bytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
            if (waits.length && size + bytes > 24_000) break;
            waits.push(item);
            size += bytes;
          }
          const next = start + waits.length < all.length ? waits.at(-1)?.id : undefined;
          return { type: 'list' as const, waits, ...(next ? { next } : {}) };
        }
        const settings = await execute({ ...operation, sessionId: input.sessionId }, requester);
        return { type: 'settings' as const, settings };
      }),
  };
}
