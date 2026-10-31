import { readAutomationContext } from './context/reads-legacy';
import { observeWorkflows, checkWorkflowEvidence } from './sources/workflows';
import { publicActivity, actionActivity, workActivity } from './control/activities';
import { Clock, Effect, Layer, ManagedRuntime } from 'effect';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  automationCommandSchema,
  remoteAutomationOperationSchema,
  remoteAutomationIntentSchema,
  remoteAutomationProofSchema,
  type AutomationCommand,
  type AutomationCondition,
  type AutomationEvent,
  type AutomationReceipt,
  type AutomationWait,
  type AutomationProgramContext,
  type ConditionObservation,
  type RemoteAutomationIntent,
  type RemoteAutomationProof,
  type RemoteAutomationOperation,
} from '@lody/shared/automations';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionMeta,
  type SessionId,
  type AgentConfigId,
} from '@lody/shared';
import {
  configureSessionPolicies,
  sessionPolicySettings,
  upgradeCapacityPolicies,
} from './policies/session';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import type { Logger } from '@/utils/logger';
import { createSessionBackend } from '@/session/session-backend';
import { AutomationLedger, automationIdentity } from './storage/ledger';
import { Automations, AutomationHost } from './runtime/engine';
import { evaluateCapacity } from './runtime/capacity';
import { evaluateAutomationProgram } from './programs/codemode';
import { AutomationSessionActionsLegacy } from './actions/session-actions-legacy';
import { retainsAutomationGrant, matchesPreparedOrigin } from './actions/authorization';
import { observeCapacity } from './sources/capacity';
import { reconcileSessionTurnsLegacy } from './sources/sessions-legacy';
import { providerBindingFingerprint } from '@/session/automation-observations';
import { observePullRequests } from './sources/pull-requests';
import type { PrPollerWorkspaceHandle } from '@/lib/pr-poller/pr-poller-workspace';
import { dispatchQuotaSchedule } from './compat/quota-schedule';
import type { ScheduleRun } from '@/lib/schedules/schedule-store';
import type { PreparedSessionInput } from '@/lib/prepared-session-input';

export type AutomationWorkspaceHandle = Awaited<ReturnType<typeof createAutomationWorkspaceLegacy>>;

/** Workspace/Fleet application boundary. Dispose before Session owners or their repo. */
export async function createAutomationWorkspaceLegacy(options: {
  lody: Lody;
  hasUncertainLegacyQuota(sessionId: SessionId): boolean;
  auth: AuthContext;
  workspace: WorkspaceSummary;
  logger: Logger;
  verifyRemoteControl?: (input: {
    intent: RemoteAutomationIntent;
    requestToken: string;
  }) => Promise<{ requesterUserId: string; expiresAt: number }>;
}) {
  const { lody, auth, workspace, logger } = options;
  const ledger = new AutomationLedger(
    {
      kind: 'disk',
      path: path.join(
        getLodyDataDir(),
        'automations',
        `${automationIdentity(auth.machineId, workspace.id)}.sqlite`
      ),
    },
    workspace.id,
    auth.machineId
  );
  try {
    upgradeCapacityPolicies(ledger, auth.userId, Date.now());
  } catch (error) {
    ledger.close();
    throw error;
  }
  const authority = lody.getAutomationSessionAuthority();
  const remoteNonce = randomUUID();
  const consumedRemoteRequests = new Map<string, number>();
  let closing = false;
  const observationWork = new Set<Promise<unknown>>();
  const ownedCall = <A>(body: () => Promise<A>): Promise<A> => {
    if (closing) return Promise.reject(new Error('AUTOMATION_OWNER_CLOSING'));
    const owned = body();
    observationWork.add(owned);
    void owned.then(
      () => observationWork.delete(owned),
      () => observationWork.delete(owned)
    );
    return owned;
  };
  const observe = (body: () => Promise<void>) => (closing ? Promise.resolve() : ownedCall(body));
  const condition = async (
    spec: AutomationCondition,
    receipt: AutomationReceipt
  ): Promise<ConditionObservation> => {
    const parameters = spec.parameters;
    switch (spec.kind) {
      case 'automation.wait.ready': {
        const wait =
          typeof parameters.waitId === 'string' ? ledger.wait(parameters.waitId) : undefined;
        if (!wait || wait.state !== 'matched' || wait.invocationId !== receipt.id)
          return { value: 'no', reason: 'wait_revoked' };
        return { value: 'yes', reason: 'wait_matched' };
      }
      case 'session.group.settled':
        if (typeof parameters.rootId !== 'string') throw new Error('AUTOMATION_CONDITION_INVALID');
        return authority.settled(
          parameters.rootId as SessionId,
          receipt.rule.ownerUserId,
          receipt.id
        );
      case 'session.turn.finalized': {
        if (typeof parameters.sessionId !== 'string' || typeof parameters.turnId !== 'string')
          throw new Error('AUTOMATION_CONDITION_INVALID');
        const doc = await lody.documentManager.getOrCreateSessionDoc(
          parameters.sessionId as SessionId
        );
        const backend = await createSessionBackend(doc);
        const read = await backend.readTurn(parameters.turnId);
        if (read.state !== 'ready') return { value: 'unknown', reason: 'turn_unavailable' };
        const ended =
          ['handled', 'failed', 'canceled'].includes(read.turn.status ?? '') ||
          read.turn.finished === true;
        return {
          value:
            ended && !lody.hasAutomationSessionWork(parameters.sessionId as SessionId)
              ? 'yes'
              : 'no',
          reason: 'turn_finalization',
        };
      }
      case 'github.pr.is_merged':
        if (typeof parameters.prUrl !== 'string') throw new Error('AUTOMATION_CONDITION_INVALID');
        return actions.currentPr(receipt, parameters.prUrl);
      case 'provider.capacity.can_dispatch': {
        if (typeof parameters.bindingId !== 'string')
          throw new Error('AUTOMATION_CONDITION_INVALID');
        const bindingId = parameters.bindingId;
        const recovery =
          receipt.rule.handler.kind === 'policy' &&
          receipt.rule.handler.policy === 'recover-capacity';
        const workRef = receipt.intent.action.parameters.input;
        const work =
          recovery &&
          workRef &&
          typeof workRef === 'object' &&
          !Array.isArray(workRef) &&
          typeof workRef.ref === 'string'
            ? ledger.work(workRef.ref)
            : undefined;
        const recoveryBinding =
          work &&
          work.bindingId === bindingId &&
          work.sessionId === receipt.rule.scope.sessionId &&
          work.ownerUserId === receipt.rule.ownerUserId;
        if (
          !recoveryBinding &&
          ![receipt.rule.grants, ledger.rule(receipt.rule.id)?.grants].every((grant) =>
            grant?.bindingIds.includes(bindingId)
          )
        )
          return { value: 'no', reason: 'capacity_binding_not_granted' };
        const config = await lody.documentManager.getAgentConfigForMachineLaunch(
          bindingId as AgentConfigId,
          auth.machineId
        );
        if (!config) return { value: 'unknown', reason: 'capacity_binding_unavailable' };
        const fingerprint = providerBindingFingerprint(config);
        const modelId = typeof parameters.modelId === 'string' ? parameters.modelId : undefined;
        const read = () => ledger.capacity(bindingId, modelId) ?? ledger.capacity(bindingId);
        let observed = evaluateCapacity(read(), { bindingId, fingerprint, modelId }, Date.now());
        if (observed.value === 'unknown') {
          await authority.refreshCapacity(bindingId);
          observed = evaluateCapacity(read(), { bindingId, fingerprint, modelId }, Date.now());
        }
        return observed;
      }
      default:
        return { value: 'unknown', reason: `condition_unsupported:${spec.kind}` };
    }
  };
  const recheck = async (receipt: AutomationReceipt): Promise<ConditionObservation> => {
    const authorization = await actions.authorize(receipt);
    if (authorization.value !== 'yes') return authorization;
    if (receipt.intent.guard) {
      const guard = await condition(receipt.intent.guard, receipt);
      if (guard.value !== 'yes') return guard;
    }
    if (receipt.intent.condition && !['queued', 'running', 'unknown'].includes(receipt.state)) {
      const predicate = await condition(receipt.intent.condition, receipt);
      if (predicate.value !== 'yes') return predicate;
    }
    return { value: 'yes', reason: 'authorized' };
  };
  const actions = new AutomationSessionActionsLegacy({
    ...options,
    ledger,
    condition: recheck,
    capacity: (bindingId, modelId, receipt) =>
      condition(
        {
          kind: 'provider.capacity.can_dispatch',
          parameters: { bindingId, ...(modelId ? { modelId } : {}) },
        },
        receipt
      ),
  });
  const sessionContext = async (sessionId: string): Promise<AutomationProgramContext> => {
    const record = await lody.documentManager.repo.getDocMeta(
      getSessionRoomId(sessionId as SessionId)
    );
    const meta = record?.meta as SessionMeta | undefined;
    if (
      !record ||
      !meta ||
      isLoroRepoDocDeleted(record) ||
      meta.userId !== auth.userId ||
      meta.machineId !== auth.machineId
    )
      throw new Error('AUTOMATION_SESSION_UNAVAILABLE');
    if (meta.isArchived) throw new Error('AUTOMATION_SESSION_ARCHIVED');
    return { sessionId, workspaceId: workspace.id, now: Date.now() };
  };
  const evaluateWait = (wait: AutomationWait) =>
    Effect.tryPromise(() => sessionContext(wait.sessionId)).pipe(
      Effect.uninterruptible,
      Effect.flatMap((context) =>
        evaluateAutomationProgram(wait.program, context, (input) =>
          Effect.tryPromise(() =>
            readAutomationContext({
              ledger,
              manager: lody.documentManager,
              authority,
              wait,
              input,
              now: Date.now(),
            })
          ).pipe(Effect.uninterruptible)
        )
      )
    );
  const host = Layer.effect(
    AutomationHost,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => ledger.close()));
      // These unfinished Session APIs do not cancel raw I/O. Keep their owner until it settles.
      const sessionCall = <A>(body: () => Promise<A>) =>
        Effect.tryPromise(body).pipe(Effect.uninterruptible);
      return AutomationHost.of({
        observe: sessionCall(async () => {
          await reconcileSessionTurnsLegacy(
            ledger,
            lody.documentManager,
            (fact) => authority.executionRelease(fact.sessionId, fact.assistantTurnId, fact.userId),
            (cause) => logger.warn('Automation turn observation awaiting reconciliation', cause)
          );
        }),
        authorize: (receipt) => sessionCall(() => actions.authorize(receipt)),
        condition: (spec, receipt) => sessionCall(() => condition(spec, receipt)),
        prepare: (receipt) => sessionCall(() => actions.prepare(receipt)),
        submit: (receipt) => sessionCall(() => actions.submit(receipt)),
        reconcile: (receipt) => sessionCall(() => actions.reconcile(receipt)),
        cancel: (receipt) => sessionCall(() => actions.cancel(receipt)),
        evaluate: (wait) => evaluateWait(wait),
        report: (cause) =>
          Effect.sync(() => logger.warn('Automation operation did not settle', cause)),
      });
    })
  );
  const runtime = ManagedRuntime.make(Automations.layer(ledger).pipe(Layer.provide(host)));
  let close: Promise<void> | undefined;
  try {
    const service = await runtime.runPromise(Automations);
    const canSubmit = (
      sessionId: SessionId,
      turnId: string,
      origin: import('@lody/shared/automations').AutomationOrigin,
      binding?: import('@/session/automation-observations').ProviderBinding | null
    ) => {
      const receipt = ledger.receipt(origin.invocationId);
      const rule = receipt && ledger.rule(receipt.rule.id);
      const work = origin.workIntentId ? ledger.work(origin.workIntentId) : undefined;
      // Credential-derived launch fingerprints stay in this private ledger, never queued history.
      if (
        origin.workIntentId &&
        (!work ||
          work.invocationId !== origin.invocationId ||
          ['settled', 'cancelled', 'failed', 'unknown'].includes(work.state) ||
          (binding !== undefined &&
            (!binding ||
              binding.bindingId !== work.bindingId ||
              binding.fingerprint !== work.fingerprint)))
      )
        return false;
      return (
        !!receipt &&
        checkWorkflowEvidence(ledger, receipt.evidence ?? [], Date.now()).value === 'yes' &&
        retainsAutomationGrant(receipt, rule) &&
        matchesPreparedOrigin(receipt, origin) &&
        (!origin.maintenance || origin.maintenance.expiresAt > Date.now()) &&
        receipt.sessionId === sessionId &&
        receipt.turnId === turnId &&
        receipt.rule.ownerUserId === origin.authorizationUserId &&
        receipt.rule.id === origin.ruleId &&
        receipt.rule.revision === origin.ruleRevision &&
        ['submitting', 'queued', 'running', 'resolved', 'blocked'].includes(receipt.state)
      );
    };
    authority.setPendingWork(
      (sessionId, excludingId) => !closing && ledger.hasSessionWork(sessionId, excludingId)
    );
    authority.setObservations({
      stage: (fact) => {
        if (!closing) ledger.stageTurn(fact);
      },
      turn: (fact) =>
        observe(async () => {
          ledger.stageTurn(fact);
          await runtime.runPromise(service.wake);
        }),
      capacity: (binding, snapshot, source) =>
        observe(async () => {
          observeCapacity(ledger, binding, snapshot, source, Date.now());
          await runtime.runPromise(service.wake);
        }),
    });
    authority.setAdmission(
      async ({ sessionId, turnId, userId, origin }) => {
        const receipt = ledger.receipt(origin.invocationId);
        if (
          !receipt ||
          receipt.sessionId !== sessionId ||
          receipt.turnId !== turnId ||
          receipt.rule.ownerUserId !== userId ||
          receipt.rule.id !== origin.ruleId ||
          receipt.rule.revision !== origin.ruleRevision ||
          !canSubmit(sessionId, turnId, origin)
        )
          return false;
        return (await recheck(receipt)).value === 'yes';
      },
      canSubmit,
      async ({ sessionId, turnId, userId, origin }) => {
        const work = origin.workIntentId && ledger.work(origin.workIntentId);
        if (!work || work.ownerUserId !== userId || !canSubmit(sessionId, turnId, origin))
          return false;
        const record = await lody.documentManager.repo.getDocMeta(getSessionRoomId(sessionId));
        const meta = record?.meta as SessionMeta | undefined;
        if (
          meta?.agentType === 'claude' &&
          ledger.receipt(origin.invocationId)?.event.type === 'provider.quota.exhausted' &&
          options.hasUncertainLegacyQuota(sessionId)
        )
          return false;
        return (
          !!record &&
          !!meta &&
          !isLoroRepoDocDeleted(record) &&
          meta.userId === userId &&
          meta.machineId === auth.machineId &&
          !meta.isArchived &&
          !meta.collaborationStopped &&
          meta.acpSessionId === work.nativeSessionId &&
          (meta.latestUserMsgId === work.turnId || meta.latestUserMsgId === turnId)
        );
      }
    );
    const assertReadable = (wait: AutomationWait, requesterSessionId?: string) => {
      if (
        wait.ownerUserId !== auth.userId ||
        wait.ownerMachineId !== auth.machineId ||
        (requesterSessionId && wait.sessionId !== requesterSessionId)
      )
        throw new Error('AUTOMATION_NOT_FOUND');
    };
    const publicWait = (wait: AutomationWait) => {
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
    };
    const handle = {
      ledger,
      dispatchQuotaSchedule: (
        run: ScheduleRun<PreparedSessionInput>,
        prepared: PreparedSessionInput
      ) =>
        ownedCall(() =>
          dispatchQuotaSchedule({
            run,
            prepared,
            userId: auth.userId,
            ledger,
            manager: lody.documentManager,
            authority,
          })
        ),
      wantsWorkflowObservations: (sessionId: string) =>
        ledger.wantsRead('github.workflowRuns', sessionId),
      recordWorkflowObservations: ((meta, repository, headSha, runs, gap, observedAt) =>
        observe(async () => {
          observeWorkflows(ledger, meta, repository, headSha, runs, gap, observedAt);
          await runtime.runPromise(service.wake);
        })) satisfies NonNullable<PrPollerWorkspaceHandle['recordWorkflowObservations']>,
      recordObservations: ((meta, repoFullName, observations, observedAt) =>
        observe(async () => {
          observePullRequests(ledger, meta, repoFullName, observations, observedAt);
          await runtime.runPromise(service.wake);
        })) satisfies NonNullable<PrPollerWorkspaceHandle['recordObservations']>,
      publish: (event: AutomationEvent) =>
        observe(async () => {
          ledger.publish(event);
          await runtime.runPromise(service.wake);
        }),
      wake: () => runtime.runPromise(service.wake),
      command: (input: AutomationCommand, requesterSessionId?: string): Promise<unknown> =>
        ownedCall(async () => {
          if (closing) throw new Error('AUTOMATION_OWNER_CLOSING');
          const command = automationCommandSchema.parse(input);
          if (
            requesterSessionId &&
            authority.author(requesterSessionId as SessionId) !== auth.userId
          )
            throw new Error('AUTOMATION_ACTIVE_AUTHOR_REQUIRED');
          const now = await runtime.runPromise(Clock.currentTimeMillis);
          switch (command.type) {
            case 'register': {
              const sessionId = requesterSessionId ?? command.sessionId;
              if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
              if (
                requesterSessionId &&
                command.sessionId &&
                command.sessionId !== requesterSessionId
              )
                throw new Error('AUTOMATION_SCOPE_EXCEEDS_AUTHOR');
              const context = await sessionContext(sessionId);
              if (command.expiresAt !== undefined && command.expiresAt <= now)
                throw new Error('AUTOMATION_ALREADY_EXPIRED');
              await runtime.runPromise(
                evaluateAutomationProgram(
                  command.program,
                  context,
                  () => Effect.fail(new Error('AUTOMATION_VALIDATION_HAS_NO_READS')),
                  true
                )
              );
              if (closing) throw new Error('AUTOMATION_OWNER_CLOSING');
              const { type: _type, sessionId: _session, ...registration } = command;
              const wait = ledger.registerWait(registration, sessionId, auth.userId, now);
              await runtime.runPromise(service.wake);
              return publicWait(wait);
            }
            case 'settings':
            case 'configure': {
              const sessionId = requesterSessionId ?? command.sessionId;
              if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
              if (
                requesterSessionId &&
                command.sessionId &&
                command.sessionId !== requesterSessionId
              )
                throw new Error('AUTOMATION_SCOPE_EXCEEDS_AUTHOR');
              await sessionContext(sessionId);
              if (command.type === 'configure')
                configureSessionPolicies(ledger, sessionId, auth.userId, command.settings, now);
              await runtime.runPromise(service.wake);
              return sessionPolicySettings(ledger, sessionId);
            }
            case 'list': {
              if (
                requesterSessionId &&
                command.sessionId &&
                command.sessionId !== requesterSessionId
              )
                throw new Error('AUTOMATION_SCOPE_EXCEEDS_AUTHOR');
              return ledger
                .waits(auth.userId, requesterSessionId ?? command.sessionId)
                .map(publicWait);
            }
            case 'show': {
              const wait = ledger.wait(command.id);
              if (!wait) throw new Error('AUTOMATION_NOT_FOUND');
              assertReadable(wait, requesterSessionId);
              return publicWait(wait);
            }
            case 'activities': {
              if (
                requesterSessionId &&
                command.sessionId &&
                command.sessionId !== requesterSessionId
              )
                throw new Error('AUTOMATION_SCOPE_EXCEEDS_AUTHOR');
              const page = ledger.activityPage(
                auth.userId,
                requesterSessionId ?? command.sessionId,
                command.limit,
                command.before
              );
              return { ...page, items: page.items.map(publicActivity) };
            }
            case 'cancel': {
              const wait = ledger.wait(command.id);
              if (wait) {
                assertReadable(wait, requesterSessionId);
                await runtime.runPromise(service.cancel(wait.id));
                const current = ledger.wait(wait.id);
                return current && publicWait(current);
              }
              const receipt = ledger.receipt(command.id);
              if (!receipt) {
                const work = ledger.work(command.id);
                if (
                  !work ||
                  work.ownerUserId !== auth.userId ||
                  (requesterSessionId && work.sessionId !== requesterSessionId)
                )
                  throw new Error('AUTOMATION_NOT_FOUND');
                ledger.putWork({ ...work, state: 'cancelled', updatedAt: now });
                if (work.invocationId) await runtime.runPromise(service.cancel(work.invocationId));
                await runtime.runPromise(service.wake);
                const current = ledger.work(command.id);
                return current ? workActivity(current) : undefined;
              }
              if (
                receipt.rule.ownerUserId !== auth.userId ||
                (requesterSessionId && receipt.rule.scope.sessionId !== requesterSessionId)
              )
                throw new Error('AUTOMATION_NOT_FOUND');
              await runtime.runPromise(service.cancel(command.id));
              const current = ledger.receipt(command.id);
              return current ? actionActivity(current) : undefined;
            }
          }
          throw new Error('AUTOMATION_COMMAND_UNSUPPORTED');
        }),
      dispose: () =>
        (close ??= (async () => {
          closing = true;
          authority.setAdmission(undefined);
          authority.setObservations(undefined);
          authority.setPendingWork(undefined);
          const observations = await Promise.allSettled([...observationWork]);
          await runtime.dispose();
          const failed = observations.filter((item) => item.status === 'rejected');
          if (failed.length)
            logger.warn(
              'Automation operations ended with errors during shutdown',
              failed.map((item) => item.reason)
            );
        })()),
    };
    return {
      ...handle,
      remoteControlNonce: options.verifyRemoteControl ? remoteNonce : undefined,
      remoteControl: (input: {
        sessionId: string;
        requesterUserId: string;
        operation: RemoteAutomationOperation;
        proof: RemoteAutomationProof;
        responseKey: import('@lody/shared').RpcSecretPublicKey;
      }) =>
        ownedCall(async () => {
          const verify = options.verifyRemoteControl;
          if (!verify) throw new Error('AUTOMATION_REMOTE_AUTH_UNAVAILABLE');
          const operation = remoteAutomationOperationSchema.parse(input.operation);
          const proof = remoteAutomationProofSchema.parse(input.proof);
          if (input.requesterUserId !== auth.userId)
            throw new Error('AUTOMATION_PERMISSION_DENIED');
          if (proof.runtimeNonce !== remoteNonce) throw new Error('AUTOMATION_RUNTIME_CHANGED');
          for (const [id, expiresAt] of consumedRemoteRequests)
            if (expiresAt <= Date.now()) consumedRemoteRequests.delete(id);
          if (consumedRemoteRequests.has(proof.requestId))
            throw new Error('AUTOMATION_REQUEST_USED');
          await sessionContext(input.sessionId);
          const verified = await verify({
            intent: remoteAutomationIntentSchema.parse({
              workspaceId: workspace.id,
              machineId: auth.machineId,
              sessionId: input.sessionId,
              requesterUserId: input.requesterUserId,
              runtimeNonce: remoteNonce,
              requestId: proof.requestId,
              responseKey: input.responseKey,
              operation,
            }),
            requestToken: proof.requestToken,
          });
          if (verified.requesterUserId !== auth.userId || verified.expiresAt <= Date.now())
            throw new Error('AUTOMATION_PERMISSION_DENIED');
          if (consumedRemoteRequests.has(proof.requestId))
            throw new Error('AUTOMATION_REQUEST_USED');
          consumedRemoteRequests.set(proof.requestId, verified.expiresAt);
          await sessionContext(input.sessionId);
          if (operation.type === 'cancel') {
            const wait = ledger.wait(operation.id);
            if (!wait) throw new Error('AUTOMATION_NOT_FOUND');
            assertReadable(wait, input.sessionId);
            await handle.command({ type: 'cancel', id: operation.id });
            return { type: 'cancel' as const };
          }
          if (operation.type === 'list') {
            const all = ledger.waits(auth.userId, input.sessionId);
            const start = operation.after
              ? all.findIndex((wait) => wait.id === operation.after) + 1
              : 0;
            if (operation.after && start === 0) throw new Error('AUTOMATION_CURSOR_INVALID');
            const waits = [];
            let size = 0;
            for (const wait of all.slice(start)) {
              const receipt = wait.invocationId && ledger.receipt(wait.invocationId);
              const item = {
                id: wait.id,
                sessionId: wait.sessionId,
                reason: wait.reason,
                state: wait.state,
                nextCheckAt: wait.nextCheckAt,
                expiresAt: wait.expiresAt,
                ...(receipt
                  ? { continuation: { state: receipt.state, reason: receipt.reason } }
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
          const settings = await handle.command({ ...operation, sessionId: input.sessionId });
          return { type: 'settings' as const, settings };
        }),
    };
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }
}
