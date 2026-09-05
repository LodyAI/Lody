import {
  canonicalScheduleJson,
  getMachineRoomId,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  getScheduleRegistryFlockDocId,
  getScheduleRoomId,
  getServerNow,
  getSessionRoomId,
  hasExplicitSchedulePermission,
  isLoroRepoDocDeleted,
  machineSupportsSchedulesProtocol,
  ScheduleRuntimeRowSchema,
  previewSchedule,
  readMachineFlockRowsFromFlock,
  ScheduleCommandSchema,
  ScheduleRepository,
  validateSchedulePrompt,
  validateScheduleTrigger,
  type AgentConfigId,
  type MachineId,
  type MachineMeta,
  type ScheduleCommand,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { AuthContext } from '../command-runtime';
import type { LoroDocumentManager } from '../loro/doc';
import type { WorkspaceSummary } from '../workspace';
import { readMergedAgentConfigById } from '../agent-config-machine-flock';

export type ScheduleCommandContext = {
  manager: LoroDocumentManager;
  workspace: WorkspaceSummary;
  auth: AuthContext;
  localOnly: boolean;
  requesterSessionId?: SessionId;
};

/** Same domain operations for human CLI and the bounded MCP surface, on either transport. */
export async function executeScheduleCommand(
  context: ScheduleCommandContext,
  input: ScheduleCommand
): Promise<unknown> {
  const command = ScheduleCommandSchema.parse(input);
  const { manager, auth, localOnly, requesterSessionId } = context;
  const workspaceId = context.workspace.id as WorkspaceId;
  const repository = new ScheduleRepository(manager.repo, workspaceId);
  const sync = async (room: string) => {
    if (!localOnly) await manager.syncDocOrThrow(room, { reason: 'schedule:command' });
  };
  if (requesterSessionId) {
    if (!['list', 'show', 'pause', 'propose'].includes(command.action))
      throw new Error('Schedule enablement requires a human action');
    const record = await manager.repo.getDocMeta(getSessionRoomId(requesterSessionId));
    const meta = record?.meta as SessionMeta | undefined;
    if (
      !meta ||
      isLoroRepoDocDeleted(record!) ||
      meta.userId !== auth.userId ||
      meta.machineId !== auth.machineId
    )
      throw new Error('Schedule tools require the invoking Session owner');
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    await sync(session.roomId);
    const history = await session.getHistory();
    const assistant = [...history].reverse().find((entry) => entry.role === 'assistant');
    const turn = history.find(
      (entry) =>
        entry.id === (meta.processingUserMsgId ?? assistant?.userTurnId ?? meta.latestUserMsgId)
    );
    if (turn?.inputConfig?.scheduleToolsEnabled !== true)
      throw new Error('Schedule tools are disabled for the driving Turn');
  }
  const registry = await manager.repo.openFlockDoc(getScheduleRegistryFlockDocId(workspaceId));
  if (!localOnly) await registry.syncOnce();
  if (command.action === 'list') {
    const rows = (await repository.list()).filter(
      (row) => !command.query || row.title.toLowerCase().includes(command.query.toLowerCase())
    );
    rows.sort((a, b) => a.scheduleId.localeCompare(b.scheduleId));
    const offset = command.offset ?? 0;
    const nextOffset = offset + command.limit;
    return {
      schedules: rows.slice(offset, nextOffset),
      matched: rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : undefined,
    };
  }
  if (command.action === 'propose') {
    if (!requesterSessionId) throw new Error('A proposal requires an invoking Session');
    validateScheduleTrigger(command.trigger);
    validateSchedulePrompt(command.prompt);
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    const text = `Scheduled task proposal — review in Schedules before enabling.\n\n\`\`\`json\n${canonicalScheduleJson(command)}\n\`\`\``;
    const entryId = `schedule-proposal-${command.requestId}`;
    await session.updateHistory((history) => {
      const previous = history.find((entry) => entry.id === entryId);
      if (previous) {
        if (
          previous.role !== 'system' ||
          previous.items?.[0]?.type !== 'text' ||
          previous.items[0].text !== text
        )
          throw new Error('Idempotency key conflict');
        return history;
      }
      return [
        ...history,
        {
          id: entryId,
          role: 'system',
          timestamp: new Date(getServerNow()).toISOString(),
          items: [{ type: 'text', text }],
          fileDiff: [],
          finished: true,
        },
      ];
    });
    await manager.repo.flush();
    if (!localOnly && !(await session.waitUntilSynced()))
      throw new Error('Proposal saved locally; sync pending. Retry with the same requestId.');
    return { ok: true, requestId: command.requestId, enabled: false };
  }
  const id = command.scheduleId;
  if (command.action !== 'create' || (await repository.list()).some((row) => row.scheduleId === id))
    await sync(getScheduleRoomId(id));
  if (command.action === 'show') {
    if (!(await repository.list()).some((row) => row.scheduleId === id))
      throw new Error('Schedule not found');
    const document = await repository.read(id);
    if (!document) throw new Error('Schedule not found');
    const runtimes = [...registry.flock.scan({ prefix: ['runtime', id] })].flatMap((row) => {
      const parsed = ScheduleRuntimeRowSchema.safeParse(row.value);
      return parsed.success ? [parsed.data] : [];
    });
    return {
      runtimes,
      schedule: {
        ...document,
        prompt: requesterSessionId ? document.prompt.slice(0, 8000) : document.prompt,
        timeline: document.timeline.slice(-20),
      },
      truncated: {
        promptCharsOmitted: requesterSessionId ? Math.max(0, document.prompt.length - 8000) : 0,
        timelineEntriesOmitted: Math.max(0, document.timeline.length - 20),
      },
      next: previewSchedule(
        document.definition.trigger,
        document.definition.activeFrom,
        getServerNow()
      ),
    };
  }
  const machineId =
    command.action === 'create' || command.action === 'edit'
      ? command.draft.machineId
      : (await repository.read(id))?.definition.machineId;
  if (!machineId) throw new Error('Schedule not found');
  const machineRecord = await manager.repo.getDocMeta(getMachineRoomId(machineId as MachineId));
  const machine = machineRecord?.meta as MachineMeta | undefined;
  const needsTarget = command.action !== 'pause' && command.action !== 'delete';
  if (
    needsTarget &&
    (!machine || isLoroRepoDocDeleted(machineRecord!) || machine.ownerUserId !== auth.userId)
  )
    throw new Error('Schedules can run only on a machine owned by the creator');
  if (needsTarget && !machineSupportsSchedulesProtocol(machine))
    throw new Error('Update the target machine CLI to manage schedules');
  const now = getServerNow();
  if (command.action === 'create' || command.action === 'edit') {
    if (!machine) throw new Error('Target machine is unavailable');
    const { readAgentAcpCapability, resolveTurnDispatchConfig, validateSessionCreateOptions } =
      await import('@/commands/session');
    const draft = command.draft;
    const configId = draft.agent.agentConfigId as AgentConfigId;
    const agent = await readMergedAgentConfigById(manager.repo, workspaceId, machine.id, configId);
    if (!agent.config || agent.config.machineId !== machine.id)
      throw new Error('Selected Agent is unavailable on the target machine');
    const capability = await readAgentAcpCapability({
      manager,
      workspaceId,
      machineId: machine.id,
      agentConfigId: configId,
      localOnly,
    });
    if (!hasExplicitSchedulePermission(draft.agent, capability))
      throw new Error('Choose an explicit permission mode supported by the Agent');
    if (draft.project.kind === 'local') {
      const flock = await manager.repo.openFlockDoc(getMachineFlockDocId(workspaceId, machine.id));
      const projects = getMachineFlockLocalProjects(
        readMachineFlockRowsFromFlock(flock.flock, { families: ['localProject'] })
      );
      if (!projects[draft.project.localProjectId])
        throw new Error('Choose a Project on the target machine');
    }
    if (!localOnly) {
      const { buildProjectOptions } = await import('../task-automation/task-automation-start');
      await validateSessionCreateOptions({
        auth,
        workspace: context.workspace,
        manager,
        options: {
          machine: machine.id,
          agentConfig: configId,
          ...buildProjectOptions(draft.project),
        },
        dispatchConfig: { ...resolveTurnDispatchConfig({}), ...draft.agent },
        skipMachineAvailabilityCheck: true,
      });
    }
    await repository.save({
      scheduleId: id,
      draft,
      actorId: auth.userId,
      now,
      activationId: command.requestId,
      activityId: command.requestId,
      create: command.action === 'create',
    });
  } else if (command.action === 'pause' || command.action === 'resume') {
    await repository.setEnabled({
      scheduleId: id,
      enabled: command.action === 'resume',
      actorId: auth.userId,
      now,
      activationId: command.requestId,
      requestId: command.requestId,
      requesterSessionId,
    });
  } else if (command.action === 'run')
    await repository.requestRun({
      scheduleId: id,
      actorId: auth.userId,
      manualRunId: command.requestId,
      now,
    });
  else await repository.delete(id, auth.userId, now);
  if (!localOnly) {
    await (await manager.repo.openPersistedDoc(getScheduleRoomId(id))).syncOnce();
    await registry.syncOnce();
  }
  if (command.action === 'pause' && requesterSessionId) {
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    const entryId = `schedule-paused-${command.requestId}`;
    const title = (await repository.read(id))?.definition.title ?? id;
    await session.updateHistory((history) =>
      history.some((entry) => entry.id === entryId)
        ? history
        : [
            ...history,
            {
              id: entryId,
              role: 'system',
              timestamp: new Date(now).toISOString(),
              items: [
                {
                  type: 'text',
                  text: `Paused scheduled task: ${title}. Future runs stop after the owner machine syncs. Already submitted Sessions continue.`,
                },
              ],
              fileDiff: [],
              finished: true,
            },
          ]
    );
    await manager.repo.flush();
    if (!localOnly && !(await session.waitUntilSynced()))
      throw new Error('Pause saved; notification sync pending. Retry with the same requestId.');
  }
  return { ok: true, scheduleId: id };
}
