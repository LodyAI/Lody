import { notificationLabel } from '@lody/shared/notifications';
import {
  getScheduleRoomId,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  ScheduleRepository,
  ScheduledMessageSchema,
  scheduleDefinitionFingerprint,
  type ScheduleAuthorizationRequest,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
  getMachineRoomId,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  readMachineFlockRowsFromFlock,
  type MachineMeta,
  type AgentConfigId,
  hasPendingUserTurnActivation,
} from '@lody/shared';
import type { AuthContext } from '../command-runtime';
import type { WorkspaceSummary } from '../workspace';
import type { LoroDocumentManager } from '../loro/doc';
import type { Logger } from '@/utils/logger';
import { createSessionBackend } from '@/session/session-backend';
import {
  buildScheduleRunTarget,
  withScheduledMessageInput,
  resolveScheduleAgentRunConfig,
  buildScheduleSessionCreateOptions,
  destinationSessionProblem,
  scheduleDestinationSessionId,
  scheduleRequiredLocalProjectId,
} from './schedule-run-preparation';
import { readMergedAgentConfigById } from '../agent-config-machine-flock';
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';
import { ScheduleStore } from './schedule-store';
import { ScheduleEngine, ScheduleConfigurationError } from './schedule-engine';
import { isQuotaReservationCandidate } from './quota-reservation';

// Ticks plan Schedules serially, so this wait delays every other Schedule. A
// timeout blocks only this definition until the next tick retries it.
const DEFINITION_SYNC_TIMEOUT_MS = 8_000;

export type ScheduleWorkspaceHandle = {
  evaluate: () => Promise<void>;
  dispose: () => Promise<void>;
};

export async function createScheduleWorkspace(args: {
  manager: LoroDocumentManager;
  workspace: WorkspaceSummary;
  auth: AuthContext;
  localOnly: boolean;
  authorize?: (request: ScheduleAuthorizationRequest) => Promise<boolean>;
  logger: Logger;
  /** Run completion: the chat's own Turns plus delegated Operations it still awaits. */
  hasSessionWork: (sessionId: SessionId) => boolean;
  dispatchQuotaSchedule: (
    run: import('./schedule-store').ScheduleRun<PreparedSessionInput>,
    prepared: PreparedSessionInput
  ) => Promise<'dispatched' | 'discarded'>;
  /** Message admission: only work that occupies the chat's own Turns. */
  hasSessionTurnWork: (sessionId: SessionId) => boolean;
  /** Quota reset time for a definitively exhausted agent binding; see ScheduleEnginePorts. */
  capacityRetryAt?: (
    run: import('./schedule-store').ScheduleRun<PreparedSessionInput>
  ) => Promise<number | undefined>;
}): Promise<ScheduleWorkspaceHandle> {
  const { manager, workspace, auth } = args;
  const workspaceId = workspace.id as WorkspaceId;
  const catalog = manager.getMachineCatalogRuntimePort?.();
  const machineCatalog = catalog?.binding.machineId === auth.machineId ? catalog : undefined;
  const repository = new ScheduleRepository(manager.repo, workspaceId, {
    registry: manager.scheduleRegistry,
    definitions: manager.scheduleDefinitions,
  });
  const store = new ScheduleStore<PreparedSessionInput>();
  const registry = manager.scheduleRegistry;
  const cleanups: (() => void)[] = [];
  let disposed = false;
  let registrySynced = false;
  const isReady = () => args.localOnly || registrySynced;
  const disabled = process.env.LODY_SCHEDULES_DISABLED === '1';
  const resolveTarget = async (
    run: import('./schedule-store').ScheduleRun<PreparedSessionInput>
  ) => {
    const agent = run.definition.agent;
    const machineRecord = await manager.repo.getDocMeta(getMachineRoomId(auth.machineId));
    const machine = machineRecord?.meta as MachineMeta | undefined;
    const agentConfig = await readMergedAgentConfigById(
      manager.repo,
      workspaceId,
      auth.machineId,
      agent.agentConfigId as AgentConfigId,
      machineCatalog
    );
    if (
      !machine ||
      isLoroRepoDocDeleted(machineRecord!) ||
      machine.ownerUserId !== auth.userId ||
      !agentConfig.config ||
      agentConfig.config.machineId !== auth.machineId
    )
      throw new ScheduleConfigurationError('OWNER_OR_AGENT_UNAVAILABLE');
    // A schedule without a project is a plain chat run; there is no working
    // directory to validate, and no local ledger entry to require.
    const project = run.definition.project;
    const requiredLocalProjectId = scheduleRequiredLocalProjectId(project);
    if (requiredLocalProjectId !== undefined) {
      const projects = machineCatalog
        ? (await machineCatalog.readCatalog()).projects
        : getMachineFlockLocalProjects(
            readMachineFlockRowsFromFlock(
              (await manager.repo.openFlockDoc(getMachineFlockDocId(workspaceId, auth.machineId)))
                .flock,
              { families: ['localProject'] }
            )
          );
      if (!projects[requiredLocalProjectId])
        throw new ScheduleConfigurationError('PROJECT_UNAVAILABLE');
    }
    const destinationSessionId = scheduleDestinationSessionId(
      run.definition.scheduleId,
      run.definition.destination
    );
    if (destinationSessionId) {
      const sessionRecord = await manager.repo.getDocMeta(getSessionRoomId(destinationSessionId));
      const problem = destinationSessionProblem({
        destination: run.definition.destination,
        session: !sessionRecord?.meta
          ? { kind: 'absent' }
          : isLoroRepoDocDeleted(sessionRecord)
            ? { kind: 'deleted' }
            : { kind: 'present', meta: sessionRecord.meta as SessionMeta },
        userId: auth.userId,
        machineId: auth.machineId,
        agentConfigId: agent.agentConfigId,
      });
      if (problem || (run.message && (sessionRecord?.meta as SessionMeta | undefined)?.isArchived))
        throw new ScheduleConfigurationError(problem ?? 'SESSION_UNAVAILABLE');
      // A timed message waits for this chat rather than interrupting its active turn.
      // Delegated Operations still running elsewhere do not occupy this chat.
      if (run.message && args.hasSessionTurnWork(destinationSessionId))
        throw new ScheduleConfigurationError('SESSION_BUSY');
    }
    return buildScheduleRunTarget({
      targetMachine: machine,
      agentConfig: agentConfig.config,
      project,
    });
  };
  const engine = new ScheduleEngine<PreparedSessionInput>({
    ...(args.capacityRetryAt ? { capacityRetryAt: args.capacityRetryAt } : {}),
    workspaceId,
    machineId: auth.machineId,
    userId: auth.userId,
    store,
    now: getServerNow,
    disabled: () => disabled || disposed,
    ready: isReady,
    encrypted: workspace.contentMode === 'e2ee',
    authorize: args.authorize,
    list: () => repository.list(),
    read: async (id) => {
      if (!args.localOnly)
        await manager.syncDocOrThrow(getScheduleRoomId(id), {
          reason: 'schedule:definition',
          timeoutMs: DEFINITION_SYNC_TIMEOUT_MS,
        });
      return repository.read(id);
    },
    validateTarget: async (run) => {
      await resolveTarget(run);
    },
    prepare: async (run) => {
      const { prepareSessionInput, resolveTurnDispatchConfig } = await import('@/commands/session');
      const target = await resolveTarget(run);
      const agent = await resolveScheduleAgentRunConfig(
        manager,
        workspaceId,
        auth.machineId,
        run.definition.agent
      );
      let prepared = await prepareSessionInput(
        auth,
        workspace,
        manager,
        run.prompt,
        {
          ...buildScheduleSessionCreateOptions({
            sessionId: run.sessionId as SessionId,
            userTurnId: run.userTurnId,
            agentConfigId: agent.agentConfigId,
            title: run.definition.title,
            project: run.definition.project,
          }),
          ...(run.message
            ? {
                agentRoleId: run.message.agentRoleId ?? undefined,
                agentRoleRevision: run.message.agentRoleRevision,
                agentRoleSnapshot: run.message.agentRoleSnapshot,
                agentRolePromptPrefix: run.message.rolePromptPrefix,
              }
            : {}),
        },
        {
          ...resolveTurnDispatchConfig({}),
          ...agent,
          inheritSessionDefaults: false,
          ...(run.message?.mcpServerIds ? { mcpServerIds: run.message.mcpServerIds } : {}),
        },
        target
      );
      if (run.message) {
        const inputBlocks = run.message.inputBlocks;
        if (
          inputBlocks.some(
            (block) =>
              block.type === 'local_attachment' &&
              (workspace.contentMode === 'e2ee' || block.machineId !== run.machineId)
          )
        )
          throw new Error('Local attachment belongs to another machine');
        prepared = withScheduledMessageInput(
          prepared,
          ScheduledMessageSchema.parse({ ...run.message, inputBlocks })
        );
      }
      if (prepared.meta.machineId !== run.machineId || prepared.meta.userId !== auth.userId)
        throw new Error('Schedule target ownership changed');
      prepared.meta.scheduleId = run.scheduleId;
      prepared.userTurn.scheduleRun = {
        scheduleId: run.scheduleId,
        turnId: prepared.userTurn.id,
        title: notificationLabel(run.definition.title) ?? '',
        ...(workspace.contentMode === 'e2ee'
          ? {
              definitionFingerprint: run.definitionFingerprint,
              ...(run.manual ? { manualRunKey: run.runKey } : {}),
            }
          : {}),
      };
      prepared.source = {
        id: run.sourceEntryId,
        role: 'system',
        timestamp: new Date(run.plannedAt).toISOString(),
        items: [
          {
            type: 'text',
            text: `Scheduled task: ${run.definition.title}\nSchedule: ${run.scheduleId}\nScheduled for: ${new Date(run.scheduledFor).toISOString()}`,
          },
        ],
        fileDiff: [],
        finished: true,
      };
      return prepared;
    },
    materialize: (prepared) => materializePreparedSessionInput(manager, prepared),
    isDispatched: (prepared) => isPreparedSessionDispatched(manager, prepared),
    dispatch: async (prepared, run) => {
      if (workspace.contentMode !== 'e2ee' && isQuotaReservationCandidate(run))
        return args
          .dispatchQuotaSchedule(run, prepared)
          .then((result) => (result === 'discarded' ? result : undefined));
      await commitPreparedSessionDispatch(manager, prepared);
    },
    isFinished: async (run) => {
      const id = run.sessionId as SessionId;
      if (args.hasSessionWork(id)) return false;
      const record = await manager.repo.getDocMeta(getSessionRoomId(id));
      if (!record) return false;
      if (isLoroRepoDocDeleted(record)) return true;
      const meta = record.meta as SessionMeta;
      if (
        hasPendingUserTurnActivation(meta) ||
        (meta.messageQueueUpdatedAt ?? 0) > (meta.messageQueueCheckedAt ?? 0)
      )
        return false;
      const session = await manager.getOrCreateSessionDoc(id);
      const backend = await createSessionBackend(session, meta);
      if ((await backend.getMessageQueue()).length) return false;
      const [userRead, assistantRead] = await Promise.all([
        backend.readTurn(run.userTurnId),
        backend.readTurn(`assistant:${run.userTurnId}`),
      ]);
      const userTurn = userRead.state === 'ready' ? userRead.turn : undefined;
      const assistantTurn = assistantRead.state === 'ready' ? assistantRead.turn : undefined;
      return (
        !args.hasSessionWork(id) &&
        ((userTurn?.id === run.userTurnId &&
          ['handled', 'failed', 'canceled'].includes(userTurn.status ?? '')) ||
          (assistantTurn?.role === 'assistant' &&
            assistantTurn.userTurnId === run.userTurnId &&
            (assistantTurn.finished === true || typeof assistantTurn.endedAt === 'number')))
      );
    },
    publish: async (runtime) => {
      const result = await registry.execute({
        kind: 'put-runtime',
        runtime: { ...runtime, machineId: auth.machineId },
      });
      if (result.changed) await registry.flush();
    },
    // Do not log prompts, config values, credentials or provider exception text.
    onEvent: ({ runKey, ...event }) => {
      const run = runKey ? store.get(runKey) : undefined;
      args.logger.debug(
        `[schedules] ${JSON.stringify({
          workspaceId,
          ...event,
          runKeyHash: runKey?.slice(0, 12),
          activationId: run?.activationId,
          attempt: run?.attempts,
          scheduledFor: run?.scheduledFor ?? event.scheduledFor,
          latencyMs: run ? Math.max(0, getServerNow() - run.scheduledFor) : undefined,
        })}`
      );
    },
    onError: () =>
      args.logger.warn(
        `[schedules] evaluation failed workspaceId=${workspaceId}; see Schedule runtime state`
      ),
  });

  const pass = async (): Promise<void> => {
    if (disposed) return;
    if (isReady() && !disabled) {
      try {
        await repository.pruneExpiredMessages({
          now: getServerNow(),
          ownerId: auth.userId,
          machineId: auth.machineId,
        });
      } catch {
        args.logger.warn('[schedules] retention sweep failed; will retry');
      }
      const rows = await repository.list();
      for (const request of (await registry.read()).manuals) {
        if (
          !request ||
          request.actorId !== auth.userId ||
          !/^[a-zA-Z0-9_-]{1,50}$/.test(request.manualRunId) ||
          !Number.isFinite(request.requestedAt) ||
          request.requestedAt > getServerNow()
        )
          continue;
        const row = rows.find(
          (r) =>
            r.scheduleId === request.scheduleId &&
            r.ownerId === auth.userId &&
            r.machineId === auth.machineId &&
            r.activationId === request.activationId
        );
        if (!row || getServerNow() - request.requestedAt > 24 * 60 * 60 * 1000) continue;
        const document = await repository.read(request.scheduleId);
        if (document && scheduleDefinitionFingerprint(document) === row.definitionFingerprint)
          store.planManual(
            workspaceId,
            document,
            row.definitionFingerprint,
            request.manualRunId,
            request.requestedAt
          );
      }
    }
    await engine.evaluate();
  };
  let evaluating: Promise<void> | undefined;
  let dirty = false;
  const evaluate = (): Promise<void> => {
    dirty = true;
    return (evaluating ??= (async () => {
      while (dirty) {
        if (disposed) break;
        dirty = false;
        await pass();
      }
    })().finally(() => {
      evaluating = undefined;
    }));
  };
  const wake = (): void => {
    void evaluate().catch(() => args.logger.warn('[schedules] wake failed'));
  };
  let observation: Awaited<ReturnType<typeof registry.observe>> | undefined;
  let observerPending: Promise<void> | undefined;
  let observerRetries = 0;
  const observationError = (error: unknown) => {
    if (disposed) return;
    registrySynced = false;
    args.logger.warn('[schedules] Registry synchronization pending');
    if ((error as { code?: string })?.code === 'restart_required' && observerRetries++ < 3)
      queueMicrotask(() => {
        if (!disposed) void observeRegistry().catch(observationError);
      });
  };
  const observeRegistry = (): Promise<void> => {
    const previous = observerPending;
    const pending = (async () => {
      if (previous) await previous;
      if (observation) {
        await observation.close();
        observation = undefined;
      }
      if (disposed) return;
      const acquired = await registry.observe((snapshot) => {
        if (!disposed) {
          registrySynced = snapshot.synced;
          wake();
        }
      }, observationError);
      observation = acquired;
      if (disposed) {
        await acquired.close();
        if (observation === acquired) observation = undefined;
      }
    })();
    observerPending = pending;
    return pending;
  };
  try {
    await observeRegistry();
  } catch (error) {
    disposed = true;
    const failures: unknown[] = [error];
    try {
      await observation?.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      await engine.stop();
      store.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    throw new AggregateError(failures, 'Schedule workspace startup failed');
  }

  // One short timer is also the wake-from-sleep clock check. No per-Schedule
  // timer survives a definition edit, and evaluation coalesces in the engine.
  const timer = setInterval(wake, 15_000);
  timer.unref();
  wake();
  return {
    evaluate,
    dispose: async () => {
      disposed = true;
      clearInterval(timer);
      for (const cleanup of cleanups) cleanup();
      const failures: unknown[] = [];
      try {
        await observerPending;
        await observation?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await evaluating;
        await engine.stop();
        store.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Schedule workspace cleanup unconfirmed');
    },
  };
}
