import type { Flock } from '@loro-dev/flock-wasm/base64';
import type { z } from 'zod/v4';
import type {
  ScheduleDraft,
  ScheduleItem,
  ScheduleProject,
  ScheduleRule,
} from '../../contract/schedules.ts';
import {
  SCHEDULES_PROMPT_PROTOCOL_VERSION,
  applyScheduleRecurrence,
  describeScheduleState,
  deviceTimeZone,
  triggerToRecurrence,
  type ScheduleDestination,
  type ScheduleDocument,
  type ScheduleProjectRef,
  type ScheduleRecurrence,
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
  type ScheduleTrigger,
} from '../../protocol/schedules.ts';
import { creationOptions, machineMeta } from '../create-session';
import {
  scheduleRepository,
  scheduleStreams,
  type ScheduleDraftInput,
} from '../schedules';
import type { RuntimeContext } from './context.ts';

type Rule = z.infer<typeof ScheduleRule>;
type Item = z.infer<typeof ScheduleItem>;
type Project = z.infer<typeof ScheduleProject>;
type Draft = z.infer<typeof ScheduleDraft>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function triggerSummary(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'cron')
    return `${trigger.expression} (${trigger.timeZone})`;
  if (trigger.kind === 'interval')
    return `every ${Math.round(trigger.everyMs / 1000)}s from ${trigger.anchorAt}`;
  if (trigger.kind === 'once') return trigger.at;
  return 'manual';
}

/** The stored trigger as the editor's named rule. */
export function ruleOf(trigger: ScheduleTrigger): Rule {
  if (trigger.kind === 'manual') return { kind: 'manual' };
  const recurrence = triggerToRecurrence(trigger);
  switch (recurrence.kind) {
    case 'once':
      return { kind: 'once', at: Date.parse(recurrence.at) };
    case 'unsupported':
      return { kind: 'unsupported', summary: triggerSummary(trigger) };
    case 'minutes':
    case 'hours':
      return {
        kind: recurrence.kind,
        every: recurrence.every,
        timeZone: recurrence.timeZone,
      };
    case 'weekly':
      return { ...recurrence };
    case 'monthly':
      return { ...recurrence };
    default:
      return { ...recurrence };
  }
}

const whole = (value: number | undefined) =>
  typeof value === 'number' && Number.isInteger(value) ? value : NaN;

/** The editor's rule as a trigger; untouched rules re-emit `previous` verbatim. */
export function triggerOf(
  rule: Rule,
  zone: string,
  now: number,
  previous?: ScheduleTrigger,
): ScheduleTrigger {
  const timeZone = rule.timeZone || zone;
  let recurrence: ScheduleRecurrence | null;
  switch (rule.kind) {
    case 'manual':
      recurrence = null;
      break;
    case 'once':
      if (typeof rule.at !== 'number' || !Number.isFinite(rule.at))
        throw new Error('schedule_trigger_invalid');
      recurrence = { kind: 'once', at: new Date(rule.at).toISOString() };
      break;
    case 'unsupported': {
      if (
        !previous ||
        previous.kind === 'manual' ||
        triggerToRecurrence(previous).kind !== 'unsupported'
      )
        throw new Error('schedule_trigger_invalid');
      return previous;
    }
    case 'minutes':
    case 'hours':
      recurrence = { kind: rule.kind, every: whole(rule.every), timeZone };
      break;
    case 'weekly':
      recurrence = {
        kind: 'weekly',
        weekdays: rule.weekdays ?? [],
        hour: whole(rule.hour),
        minute: whole(rule.minute),
        timeZone,
      };
      break;
    case 'monthly':
      recurrence = {
        kind: 'monthly',
        days: rule.days ?? [],
        hour: whole(rule.hour),
        minute: whole(rule.minute),
        timeZone,
      };
      break;
    default:
      recurrence = {
        kind: rule.kind,
        hour: whole(rule.hour),
        minute: whole(rule.minute),
        timeZone,
      };
  }
  try {
    return applyScheduleRecurrence(recurrence, now, previous);
  } catch {
    throw new Error('schedule_trigger_invalid');
  }
}

function projectRef(
  project: Project | undefined,
): ScheduleProjectRef | undefined {
  if (!project) return undefined;
  if (project.kind === 'github') {
    const repoFullName = project.repoFullName?.trim() ?? '';
    const branch = project.branch?.trim() ?? '';
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName) || !branch)
      throw new Error('schedule_invalid');
    return { kind: 'github', repoFullName, branch };
  }
  const localProjectId = project.localProjectId?.trim() ?? '';
  if (!localProjectId) throw new Error('schedule_invalid');
  const branch = project.branch?.trim();
  return {
    kind: 'local',
    localProjectId,
    ...(branch ? { branch } : {}),
    ...(project.useWorktree !== undefined
      ? { useWorktree: project.useWorktree }
      : {}),
  };
}

/** A machine as schedules see it: owner, clock and schedule protocol support. */
export function scheduleMachine(meta: Flock, machineId: string) {
  const fields = machineMeta(meta, `machine-${machineId}`);
  const capabilities = fields.protocolCapabilities;
  const version =
    capabilities && typeof capabilities === 'object'
      ? Number((capabilities as Record<string, unknown>).schedules)
      : 0;
  return {
    name: text(fields.name) || undefined,
    owner: text(fields.ownerUserId),
    timeZone: text(fields.timeZone) || undefined,
    supported: version >= SCHEDULES_PROMPT_PROTOCOL_VERSION,
  };
}

export function registerSchedules(ctx: RuntimeContext) {
  const { channel, state, getGrant } = ctx;

  const scope = (workspaceId: string) => {
    if (
      workspaceId !== state.workspace ||
      !state.userId ||
      !state.metaReplica ||
      state.unhealthy.has('meta')
    )
      throw new Error('metadata_not_ready');
    const workspace = state.workspace;
    return {
      workspace,
      meta: state.metaReplica.flock,
      check: () => {
        if (state.workspace !== workspace) throw new Error('workspace_changed');
      },
    };
  };

  const machine = scheduleMachine;

  const agents = (meta: Flock) =>
    creationOptions(
      undefined,
      meta,
      new Map(
        [...state.machineReplicas].filter(([id]) => !state.unhealthy.has(id)),
      ),
    ).agents;

  const projectName = (
    row: Pick<ScheduleRegistryRow, 'machineId'>,
    kind?: string,
    key?: string,
  ) => {
    if (!key) return undefined;
    if (kind === 'github') return key;
    const value = state.machineReplicas
      .get(row.machineId)
      ?.get(['localProject', key]) as Record<string, unknown> | undefined;
    return text(value?.name) || undefined;
  };

  const item = (
    meta: Flock,
    row: ScheduleRegistryRow,
    runtime: ScheduleRuntimeRow | undefined,
    agentList: ReturnType<typeof agents>,
  ): Item => {
    const host = machine(meta, row.machineId);
    const agent = agentList.find(
      (entry) =>
        entry.id === row.agentConfigId && entry.machineId === row.machineId,
    );
    const current =
      runtime && runtime.activationId === row.activationId
        ? runtime
        : undefined;
    const last = runtime?.lastDispatch;
    return {
      scheduleId: row.scheduleId,
      title: row.title,
      ownerId: row.ownerId,
      isOwner: row.ownerId === state.userId,
      machineId: row.machineId,
      ...(host.name ? { machineName: host.name } : {}),
      machineSupported: host.supported,
      agentConfigId: row.agentConfigId,
      ...(agent ? { agentName: agent.name, agentType: agent.agentType } : {}),
      enabled: row.enabled,
      scheduledMessage: row.scheduledMessage === true,
      rule: ruleOf(row.trigger),
      destination: row.destination.kind,
      ...(row.destination.kind === 'existing_session'
        ? { destinationSessionId: row.destination.sessionId }
        : {}),
      ...(row.projectKind ? { projectKind: row.projectKind } : {}),
      ...(row.projectKey ? { projectKey: row.projectKey } : {}),
      ...(() => {
        const name = projectName(row, row.projectKind, row.projectKey);
        return name ? { projectName: name } : {};
      })(),
      state: describeScheduleState(row, current ?? runtime),
      ...(last
        ? { lastRunAt: last.dispatchedAt, lastSessionId: last.sessionId }
        : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };

  const runtimeFor = (
    runtimes: ScheduleRuntimeRow[],
    row: ScheduleRegistryRow,
  ) =>
    runtimes.find(
      (entry) =>
        entry.scheduleId === row.scheduleId &&
        entry.machineId === row.machineId,
    );

  channel.handle('schedules', async (args) => {
    const { workspace, meta, check } = scope(args.workspaceId);
    const streams = scheduleStreams(
      workspace,
      getGrant,
      AbortSignal.timeout(40000),
    );
    const { rows, runtimes } = await streams.list();
    check();
    const agentList = agents(meta);
    const machineTimeZones: Record<string, string> = {};
    const ownedMachineIds: string[] = [];
    for (const id of new Set([
      ...state.machineReplicas.keys(),
      ...rows.map((row) => row.machineId),
    ])) {
      const host = machine(meta, id);
      if (host.timeZone) machineTimeZones[id] = host.timeZone;
      if (host.owner && host.owner === state.userId) ownedMachineIds.push(id);
    }
    return {
      items: rows
        .map((row) => item(meta, row, runtimeFor(runtimes, row), agentList))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      deviceTimeZone: deviceTimeZone(),
      machineTimeZones,
      ownedMachineIds: ownedMachineIds.sort(),
    };
  });

  channel.handle('scheduleDetail', async (args) => {
    const { workspace, meta, check } = scope(args.workspaceId);
    const streams = scheduleStreams(
      workspace,
      getGrant,
      AbortSignal.timeout(40000),
    );
    const { rows, runtimes } = await streams.list();
    const row = rows.find((entry) => entry.scheduleId === args.scheduleId);
    if (!row) throw new Error('schedule_not_found');
    const read = await streams.read(row.scheduleId);
    check();
    const base = item(meta, row, runtimeFor(runtimes, row), agents(meta));
    if (read.message) return { item: base, prompt: read.text };
    if (!read.document) throw new Error('schedule_not_found');
    const { definition, prompt } = read.document;
    const project = definition.project;
    let wire: Project | undefined;
    if (project?.kind === 'github')
      wire = {
        kind: 'github',
        repoFullName: project.repoFullName,
        branch: project.branch,
        name: project.repoFullName,
      };
    else if (project) {
      const name = projectName(definition, 'local', project.localProjectId);
      wire = {
        kind: 'local',
        localProjectId: project.localProjectId,
        ...(project.branch ? { branch: project.branch } : {}),
        ...(project.useWorktree !== undefined
          ? { useWorktree: project.useWorktree }
          : {}),
        ...(name ? { name } : {}),
      };
    }
    return {
      item: base,
      prompt,
      ...(definition.agent.modelId
        ? { modelId: definition.agent.modelId }
        : {}),
      ...(definition.agent.modeId ? { modeId: definition.agent.modeId } : {}),
      ...(wire ? { project: wire } : {}),
    };
  });

  channel.handle('scheduleCommand', async (args) => {
    const { workspace, meta, check } = scope(args.workspaceId);
    const actorId = state.userId;
    const signal = AbortSignal.timeout(65000);
    const streams = scheduleStreams(workspace, getGrant, signal);
    const repository = scheduleRepository(streams);
    const now = Date.now();
    const scheduleId = args.scheduleId;
    const requireMachine = (machineId: string) => {
      const host = machine(meta, machineId);
      if (host.owner !== actorId) throw new Error('schedule_not_owner');
      if (!host.supported) throw new Error('schedule_machine_unsupported');
      return host;
    };
    const capableRow = async () => {
      const { rows } = await streams.list();
      const row = rows.find((entry) => entry.scheduleId === scheduleId);
      if (!row) throw new Error('schedule_not_found');
      if (row.ownerId !== actorId) throw new Error('schedule_not_owner');
      if (!machine(meta, row.machineId).supported)
        throw new Error('schedule_machine_unsupported');
      return row;
    };
    switch (args.action) {
      case 'create':
      case 'edit': {
        const draft = args.draft;
        if (!draft) throw new Error('schedule_invalid');
        const host = requireMachine(draft.machineId);
        const agent = agents(meta).find(
          (entry) =>
            entry.id === draft.agentConfigId &&
            entry.machineId === draft.machineId,
        );
        if (!agent) throw new Error('schedule_invalid');
        let previous: ScheduleDocument | undefined;
        if (args.action === 'edit')
          previous = await repository.owned(scheduleId, actorId);
        check();
        const input = draftInput(
          draft,
          previous,
          host.timeZone ?? deviceTimeZone(),
          now,
        );
        await repository.save({
          scheduleId,
          draft: input,
          actorId,
          now,
          activationId: crypto.randomUUID(),
          activityId: args.requestId,
          create: args.action === 'create',
        });
        break;
      }
      case 'pause':
        await repository.setEnabled({
          scheduleId,
          enabled: false,
          actorId,
          now,
          activationId: crypto.randomUUID(),
          requestId: args.requestId,
        });
        break;
      case 'resume':
        await capableRow();
        check();
        await repository.setEnabled({
          scheduleId,
          enabled: true,
          actorId,
          now,
          activationId: crypto.randomUUID(),
          requestId: args.requestId,
        });
        break;
      case 'run':
        await capableRow();
        check();
        await repository.requestRun({
          scheduleId,
          actorId,
          manualRunId: args.requestId,
          now,
        });
        break;
      case 'delete':
        await repository.remove(scheduleId, actorId, now);
        break;
    }
    return { scheduleId };
  });
}

/**
 * The repository draft for an editor submission. An edit keeps what mobile
 * does not edit: Agent options and memory (same Agent), policies, a picked
 * chat destination, and the owned chat's epoch.
 */
export function draftInput(
  draft: Draft,
  previous: ScheduleDocument | undefined,
  zone: string,
  now: number,
): ScheduleDraftInput {
  const prior = previous?.definition;
  if (draft.prompt.length === 0) throw new Error('schedule_prompt_invalid');
  const sameAgent = prior?.agent.agentConfigId === draft.agentConfigId;
  const agent = {
    ...(sameAgent && prior?.agent.memory ? { memory: prior.agent.memory } : {}),
    agentConfigId: draft.agentConfigId,
    ...(draft.modeId ? { modeId: draft.modeId } : {}),
    ...(draft.modelId ? { modelId: draft.modelId } : {}),
    ...(sameAgent && prior?.agent.configOptionValues
      ? { configOptionValues: prior.agent.configOptionValues }
      : {}),
  };
  let destination: ScheduleDestination;
  if (prior?.destination.kind === 'existing_session')
    destination = prior.destination;
  else if (draft.destination === 'own_session')
    destination =
      prior?.destination.kind === 'own_session'
        ? prior.destination
        : { kind: 'own_session', epoch: 0 };
  else destination = { kind: 'new_session' };
  const project =
    destination.kind === 'new_session' ? projectRef(draft.project) : undefined;
  return {
    title: draft.title,
    prompt: draft.prompt,
    machineId: draft.machineId,
    agent,
    ...(project ? { project } : {}),
    destination,
    trigger: triggerOf(draft.rule, zone, now, prior?.trigger),
  };
}
