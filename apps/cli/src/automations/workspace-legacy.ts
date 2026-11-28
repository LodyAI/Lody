import { Clock, Effect, Layer, ManagedRuntime, Queue } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import path from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  automationCommandSchema,
  type AutomationCommand,
  type AutomationEvent,
  type AutomationOrigin,
  type AutomationWait,
} from '@lody/shared/automations';
import type { SessionId } from '@lody/shared';
import { platformLayer } from '@/platform/process-options';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import type { Logger } from '@/utils/logger';
import type { ProviderBinding } from '@/session/automation-observations';
import type { PrPollerWorkspaceHandle } from '@/lib/pr-poller/pr-poller-workspace';
import type { ScheduleRun } from '@/lib/schedules/schedule-store';
import type { PreparedSessionInput } from '@/lib/prepared-session-input';
import { AutomationLedger, automationIdentity } from './storage/ledger';
import { TERMINAL_STATES } from './storage/schema';
import { Automations, AutomationHost } from './runtime/engine';
import { evaluateManagedRun, makeManagedRuns, ManagedRunsService } from './runtime/managed-runs';
import { evaluateAutomationProgram } from './programs/codemode';
import { readAutomationContext } from './context/reads-legacy';
import { automationCommandEnvironment, execAutomationCommand } from './context/exec';
import { upgradeCapacityPolicies } from './policies/session';
import { DeliveryCoordinator } from './policies/delivery';
import {
  canAcceptPendingWork,
  canSubmitAutomationInput,
  evaluateAutomationCondition,
  evaluateBindingCapacity,
  isDurableSessionDenial,
  recheckAdmission,
  recheckReceipt,
} from './actions/authorization';
import { AutomationSessionActionsLegacy } from './actions/session-actions-legacy';
import { observeCapacity } from './sources/capacity';
import { observePullRequests } from './sources/pull-requests';
import { observeWorkflows } from './sources/workflows';
import { reconcileSessionTurnsLegacy } from './sources/sessions-legacy';
import { dispatchQuotaSchedule } from './compat/quota-schedule';
import { createAutomationController, type RemoteAutomationVerifier } from './control/commands';

export type AutomationWorkspaceHandle = Awaited<ReturnType<typeof createAutomationWorkspaceLegacy>>;

/** Workspace/Fleet boundary. Dispose before Repo/Session owners; drains in-flight work before SQLite closes. */
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
  const inflight = new Set<Promise<unknown>>();
  const ownedCall = <A>(body: () => Promise<A>): Promise<A> => {
    if (closing) return Promise.reject(new Error('AUTOMATION_OWNER_CLOSING'));
    const owned = body();
    inflight.add(owned);
    void owned.then(
      () => inflight.delete(owned),
      () => inflight.delete(owned)
    );
    return owned;
  };
  const guardedCall = <A>(fallback: A, body: () => Promise<A>): Promise<A> =>
    closing ? Promise.resolve(fallback) : ownedCall(body);

  const delivery = new DeliveryCoordinator({
    ledger,
    manager: lody.documentManager,
    machineId: auth.machineId,
    logger,
  });

  const admissionDeps = {
    ledger,
    lody,
    manager: lody.documentManager,
    authority,
    machineId: auth.machineId,
    userId: auth.userId,
    workspaceId: workspace.id,
    logger,
  };

  const actions = new AutomationSessionActionsLegacy({
    ...options,
    ledger,
    admission: (receipt) => recheckAdmission(admissionDeps, receipt),
    capacity: (bindingId, modelId, receipt) =>
      evaluateAutomationCondition(
        admissionDeps,
        {
          kind: 'provider.capacity.can_dispatch',
          parameters: { bindingId, ...(modelId ? { modelId } : {}) },
        },
        receipt
      ),
  });

  const managedRunLogs = path.join(
    getLodyDataDir(),
    'automations',
    'runs',
    automationIdentity(auth.machineId, workspace.id)
  );

  const reportRun = (cause: unknown) =>
    Effect.sync(() => logger.warn('Managed automation run did not settle', cause));

  let controller!: ReturnType<typeof createAutomationController>;

  // Ledger finalizer is registered before ManagedRuns so LIFO teardown kills runs before closing SQLite.
  const ledgerLifetimeLayer = Layer.effectDiscard(
    Effect.addFinalizer(() => Effect.sync(() => ledger.close()))
  );

  const hostLayer = Layer.effect(
    AutomationHost,
    Effect.gen(function* () {
      const managedRuns = yield* ManagedRunsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // These unfinished Session APIs do not cancel raw I/O. Keep their owner until it settles.
      const sessionCall = <A>(body: () => Promise<A>) =>
        Effect.tryPromise(body).pipe(Effect.uninterruptible);

      const evaluateWait = (wait: AutomationWait) =>
        wait.run
          ? evaluateManagedRun({
              ledger,
              owner: managedRuns,
              claimed: { ...wait, run: wait.run },
              authorizeAndResolveRoot: async (sessionId, ownerUserId) => {
                await controller.sessionContext(sessionId, ownerUserId);
                return lody.resolveAutomationWorkdir(sessionId as SessionId);
              },
            })
          : Effect.tryPromise(() =>
              controller.sessionContext(wait.sessionId, wait.ownerUserId)
            ).pipe(
              Effect.uninterruptible,
              Effect.flatMap(({ context }) =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    evaluateAutomationProgram(
                      wait.program ?? '',
                      { ...context, now },
                      (input) =>
                        Clock.currentTimeMillis.pipe(
                          Effect.flatMap((readNow) =>
                            Effect.tryPromise(() =>
                              readAutomationContext({
                                ledger,
                                manager: lody.documentManager,
                                authority,
                                wait,
                                input,
                                now: readNow,
                              })
                            ).pipe(Effect.uninterruptible)
                          )
                        ),
                      false,
                      (input) =>
                        Effect.tryPromise({
                          try: () => lody.resolveAutomationWorkdir(wait.sessionId as SessionId),
                          catch: () => new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'),
                        }).pipe(
                          Effect.flatMap((root) =>
                            root
                              ? execAutomationCommand(
                                  input,
                                  root,
                                  automationCommandEnvironment()
                                ).pipe(
                                  Effect.provideService(
                                    ChildProcessSpawner.ChildProcessSpawner,
                                    spawner
                                  )
                                )
                              : Effect.fail(new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE'))
                          )
                        )
                    )
                  )
                )
              )
            );

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
        condition: (spec, receipt) =>
          sessionCall(() => evaluateAutomationCondition(admissionDeps, spec, receipt)),
        prepare: (receipt) => sessionCall(() => actions.prepare(receipt)),
        submit: (receipt) => sessionCall(() => actions.submit(receipt)),
        reconcile: (receipt) => sessionCall(() => actions.reconcile(receipt)),
        cancel: (receipt) => sessionCall(() => actions.cancel(receipt)),
        evaluate: evaluateWait,
        report: (cause) =>
          Effect.sync(() => logger.warn('Automation operation did not settle', cause)),
      });
    })
  );

  const appLayer = Layer.unwrap(
    Effect.gen(function* () {
      const wakeQueue = yield* Queue.dropping<void>(1);
      const wakeSignal = Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);

      const managedRunsLayer = Layer.effect(
        ManagedRunsService,
        makeManagedRuns({
          onStarted: (id, pid) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => Effect.try(() => ledger.recordRunPid(id, pid, now))),
              Effect.catchCause((cause) => reportRun(cause))
            ),
          onExit: (id, exit) =>
            Effect.try(() => ledger.recordRunExit(id, exit, exit.endedAt)).pipe(
              Effect.andThen(wakeSignal),
              Effect.catchCause((cause) => reportRun(cause))
            ),
          report: (cause) => reportRun(cause),
        })
      );

      const baseLayer = managedRunsLayer.pipe(
        Layer.provideMerge(ledgerLifetimeLayer),
        Layer.provideMerge(platformLayer({ logger }))
      );
      return Automations.layer(ledger, wakeQueue).pipe(
        Layer.provide(hostLayer),
        Layer.provideMerge(baseLayer)
      );
    })
  );
  const runtime = ManagedRuntime.make(appLayer);

  controller = createAutomationController({
    ledger,
    lody,
    authority,
    workspaceId: workspace.id,
    machineId: auth.machineId,
    managedRunLogs,
    delivery,
    isClosing: () => closing,
    ownedCall,
    runEffect: (effect) => runtime.runPromise(effect),
    verifyRemoteControl: options.verifyRemoteControl,
  });

  let close: Promise<void> | undefined;
  try {
    const service = await runtime.runPromise(Automations);
    const wake = () => guardedCall(undefined, () => runtime.runPromise(service.wake));

    const canSubmit = (
      sessionId: SessionId,
      turnId: string,
      origin: AutomationOrigin,
      binding?: ProviderBinding | null
    ) => !closing && canSubmitAutomationInput(ledger, sessionId, turnId, origin, binding);

    authority.setPendingWork(
      (sessionId, excludingId) => !closing && ledger.hasSessionWork(sessionId, excludingId)
    );
    authority.setObservations({
      stage: (fact) => {
        if (!closing) ledger.stageTurn(fact);
      },
      turn: (fact) =>
        guardedCall(undefined, async () => {
          ledger.stageTurn(fact);
          await runtime.runPromise(service.wake);
        }),
      capacity: (binding, snapshot, source) =>
        guardedCall(undefined, async () => {
          observeCapacity(ledger, binding, snapshot, source, Date.now());
          await runtime.runPromise(service.wake);
        }),
      idle: (sessionId) => {
        void guardedCall(undefined, async () => {
          if (ledger.wakeSessionBlocked(sessionId, Date.now()) > 0) {
            await runtime.runPromise(service.wake);
          }
        }).catch((cause) => logger.debug('Automation idle wake did not settle', cause));
      },
    });
    authority.setAdmission(
      (args) =>
        guardedCall(false, async () => {
          const { sessionId, turnId, userId, origin } = args;
          const receipt = ledger.receipt(origin.invocationId);
          if (!receipt || TERMINAL_STATES.has(receipt.state)) {
            // The input outlived its receipt; leave no zombie for dispatch to re-verify.
            await authority.cancelInput(sessionId, turnId).catch(() => false);
            return false;
          }
          if (origin.authorizationUserId !== userId || !canSubmit(sessionId, turnId, origin))
            return false;
          const verdict = await recheckReceipt(admissionDeps, receipt);
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
        }),
      canSubmit,
      (args) =>
        guardedCall(false, () =>
          canAcceptPendingWork(
            { ledger, manager: lody.documentManager, authority, machineId: auth.machineId },
            args
          )
        )
    );

    return {
      ledger,
      capacityRetryAt: (run: ScheduleRun<PreparedSessionInput>) =>
        guardedCall(undefined, async () => {
          const evaluated = await evaluateBindingCapacity(
            { manager: lody.documentManager, ledger, machineId: auth.machineId },
            run.definition.agent.agentConfigId,
            run.definition.agent.modelId,
            Date.now()
          );
          return evaluated.status === 'evaluated' &&
            evaluated.observation.value === 'no' &&
            evaluated.observation.reason === 'capacity_exhausted'
            ? evaluated.observation.retryAt
            : undefined;
        }),
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
        guardedCall(undefined, async () => {
          observeWorkflows(ledger, meta, repository, headSha, runs, gap, observedAt);
          await runtime.runPromise(service.wake);
        })) satisfies NonNullable<PrPollerWorkspaceHandle['recordWorkflowObservations']>,
      recordObservations: ((meta, repoFullName, observations, observedAt) =>
        guardedCall(undefined, async () => {
          observePullRequests(ledger, meta, repoFullName, observations, observedAt);
          await runtime.runPromise(service.wake);
        })) satisfies NonNullable<PrPollerWorkspaceHandle['recordObservations']>,
      publish: (event: AutomationEvent) =>
        guardedCall(undefined, async () => {
          ledger.publish(event);
          await runtime.runPromise(service.wake);
        }),
      wake,
      command: (
        input: AutomationCommand,
        requesterSessionId?: string,
        source?: { sessionId: string; turnId: string }
      ): Promise<unknown> =>
        ownedCall(async () => {
          const command = automationCommandSchema.parse(input);
          const principal = requesterSessionId
            ? authority.author(requesterSessionId as SessionId)
            : auth.userId;
          if (!principal) throw new Error('AUTOMATION_ACTIVE_AUTHOR_REQUIRED');
          return controller.execute(command, principal, requesterSessionId, source);
        }),
      dispose: () =>
        (close ??= (async () => {
          closing = true;
          authority.setAdmission(undefined);
          authority.setObservations(undefined);
          authority.setPendingWork(undefined);
          const pending = await Promise.allSettled([...inflight]);
          await runtime.dispose();
          const failed = pending.filter((item) => item.status === 'rejected');
          if (failed.length)
            logger.warn(
              'Automation operations ended with errors during shutdown',
              failed.map((item) => item.reason)
            );
        })()),
      remoteControlNonce: controller.remoteControlNonce,
      remoteControl: controller.remoteControl,
    };
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }
}
