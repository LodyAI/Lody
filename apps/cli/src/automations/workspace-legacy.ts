import { Clock, Effect, Layer, ManagedRuntime } from 'effect';
import path from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  automationCommandSchema,
  type AutomationCommand,
  type AutomationCondition,
  type AutomationEvent,
  type AutomationProgramContext,
  type AutomationReceipt,
  type ConditionObservation,
} from '@lody/shared/automations';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type AgentConfigId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { platformLayer } from '@/platform/process-options';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import type { Logger } from '@/utils/logger';
import {
  providerBindingFingerprint,
  type ProviderBinding,
} from '@/session/automation-observations';
import type { PrPollerWorkspaceHandle } from '@/lib/pr-poller/pr-poller-workspace';
import type { ScheduleRun } from '@/lib/schedules/schedule-store';
import type { PreparedSessionInput } from '@/lib/prepared-session-input';
import { AutomationLedger, automationIdentity } from './storage/ledger';
import { Automations, AutomationHost } from './runtime/engine';
import { evaluateCapacity } from './runtime/capacity';
import { makeManagedRuns, type ManagedRuns } from './runtime/managed-runs';
import { createWaitEvaluator } from './runtime/wait-evaluator';
import { upgradeCapacityPolicies } from './policies/session';
import { DeliveryCoordinator } from './policies/delivery-coordinator';
import { evaluateAutomationCondition } from './conditions/evaluator';
import {
  AutomationSessionActionsLegacy,
  isDurableSessionDenial,
} from './actions/session-actions-legacy';
import { canSubmitAutomationInput } from './actions/authorization';
import { observeCapacity } from './sources/capacity';
import { observePullRequests } from './sources/pull-requests';
import { observeWorkflows } from './sources/workflows';
import { reconcileSessionTurnsLegacy } from './sources/sessions-legacy';
import { dispatchQuotaSchedule } from './compat/quota-schedule';
import { executeAutomationCommand } from './control/command-handler';
import {
  createRemoteAutomationController,
  type RemoteAutomationVerifier,
} from './control/remote-control';

export type AutomationWorkspaceHandle = Awaited<ReturnType<typeof createAutomationWorkspaceLegacy>>;

/** Workspace/Fleet application boundary. Dispose before Session owners or their repo. */
export async function createAutomationWorkspaceLegacy(options: {
  lody: Lody;
  auth: AuthContext;
  workspace: WorkspaceSummary;
  logger: Logger;
  verifyRemoteControl?: RemoteAutomationVerifier;
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
    upgradeCapacityPolicies(ledger, Date.now());
    ledger.orphanStartedRuns(Date.now());
  } catch (error) {
    ledger.close();
    throw error;
  }

  const authority = lody.getAutomationSessionAuthority();
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

  const delivery = new DeliveryCoordinator({
    ledger,
    manager: lody.documentManager,
    machineId: auth.machineId,
    logger,
  });

  const condition = (
    spec: AutomationCondition,
    receipt: AutomationReceipt
  ): Promise<ConditionObservation> =>
    evaluateAutomationCondition(
      {
        ledger,
        lody,
        authority,
        machineId: auth.machineId,
        logger,
        currentPr: (item, prUrl) => actions.currentPr(item, prUrl),
      },
      spec,
      receipt
    );

  const recheckAdmission = async (receipt: AutomationReceipt): Promise<ConditionObservation> => {
    const authorization = await actions.authorize(receipt);
    if (authorization.value !== 'yes' || authorization.reason === 'archive_already_committed')
      return authorization;
    if (receipt.intent.guard) {
      const guard = await condition(receipt.intent.guard, receipt);
      if (guard.value !== 'yes') return { ...guard, reason: `guard:${guard.reason}` };
    }
    return { value: 'yes', reason: 'authorized' };
  };

  const recheck = async (receipt: AutomationReceipt): Promise<ConditionObservation> => {
    const admission = await recheckAdmission(receipt);
    if (admission.value !== 'yes' || admission.reason === 'archive_already_committed')
      return admission;
    if (receipt.intent.condition && !['queued', 'running', 'unknown'].includes(receipt.state)) {
      const predicate = await condition(receipt.intent.condition, receipt);
      if (predicate.value !== 'yes') return predicate;
    }
    return admission;
  };

  const actions = new AutomationSessionActionsLegacy({
    ...options,
    ledger,
    admission: recheckAdmission,
    capacity: (bindingId, modelId, receipt) =>
      condition(
        {
          kind: 'provider.capacity.can_dispatch',
          parameters: { bindingId, ...(modelId ? { modelId } : {}) },
        },
        receipt
      ),
  });

  const sessionMeta = async (sessionId: string): Promise<SessionMeta> => {
    const record = await lody.documentManager.repo.getDocMeta(
      getSessionRoomId(sessionId as SessionId)
    );
    const meta = record?.meta as SessionMeta | undefined;
    if (!record || !meta || isLoroRepoDocDeleted(record) || meta.machineId !== auth.machineId)
      throw new Error('AUTOMATION_SESSION_UNAVAILABLE');
    if (meta.isArchived) throw new Error('AUTOMATION_SESSION_ARCHIVED');
    return meta;
  };

  const assertCanEdit = async (sessionId: string, userId: string): Promise<void> => {
    const access = await authority.canEdit(sessionId as SessionId, userId);
    if (access === 'no') throw new Error('AUTOMATION_PERMISSION_DENIED');
    if (access === 'unknown') throw new Error('AUTOMATION_PERMISSION_UNCONFIRMED');
  };

  const sessionContext = async (
    sessionId: string,
    userId: string
  ): Promise<AutomationProgramContext> => {
    await sessionMeta(sessionId);
    await assertCanEdit(sessionId, userId);
    return { sessionId, workspaceId: workspace.id, now: Date.now() };
  };

  let managedRuns: ManagedRuns | undefined;
  let wakeEngine: Effect.Effect<void> = Effect.void;
  const reportRun = (cause: unknown) =>
    Effect.sync(() => logger.warn('Managed automation run did not settle', cause));
  const managedRunLogs = path.join(
    getLodyDataDir(),
    'automations',
    'runs',
    automationIdentity(auth.machineId, workspace.id)
  );
  const evaluateWait = createWaitEvaluator({
    ledger,
    lody,
    authority,
    logger,
    getManagedRuns: () => managedRuns,
    sessionContext,
  });

  const host = Layer.effect(
    AutomationHost,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => ledger.close()));
      // Acquired after the ledger finalizer, so runs are terminated before the ledger closes.
      managedRuns = yield* makeManagedRuns({
        onStarted: (id, pid) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => Effect.try(() => ledger.recordRunPid(id, pid, now))),
            Effect.catchCause((cause) => reportRun(cause))
          ),
        onExit: (id, exit) =>
          Effect.try(() => ledger.recordRunExit(id, exit, exit.endedAt)).pipe(
            Effect.andThen(Effect.suspend(() => wakeEngine)),
            Effect.catchCause((cause) => reportRun(cause))
          ),
        report: (cause) => reportRun(cause),
      });
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
        }).pipe(Effect.andThen(delivery.advanceAll())),
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

  const runtime = ManagedRuntime.make(
    Automations.layer(ledger).pipe(Layer.provide(host), Layer.provide(platformLayer({ logger })))
  );

  let close: Promise<void> | undefined;
  try {
    const service = await runtime.runPromise(Automations);
    wakeEngine = service.wake;

    const canSubmit = (
      sessionId: SessionId,
      turnId: string,
      origin: import('@lody/shared/automations').AutomationOrigin,
      binding?: ProviderBinding | null
    ) => canSubmitAutomationInput(ledger, sessionId, turnId, origin, binding);

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
      idle: (sessionId) => {
        void observe(async () => {
          if (ledger.wakeSessionBlocked(sessionId, Date.now()) > 0) {
            await runtime.runPromise(service.wake);
          }
        }).catch((cause) => logger.debug('Automation idle wake did not settle', cause));
      },
    });
    authority.setAdmission(
      async ({ sessionId, turnId, userId, origin }) => {
        const receipt = ledger.receipt(origin.invocationId);
        if (!receipt || ['settled', 'failed', 'cancelled', 'superseded'].includes(receipt.state)) {
          // The input outlived its receipt; leave no zombie for dispatch to re-verify.
          await authority.cancelInput(sessionId, turnId).catch(() => false);
          return false;
        }
        if (
          receipt.sessionId !== sessionId ||
          receipt.turnId !== turnId ||
          receipt.rule.ownerUserId !== userId ||
          receipt.rule.id !== origin.ruleId ||
          receipt.rule.revision !== origin.ruleRevision ||
          !canSubmit(sessionId, turnId, origin)
        )
          return false;
        const verdict = await recheck(receipt);
        if (verdict.value === 'yes') return true;
        if (verdict.value === 'no' && isDurableSessionDenial(verdict)) {
          const now = Date.now();
          ledger.update(
            receipt.id,
            receipt.state,
            { state: 'cancelling', reason: verdict.reason, retryAt: now },
            now
          );
        }
        return false;
      },
      canSubmit,
      async ({ sessionId, turnId, userId, origin }) => {
        const work = origin.workIntentId && ledger.work(origin.workIntentId);
        if (!work || !canSubmit(sessionId, turnId, origin)) return false;
        const record = await lody.documentManager.repo.getDocMeta(getSessionRoomId(sessionId));
        const meta = record?.meta as SessionMeta | undefined;
        return (
          !!record &&
          !!meta &&
          !isLoroRepoDocDeleted(record) &&
          meta.machineId === auth.machineId &&
          !meta.isArchived &&
          !meta.collaborationStopped &&
          meta.acpSessionId === work.nativeSessionId &&
          (meta.latestUserMsgId === work.turnId || meta.latestUserMsgId === turnId) &&
          (await authority.canEdit(sessionId, userId)) === 'yes'
        );
      }
    );

    const execute = (
      command: AutomationCommand,
      principal: string,
      requesterSessionId?: string
    ): Promise<unknown> =>
      executeAutomationCommand(
        {
          ledger,
          lody,
          machineId: auth.machineId,
          managedRunLogs,
          delivery,
          isClosing: () => closing,
          getManagedRuns: () => managedRuns,
          assertCanEdit,
          sessionContext,
          runEffect: (effect) => runtime.runPromise(effect),
          wake: () => runtime.runPromise(service.wake),
          cancelInvocation: (id) => runtime.runPromise(service.cancel(id)),
        },
        command,
        principal,
        requesterSessionId
      );

    const remote = createRemoteAutomationController({
      ledger,
      workspaceId: workspace.id,
      machineId: auth.machineId,
      verifyRemoteControl: options.verifyRemoteControl,
      ownedCall,
      sessionMeta,
      sessionContext,
      execute,
    });

    return {
      ledger,
      capacityRetryAt: async (run: ScheduleRun<PreparedSessionInput>) => {
        const bindingId = run.definition.agent.agentConfigId;
        const modelId = run.definition.agent.modelId;
        const config = await lody.documentManager.getAgentConfigForMachineLaunch(
          bindingId as AgentConfigId,
          auth.machineId
        );
        if (!config) return undefined;
        const observed = evaluateCapacity(
          ledger.capacity(bindingId, modelId) ?? ledger.capacity(bindingId),
          { bindingId, fingerprint: providerBindingFingerprint(config), modelId },
          Date.now()
        );
        return observed.value === 'no' && observed.reason === 'capacity_exhausted'
          ? observed.retryAt
          : undefined;
      },
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
      workflowObservationOwners: () =>
        ledger.wantsReadSessions('github.workflowRuns') as Set<SessionId>,
      deliveryObservationOwners: () => delivery.observationOwners(),
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
          const principal = requesterSessionId
            ? authority.author(requesterSessionId as SessionId)
            : auth.userId;
          if (!principal) throw new Error('AUTOMATION_ACTIVE_AUTHOR_REQUIRED');
          return execute(command, principal, requesterSessionId);
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
      ...remote,
    };
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }
}
