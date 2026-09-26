import {
  DEFAULT_SCHEDULE_DESTINATION,
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
  scheduleProposalRuleToTrigger,
  validateSchedulePrompt,
  type AgentConfigId,
  type MachineId,
  type MachineMeta,
  type ScheduleCommand,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { readSessionHistory } from '@lody/shared/session-data';
import type { AuthContext } from '../command-runtime';
import type { LoroDocumentManager } from '../loro/doc';
import type { WorkspaceSummary } from '../workspace';
import { readMergedAgentConfigById } from '../agent-config-machine-flock';
import { publishScheduleProposal } from './schedule-proposal';
import {
  destinationSessionProblem,
  scheduleDestinationSessionId,
} from './schedule-run-preparation';

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
    // Proposal and pause notices are idempotent by entry id; read them from a
    // synced Session so a repeated call sees the notice it already published.
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    await sync(session.roomId);
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
    // The rule must already be a schedule the editor could show, so a card the
    // person confirms cannot fail validation afterwards.
    scheduleProposalRuleToTrigger(command.rule, getServerNow());
    validateSchedulePrompt(command.prompt);
    const session = await manager.getOrCreateSessionDoc(requesterSessionId);
    const sessionRecord = await manager.repo.getDocMeta(getSessionRoomId(requesterSessionId));
    const sessionMeta = sessionRecord?.meta as SessionMeta | undefined;
    const actorConfig = sessionMeta?.agentConfigId
      ? await readMergedAgentConfigById(
          manager.repo,
          workspaceId,
          auth.machineId as MachineId,
          sessionMeta.agentConfigId as AgentConfigId
        ).catch(() => undefined)
      : undefined;
    const outcome = await publishScheduleProposal(
      session,
      {
        proposalId: command.requestId,
        title: command.title,
        prompt: command.prompt,
        rule: command.rule,
        ...(command.destination ? { destination: command.destination } : {}),
        ...(command.target ? { target: command.target } : {}),
      },
      {
        ...(sessionMeta?.agentConfigId ? { agentConfigId: sessionMeta.agentConfigId } : {}),
        ...(actorConfig?.config?.name ? { name: actorConfig.config.name } : {}),
      }
    );
    await manager.repo.flush();
    if (!localOnly && !(await session.waitUntilSynced()))
      throw new Error('Proposal saved locally; sync pending. Retry with the same requestId.');
    return { ok: true, requestId: command.requestId, enabled: false, ...outcome };
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
    if (draft.project?.kind === 'local') {
      const flock = await manager.repo.openFlockDoc(getMachineFlockDocId(workspaceId, machine.id));
      const projects = getMachineFlockLocalProjects(
        readMachineFlockRowsFromFlock(flock.flock, { families: ['localProject'] })
      );
      if (!projects[draft.project.localProjectId])
        throw new Error('Choose a Project on the target machine');
    }
    const destination = draft.destination ?? DEFAULT_SCHEDULE_DESTINATION;
    const destinationSessionId = scheduleDestinationSessionId(id, destination);
    if (destinationSessionId) {
      // A shared chat carries its own workspace; a schedule sending into one
      // must not also claim a project of its own.
      if (draft.project) throw new Error('A schedule that sends into a chat has no project');
      await sync(getSessionRoomId(destinationSessionId));
      const sessionRecord = await manager.repo.getDocMeta(getSessionRoomId(destinationSessionId));
      const problem = destinationSessionProblem({
        destination,
        session: !sessionRecord?.meta
          ? { kind: 'absent' }
          : isLoroRepoDocDeleted(sessionRecord)
            ? { kind: 'deleted' }
            : { kind: 'present', meta: sessionRecord.meta as SessionMeta },
        userId: auth.userId,
        machineId: machine.id,
        agentConfigId: configId,
      });
      if (problem)
        throw new Error(
          destination.kind === 'existing_session'
            ? 'Choose one of your own chats on the target machine, driven by the same Agent'
            : 'This schedule’s chat uses a different Agent; start a new chat to change it'
        );
    }
    if (!localOnly) {
      const { buildProjectOptions } = await import('./schedule-project-options');
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
    if (!readSessionHistory(session.sessionData.history).some((entry) => entry.id === entryId))
      await session.sessionData.commands.appendTurn({
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
      });
    await manager.repo.flush();
    if (!localOnly && !(await session.waitUntilSynced()))
      throw new Error('Pause saved; notification sync pending. Retry with the same requestId.');
  }
  return { ok: true, scheduleId: id };
}
