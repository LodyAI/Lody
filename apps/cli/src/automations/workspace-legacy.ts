import { readAutomationContext } from './context/reads-legacy';
import {
  automationCommandEnvironment,
  execAutomationCommand,
  resolveAutomationCwd,
} from './context/exec';
import { makeManagedRuns, managedRunResult, type ManagedRuns } from './runtime/managed-runs';
import { getCachedLoginShellEnvSyncLegacy } from '@/agent/login-shell-env';
import { platformLayer } from '@/platform/process-options';
import { observeWorkflows, checkWorkflowEvidence } from './sources/workflows';
import { publicActivity, actionActivity, workActivity } from './control/activities';
import { Clock, Effect, Layer, ManagedRuntime, Semaphore } from 'effect';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  autoDeliverOptionsSchema,
  automationCommandSchema,
  remoteAutomationOperationSchema,
  remoteAutomationIntentSchema,
  remoteAutomationProofSchema,
  type AutomationCommand,
  type AutomationCondition,
  type AutomationEvent,
  type AutomationReceipt,
  type AutomationWait,
  type AutomationRunExit,
  type AutomationProgramContext,
  type ConditionObservation,
  type RemoteAutomationIntent,
  type RemoteAutomationProof,
  type RemoteAutomationOperation,
} from '@lody/shared/automations';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionAutoDelivery,
  type SessionMeta,
  type SessionId,
  type AgentConfigId,
} from '@lody/shared';
import {
  configureSessionPolicies,
  sessionPolicySettings,
  upgradeCapacityPolicies,
} from './policies/session';
import {
  advanceDelivery,
  DELIVERY_EVENT_SOURCE,
  deliveryStepCurrent,
  readDeliveryProgress,
  startDeliveryEpoch,
} from './policies/delivery';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import type { Logger } from '@/utils/logger';
import { createSessionBackend } from '@/session/session-backend';
import { AutomationLedger, automationIdentity } from './storage/ledger';
import { Automations, AutomationHost } from './runtime/engine';
import { evaluateCapacity } from './runtime/capacity';
import { evaluateAutomationProgram } from './programs/codemode';
import {
  AutomationSessionActionsLegacy,
  isDurableSessionDenial,
} from './actions/session-actions-legacy';
import { retainsAutomationGrant, matchesPreparedOrigin } from './actions/authorization';
import { observeCapacity } from './sources/capacity';
import { reconcileSessionTurnsLegacy } from './sources/sessions-legacy';
import { providerBindingFingerprint } from '@/session/automation-observations';
import { observePullRequests } from './sources/pull-requests';
import type { PrPollerWorkspaceHandle } from '@/lib/pr-poller/pr-poller-workspace';
import { dispatchQuotaSchedule } from './compat/quota-schedule';
import type { ScheduleRun } from '@/lib/schedules/schedule-store';
import type { PreparedSessionInput } from '@/lib/prepared-session-input';

/** Tool lookup follows the login shell, as the Agent's own commands do; nothing else is inherited. */
const managedRunEnvironment = (): NodeJS.ProcessEnv => {
  let shellPath: string | undefined;
  try {
    shellPath = getCachedLoginShellEnvSyncLegacy().PATH;
  } catch {
    shellPath = undefined;
  }
  const entries = [
    ...new Set(
      [shellPath, process.env.PATH]
        .flatMap((value) => value?.split(path.delimiter) ?? [])
        .filter(Boolean)
    ),
  ];
  return automationCommandEnvironment(entries.length ? entries.join(path.delimiter) : undefined);
};

export type AutomationWorkspaceHandle = Awaited<ReturnType<typeof createAutomationWorkspaceLegacy>>;

/** Workspace/Fleet application boundary. Dispose before Session owners or their repo. */
export async function createAutomationWorkspaceLegacy(options: {
  lody: Lody;
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
    upgradeCapacityPolicies(ledger, Date.now());
    ledger.orphanStartedRuns(Date.now());
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
  const deliveryStatus = Semaphore.makeUnsafe(1);
  const withDeliveryStatus = <A>(body: (now: number) => Promise<A>) =>
    deliveryStatus.withPermit(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.tryPromise({ try: () => body(now), catch: (cause) => cause })
        ),
        Effect.uninterruptible
      )
    );
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
      case 'session.delivery.current':
        if (typeof parameters.sessionId !== 'string' || typeof parameters.eventId !== 'string')
          throw new Error('AUTOMATION_CONDITION_INVALID');
        return deliveryStepCurrent(ledger, parameters.sessionId, parameters.eventId);
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
          work && work.bindingId === bindingId && work.sessionId === receipt.rule.scope.sessionId;
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
        const quotaResetDue =
          receipt.event.type === 'provider.quota.exhausted' &&
          receipt.rule.handler.kind === 'policy' &&
          receipt.rule.handler.policy === 'recover-capacity' &&
          observed.value === 'no' &&
          observed.reason === 'capacity_exhausted' &&
          observed.retryAt === undefined;
        if (observed.value === 'unknown' || quotaResetDue) {
          try {
            await authority.refreshCapacity(bindingId);
          } catch (cause) {
            if (
              receipt.event.type !== 'provider.quota.exhausted' ||
              receipt.rule.handler.kind !== 'policy' ||
              receipt.rule.handler.policy !== 'recover-capacity'
            )
              throw cause;
            logger.warn('Automation capacity refresh failed', cause);
            return observed;
          }
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
      if (guard.value !== 'yes') return { ...guard, reason: `guard:${guard.reason}` };
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
  const evaluateWait = (wait: AutomationWait) =>
    wait.run ? evaluateRun(wait) : evaluateProgram(wait);
  const evaluateRun = Effect.fn('Automations.evaluateRun')(function* (claimed: AutomationWait) {
    const wait = ledger.wait(claimed.id) ?? claimed;
    const run = wait.run;
    if (!run || !managedRuns) return yield* Effect.fail(new Error('AUTOMATION_RUN_UNAVAILABLE'));
    if (run.exit) return managedRunResult(wait, run.exit);
    if (managedRuns.has(wait.id)) return false as const;
    const now = yield* Clock.currentTimeMillis;
    if (run.startedAt !== undefined) {
      // The owner that started it is gone without observing its exit. Never start it again.
      const exit: AutomationRunExit = {
        endedAt: now,
        outcome: 'interrupted',
        exitCode: null,
        signal: null,
        tail: '',
        logTruncated: false,
      };
      ledger.recordRunExit(wait.id, exit, now);
      return managedRunResult(wait, exit);
    }
    const owner = managedRuns;
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (!ledger.claimRunStart(wait.id, now)) return false as const;
        const cwd = yield* Effect.tryPromise(() =>
          sessionContext(wait.sessionId, wait.ownerUserId)
        ).pipe(
          Effect.andThen(
            Effect.tryPromise(() => lody.resolveAutomationWorkdir(wait.sessionId as SessionId))
          ),
          Effect.flatMap((root) =>
            root
              ? resolveAutomationCwd(root, run.cwd)
              : Effect.fail(new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'))
          ),
          Effect.result
        );
        if (cwd._tag === 'Failure') {
          const exit: AutomationRunExit = {
            endedAt: now,
            outcome: 'spawn_failed',
            exitCode: null,
            signal: null,
            error: cwd.failure instanceof Error ? cwd.failure.message : 'Run could not start',
            tail: '',
            logTruncated: false,
          };
          ledger.recordRunExit(wait.id, exit, now);
          return managedRunResult(wait, exit);
        }
        yield* owner.start(wait.id, {
          command: run.command,
          args: run.args,
          cwd: cwd.success,
          env: { ...managedRunEnvironment(), ...run.env },
          logPath: run.logPath,
        });
        return false as const;
      })
    );
  });
  const evaluateProgram = (wait: AutomationWait) =>
    Effect.tryPromise(() => sessionContext(wait.sessionId, wait.ownerUserId)).pipe(
      Effect.uninterruptible,
      Effect.flatMap((context) =>
        evaluateAutomationProgram(
          wait.program ?? '',
          context,
          (input) =>
            Effect.tryPromise(() =>
              readAutomationContext({
                ledger,
                manager: lody.documentManager,
                authority,
                wait,
                input,
                now: Date.now(),
              })
            ).pipe(Effect.uninterruptible),
          false,
          (input) =>
            Effect.tryPromise({
              try: () => lody.resolveAutomationWorkdir(wait.sessionId as SessionId),
              catch: () => new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'),
            }).pipe(
              Effect.flatMap((root) =>
                root
                  ? execAutomationCommand(input, root, automationCommandEnvironment()).pipe(
                      Effect.provide(platformLayer({ logger }))
                    )
                  : Effect.fail(new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'))
              )
            )
        )
      )
    );
  const deliveryStatusKey = (status: Omit<SessionAutoDelivery, 'updatedAt'> | null | undefined) =>
    status ? JSON.stringify([status.state, status.attempt, status.reason, status.prUrl]) : '';
  /** Auto delivery reads observations already in this ledger and the Session metadata. */
  const advanceDeliveries = async (now: number) => {
    for (const rule of ledger.rules()) {
      const sessionId = rule.scope.sessionId;
      if (
        !rule.enabled ||
        !sessionId ||
        rule.handler.kind !== 'policy' ||
        rule.handler.policy !== 'auto-deliver' ||
        rule.ownerMachineId !== auth.machineId
      )
        continue;
      try {
        const options = autoDeliverOptionsSchema.parse(rule.handler.options);
        const roomId = getSessionRoomId(sessionId as SessionId);
        const record = await lody.documentManager.repo.getDocMeta(roomId);
        const meta = record?.meta as SessionMeta | undefined;
        if (!record || !meta || isLoroRepoDocDeleted(record) || meta.isArchived) continue;
        const decision = advanceDelivery({ ledger, meta, options, now });
        if (decision.finished)
          configureSessionPolicies(
            ledger,
            sessionId,
            rule.ownerUserId,
            { autoDeliver: false },
            now
          );
        if (deliveryStatusKey(meta.autoDelivery) !== deliveryStatusKey(decision.status)) {
          const pr = decision.observed;
          logger.debug(`Auto delivery ${sessionId}: ${deliveryStatusKey(decision.status)}`, {
            step: decision.step?.step,
            ...(pr
              ? {
                  head: pr.headSha,
                  status: pr.status,
                  ci: pr.ciState,
                  merge: pr.mergeState,
                  observedAt: pr.observedAt,
                }
              : {}),
            workspaceDirty: meta.workspaceDirty,
            workspaceUnpushed: meta.workspaceUnpushed,
          });
          await lody.documentManager.repo.upsertDocMeta(roomId, {
            autoDelivery: { ...decision.status, updatedAt: now },
          });
        }
      } catch (cause) {
        // One Session's failure leaves the others' delivery running.
        logger.warn(`Auto delivery pass failed for ${sessionId}`, cause);
      }
    }
  };
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
        }).pipe(Effect.andThen(withDeliveryStatus(advanceDeliveries))),
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
    const assertReadable = async (wait: AutomationWait, userId: string) => {
      if (wait.ownerMachineId !== auth.machineId) throw new Error('AUTOMATION_NOT_FOUND');
      await assertCanEdit(wait.sessionId, userId);
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
    const execute = async (
      command: AutomationCommand,
      principal: string,
      requesterSessionId?: string
    ): Promise<unknown> => {
      const now = await runtime.runPromise(Clock.currentTimeMillis);
      switch (command.type) {
        case 'register': {
          const sessionId = command.sessionId ?? requesterSessionId;
          if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
          const context = await sessionContext(sessionId, principal);
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
          const wait = ledger.registerWait(registration, sessionId, principal, now);
          await runtime.runPromise(service.wake);
          return publicWait(wait);
        }
        case 'run': {
          const sessionId = command.sessionId ?? requesterSessionId;
          if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
          await sessionContext(sessionId, principal);
          const root = await lody.resolveAutomationWorkdir(sessionId as SessionId);
          if (!root) throw new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE');
          await runtime.runPromise(resolveAutomationCwd(root, command.cwd));
          if (closing) throw new Error('AUTOMATION_OWNER_CLOSING');
          const { type: _type, sessionId: _session, ...run } = command;
          const wait = ledger.registerRun(run, sessionId, principal, managedRunLogs, now);
          await runtime.runPromise(service.wake);
          return publicWait(wait);
        }
        case 'settings':
        case 'configure': {
          const sessionId = command.sessionId ?? requesterSessionId;
          if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
          await sessionContext(sessionId, principal);
          if (command.type === 'configure') {
            const record =
              command.settings.recoverCapacity === true
                ? await lody.documentManager.repo.getDocMeta(
                    getSessionRoomId(sessionId as SessionId)
                  )
                : undefined;
            const meta = record?.meta as SessionMeta | undefined;
            const currentTurn =
              meta?.machineId === auth.machineId && !isLoroRepoDocDeleted(record)
                ? meta.latestUserMsgId
                : undefined;
            await runtime.runPromise(
              withDeliveryStatus(async (now) => {
                const previous = sessionPolicySettings(ledger, sessionId);
                const wasEnabled = previous.recoverCapacity === true;
                const enablesDelivery =
                  typeof command.settings.autoDeliver === 'object' &&
                  typeof previous.autoDeliver !== 'object';
                // Encrypted workspaces do not run the PR poller that Auto delivery reads.
                if (enablesDelivery && workspace.contentMode === 'e2ee')
                  throw new Error('AUTOMATION_AUTO_DELIVER_UNAVAILABLE_ENCRYPTED');
                ledger.configureSession(
                  () => {
                    if (enablesDelivery) startDeliveryEpoch(ledger, sessionId, now);
                    configureSessionPolicies(ledger, sessionId, principal, command.settings, now);
                  },
                  sessionId,
                  !wasEnabled ? currentTurn : undefined,
                  now
                );
                if (command.settings.autoDeliver === false)
                  await lody.documentManager.repo.upsertDocMeta(
                    getSessionRoomId(sessionId as SessionId),
                    { autoDelivery: null }
                  );
              })
            );
            const lastStep =
              command.settings.autoDeliver === false
                ? readDeliveryProgress(ledger, sessionId)?.lastStep
                : undefined;
            for (const receipt of lastStep
              ? ledger.eventReceipts(DELIVERY_EVENT_SOURCE, lastStep.eventId)
              : [])
              if (['accepted', 'waiting', 'resolved', 'blocked'].includes(receipt.state))
                await runtime.runPromise(service.cancel(receipt.id));
          }
          await runtime.runPromise(service.wake);
          return sessionPolicySettings(ledger, sessionId);
        }
        case 'list': {
          const sessionId = command.sessionId ?? requesterSessionId;
          if (sessionId) await assertCanEdit(sessionId, principal);
          return ledger.waits(sessionId ? undefined : principal, sessionId).map(publicWait);
        }
        case 'show': {
          const wait = ledger.wait(command.id);
          if (!wait) throw new Error('AUTOMATION_NOT_FOUND');
          await assertReadable(wait, principal);
          return publicWait(wait);
        }
        case 'activities': {
          const sessionId = command.sessionId ?? requesterSessionId;
          if (sessionId) await assertCanEdit(sessionId, principal);
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
            await assertReadable(wait, principal);
            await runtime.runPromise(service.cancel(wait.id));
            const owner = managedRuns;
            if (wait.run && owner) await runtime.runPromise(owner.stop(wait.id));
            const current = ledger.wait(wait.id);
            return current && publicWait(current);
          }
          const receipt = ledger.receipt(command.id);
          if (!receipt) {
            const work = ledger.work(command.id);
            if (!work) throw new Error('AUTOMATION_NOT_FOUND');
            await assertCanEdit(work.sessionId, principal);
            ledger.putWork({ ...work, state: 'cancelled', updatedAt: now });
            if (work.invocationId) await runtime.runPromise(service.cancel(work.invocationId));
            await runtime.runPromise(service.wake);
            const current = ledger.work(command.id);
            return current ? workActivity(current) : undefined;
          }
          await assertCanEdit(receipt.sessionId, principal);
          await runtime.runPromise(service.cancel(command.id));
          const current = ledger.receipt(command.id);
          return current ? actionActivity(current) : undefined;
        }
      }
      throw new Error('AUTOMATION_COMMAND_UNSUPPORTED');
    };
    const handle = {
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
          if (proof.runtimeNonce !== remoteNonce) throw new Error('AUTOMATION_RUNTIME_CHANGED');
          for (const [id, expiresAt] of consumedRemoteRequests)
            if (expiresAt <= Date.now()) consumedRemoteRequests.delete(id);
          if (consumedRemoteRequests.has(proof.requestId))
            throw new Error('AUTOMATION_REQUEST_USED');
          await sessionMeta(input.sessionId);
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
          const requester = verified.requesterUserId;
          if (requester !== input.requesterUserId || verified.expiresAt <= Date.now())
            throw new Error('AUTOMATION_PERMISSION_DENIED');
          if (consumedRemoteRequests.has(proof.requestId))
            throw new Error('AUTOMATION_REQUEST_USED');
          consumedRemoteRequests.set(proof.requestId, verified.expiresAt);
          await sessionContext(input.sessionId, requester);
          if (operation.type === 'cancel') {
            const wait = ledger.wait(operation.id);
            if (!wait || wait.sessionId !== input.sessionId)
              throw new Error('AUTOMATION_NOT_FOUND');
            await execute({ type: 'cancel', id: operation.id }, requester);
            return { type: 'cancel' as const };
          }
          if (operation.type === 'list') {
            const all = ledger.waits(undefined, input.sessionId);
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
          const settings = await execute({ ...operation, sessionId: input.sessionId }, requester);
          return { type: 'settings' as const, settings };
        }),
    };
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }
}
