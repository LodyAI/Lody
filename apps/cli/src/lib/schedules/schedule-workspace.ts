import type { RepoRoomSubscription } from 'loro-repo';
import {
  canonicalScheduleJson,
  getScheduleRegistryFlockDocId,
  getScheduleRoomId,
  getServerNow,
  getSessionRoomId,
  getTaskIndexFlockDocId,
  isLoroRepoDocDeleted,
  ScheduleRepository,
  scheduleDefinitionFingerprint,
  scheduleRegistryKeys,
  ScheduleRuntimeRowSchema,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
  getMachineRoomId,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  readMachineFlockRowsFromFlock,
  type MachineMeta,
  type AgentConfigId,
  hasExplicitSchedulePermission,
} from '@lody/shared';
import type { AuthContext } from '../command-runtime';
import type { WorkspaceSummary } from '../workspace';
import type { LoroDocumentManager } from '../loro/doc';
import type { Logger } from '@/utils/logger';
import { streamsRoomBinding } from '../loro/streams-room-binding';
import { buildProjectOptions } from '../task-automation/task-automation-start';
import { readTaskIndexRowsForWorkspace } from '../task-automation/task-automation-scheduler';
import { hasPendingUserTurnActivation } from '@/session/session-dispatch-logic';
import { AgentExecutionSlots } from '../agent-execution-slots';
import { readMergedAgentConfigById } from '../agent-config-machine-flock';
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';
import { createScheduleSyncGate } from './schedule-sync-gate';
import { ScheduleStore } from './schedule-store';
import { ScheduleEngine, ScheduleConfigurationError } from './schedule-engine';

export type ScheduleWorkspaceHandle = {
  evaluate: () => Promise<void>;
  dispose: () => Promise<void>;
};

export async function createScheduleWorkspace(args: {
  manager: LoroDocumentManager;
  workspace: WorkspaceSummary;
  auth: AuthContext;
  localOnly: boolean;
  slots: AgentExecutionSlots;
  logger: Logger;
  hasSessionWork: (sessionId: SessionId) => boolean;
}): Promise<ScheduleWorkspaceHandle> {
  const { manager, workspace, auth, slots } = args;
  const workspaceId = workspace.id as WorkspaceId;
  const repository = new ScheduleRepository(manager.repo, workspaceId);
  const store = new ScheduleStore<PreparedSessionInput>();
  const registry = await manager.repo.openFlockDoc(getScheduleRegistryFlockDocId(workspaceId));
  const taskIndex = await manager.repo.openFlockDoc(getTaskIndexFlockDocId(workspaceId));
  const subscriptions: RepoRoomSubscription[] = [];
  const cleanups: (() => void)[] = [];
  let disposed = false;
  let cloudGate: ReturnType<typeof createScheduleSyncGate> | undefined;
  const isReady = () => args.localOnly || cloudGate?.isReady() === true;
  const disabled = process.env.LODY_SCHEDULES_DISABLED === '1';
  const resolveTarget = async (
    run: import('./schedule-store').ScheduleRun<PreparedSessionInput>
  ) => {
    const { readAgentAcpCapability } = await import('@/commands/session');
    const agent = run.definition.agent;
    const machineRecord = await manager.repo.getDocMeta(getMachineRoomId(auth.machineId));
    const machine = machineRecord?.meta as MachineMeta | undefined;
    const agentConfig = await readMergedAgentConfigById(
      manager.repo,
      workspaceId,
      auth.machineId,
      agent.agentConfigId as AgentConfigId
    );
    if (
      !machine ||
      isLoroRepoDocDeleted(machineRecord!) ||
      machine.ownerUserId !== auth.userId ||
      !agentConfig.config ||
      agentConfig.config.machineId !== auth.machineId
    )
      throw new ScheduleConfigurationError('OWNER_OR_AGENT_UNAVAILABLE');
    if (run.definition.project.kind === 'local') {
      const flock = await manager.repo.openFlockDoc(
        getMachineFlockDocId(workspaceId, auth.machineId)
      );
      const projects = getMachineFlockLocalProjects(
        readMachineFlockRowsFromFlock(flock.flock, { families: ['localProject'] })
      );
      if (!projects[run.definition.project.localProjectId])
        throw new ScheduleConfigurationError('PROJECT_UNAVAILABLE');
    }
    const capability = await readAgentAcpCapability({
      manager,
      workspaceId,
      machineId: auth.machineId,
      agentConfigId: agent.agentConfigId as AgentConfigId,
      localOnly: true,
    });
    if (!hasExplicitSchedulePermission(agent, capability))
      throw new ScheduleConfigurationError('PERMISSION_UNAVAILABLE');
    return {
      targetMachine: machine,
      agentConfig: agentConfig.config,
      project: run.definition.project,
    };
  };
  const engine = new ScheduleEngine<PreparedSessionInput>({
    workspaceId,
    machineId: auth.machineId,
    userId: auth.userId,
    store,
    slots,
    now: getServerNow,
    disabled: () => disabled || disposed,
    ready: isReady,
    list: () => repository.list(),
    read: async (id) => {
      if (!args.localOnly)
        await manager.syncDocOrThrow(getScheduleRoomId(id), { reason: 'schedule:definition' });
      return repository.read(id);
    },
    validateTarget: async (run) => {
      await resolveTarget(run);
    },
    prepare: async (run) => {
      const { prepareSessionInput, resolveTurnDispatchConfig } = await import('@/commands/session');
      const agent = run.definition.agent;
      const target = await resolveTarget(run);
      const prepared = await prepareSessionInput(
        auth,
        workspace,
        manager,
        run.prompt,
        {
          agentConfig: agent.agentConfigId,
          sessionId: run.sessionId as SessionId,
          userTurnId: run.userTurnId,
          title: run.definition.title,
          workspaceMetaPrewriteSatisfied: true,
          ...buildProjectOptions(run.definition.project),
        },
        {
          ...resolveTurnDispatchConfig({}),
          ...agent,
          scheduleToolsEnabled: true,
          inheritSessionDefaults: false,
        },
        target
      );
      if (prepared.meta.machineId !== run.machineId || prepared.meta.userId !== auth.userId)
        throw new Error('Schedule target ownership changed');
      prepared.meta.scheduleId = run.scheduleId;
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
    dispatch: (prepared) => commitPreparedSessionDispatch(manager, prepared),
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
      if ((await session.getMessageQueue()).length) return false;
      const history = await session.getHistory();
      return (
        !args.hasSessionWork(id) &&
        history.some(
          (entry) =>
            (entry.id === run.userTurnId &&
              ['handled', 'failed', 'canceled'].includes(entry.status ?? '')) ||
            (entry.role === 'assistant' &&
              entry.userTurnId === run.userTurnId &&
              (entry.finished === true || typeof entry.endedAt === 'number'))
        )
      );
    },
    publish: async (runtime) => {
      const key = scheduleRegistryKeys.runtime(runtime.scheduleId, auth.machineId);
      const prior = ScheduleRuntimeRowSchema.safeParse(registry.flock.get(key));
      // Keep the last accepted Session while updating queue/next-fire fields.
      const next = {
        ...runtime,
        lastDispatch: runtime.lastDispatch ?? (prior.success ? prior.data.lastDispatch : undefined),
      };
      if (
        prior.success &&
        canonicalScheduleJson({ ...prior.data, updatedAt: 0 }) ===
          canonicalScheduleJson({ ...next, updatedAt: 0 })
      )
        return;
      registry.flock.set(key, JSON.parse(JSON.stringify(next)));
      await manager.repo.flush();
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
  engine.restoreOccupancy();
  slots.replaceTaskOccupancy(
    await readTaskIndexRowsForWorkspace(manager.repo, workspaceId),
    auth.userId
  );

  const pass = async (): Promise<void> => {
    if (disposed) return;
    const tasks = await readTaskIndexRowsForWorkspace(manager.repo, workspaceId);
    if (disposed) return;
    slots.replaceTaskOccupancy(tasks, auth.userId);
    if (isReady() && !disabled) {
      const rows = await repository.list();
      for (const entry of registry.flock.scan({ prefix: ['manual'] })) {
        const request = entry.value as unknown as {
          scheduleId: string;
          actorId: string;
          manualRunId: string;
          activationId: string;
          requestedAt: number;
        };
        if (
          !request ||
          entry.key.length !== 3 ||
          entry.key[1] !== request.scheduleId ||
          entry.key[2] !== request.manualRunId ||
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
  cleanups.push(
    registry.flock.subscribe(wake),
    taskIndex.flock.subscribe(wake),
    slots.subscribe(wake)
  );

  // One short timer is also the wake-from-sleep clock check. No per-Schedule
  // timer survives a definition edit, and evaluation coalesces in the engine.
  const timer = setInterval(wake, 15_000);
  timer.unref();
  for (const handle of [registry, taskIndex]) {
    const sub = await handle.joinRoom();
    subscriptions.push(sub);
    if (handle === registry && !args.localOnly) {
      const binding = streamsRoomBinding(sub);
      cloudGate = createScheduleSyncGate(binding, wake, () =>
        args.logger.warn('[schedules] Registry synchronization pending')
      );
      cleanups.push(cloudGate.dispose);
    }
  }
  wake();
  return {
    evaluate,
    dispose: async () => {
      disposed = true;
      clearInterval(timer);
      for (const cleanup of cleanups) cleanup();
      for (const sub of subscriptions) sub.unsubscribe();
      await evaluating;
      await engine.stop();
      store.close();
    },
  };
}
