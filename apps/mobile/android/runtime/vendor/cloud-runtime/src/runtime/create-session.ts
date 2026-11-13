import { type Value, Flock } from '@loro-dev/flock-wasm/base64';
import type { StreamsClient } from '@loro-dev/streams-client';
import type { Session } from '../models/catalog.ts';
import type {
  Capability,
  CapabilityChoice,
  ConfigOption,
  CreationOptions,
} from '../models/send.ts';
import { githubProject, projectRows } from '../protocol/catalog.ts';
import {
  buildProjectGroupProjectRef,
  buildSessionProjectRun,
  getProjectBoundMachineId,
  type WorkspaceProject,
} from '../protocol/project-groups.ts';
import { isThoughtLevel, validConfigValue } from '../protocol/capability';
import { encodeFrame } from '../frames';
import type { CreateSessionResult } from '../contract/methods.ts';
import { clientFor } from './session';
import { resolveNewSessionHistoryBackend } from './upstream-roost.js';
import {
  quotaReason,
  workspaceSessionCount,
  type BillingEntitlement,
} from './billing';

export type CreateSessionArgs = {
  workspaceId: string;
  projectId?: string;
  sessionId: string;
  machineId: string;
  agentConfigId: string;
  userId: string;
  preferRoost?: boolean;
  title: string;
  branch?: string;
  /** Local projects: start in a new git worktree (web `project.useWorktree`). */
  useWorktree?: boolean;
  /** Provenance only (web): the Role this session starts as, at the revision it ran. */
  agentRoleId?: string;
  agentRoleRevision?: number;
  billingEntitlement?: BillingEntitlement | null;
  tabContext?: {
    parentSessionId: string;
    projectId: string;
    project?: Value;
    repoFullName?: Value;
    baseBranch?: Value;
  };
};

/** Match the daemon's repo-metadata + machine-Flock merge. Machine rows win. */
function metadataAgents(meta: Flock) {
  const records = new Map<string, Record<string, unknown>>();
  for (const row of meta.scan({ prefix: ['m'] })) {
    const room = row.key[1];
    if (typeof room !== 'string' || !room.startsWith('agent-')) continue;
    if (meta.get(['e', room]) !== true) continue;
    const fields = records.get(room) ?? Object.create(null);
    if (row.key.length === 2 && row.value && typeof row.value === 'object')
      Object.assign(fields, row.value);
    else if (row.key.length === 3 && typeof row.key[2] === 'string') {
      if (row.value === undefined) delete fields[row.key[2]];
      else fields[row.key[2]] = row.value;
    }
    records.set(room, fields);
  }
  return [...records].map(([room, value]) => ({
    key: ['agentConfig', room.slice('agent-'.length)],
    value,
  }));
}

const choices = (
  value: unknown,
  idKey: 'id' | 'modelId' | 'value',
): CapabilityChoice[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const entry = item as Record<string, unknown>;
        const id = entry?.[idKey];
        const name = entry?.name;
        return typeof id === 'string' && id && typeof name === 'string'
          ? [
              {
                id,
                name,
                ...(typeof entry.description === 'string'
                  ? { description: entry.description }
                  : {}),
              },
            ]
          : [];
      })
    : [];

/** Selector metadata safe for the UI: select/boolean only, no secret-looking ids. */
function projectConfigOptions(raw: unknown): ConfigOption[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const option = item as Record<string, unknown>;
    if (
      typeof option.id !== 'string' ||
      !option.id ||
      /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i.test(
        option.id,
      ) ||
      typeof option.name !== 'string' ||
      !['select', 'boolean'].includes(String(option.type))
    )
      return [];
    const projected: ConfigOption = {
      id: option.id,
      name: option.name,
      type: option.type as ConfigOption['type'],
      options: choices(option.options, 'value'),
      ...(typeof option.category === 'string'
        ? { category: option.category }
        : {}),
      ...(typeof option.description === 'string'
        ? { description: option.description }
        : {}),
    };
    if (projected.type === 'select' && !projected.options.length) return [];
    if (validConfigValue(projected, option.currentValue))
      projected.currentValue = option.currentValue as string | boolean;
    return [projected];
  });
}

const isFastToggle = (option: ConfigOption) =>
  ['fast-mode', 'fast'].includes(option.id) && option.type === 'boolean';

/**
 * Each model's own option list, as a requested refresh recorded it on desktop
 * (`['acpModelConfigOptions', configId, modelId]` pointing at a shared
 * `['acpModelConfigOptionsShape', configId, shapeId]` list). A pointer whose
 * shape has not synced yet is unknown, never an empty list.
 */
function recordedModelOptions(
  flock: { scan(): Iterable<{ key: Value[]; value?: Value }> },
  configId: string,
): Record<string, ConfigOption[]> {
  const shapes = new Map<string, unknown>();
  const pointers: [string, string][] = [];
  for (const row of flock.scan()) {
    const value = row.value as Record<string, unknown> | undefined;
    if (!value || row.key.length !== 3 || row.key[1] !== configId) continue;
    if (
      row.key[0] === 'acpModelConfigOptionsShape' &&
      value.version === 1 &&
      Array.isArray(value.configOptions)
    )
      shapes.set(String(row.key[2]), value.configOptions);
    else if (
      row.key[0] === 'acpModelConfigOptions' &&
      value.version === 1 &&
      typeof value.shape === 'string'
    )
      pointers.push([String(row.key[2]), value.shape]);
  }
  const recorded: Record<string, ConfigOption[]> = {};
  for (const [model, shape] of pointers) {
    if (shapes.has(shape))
      recorded[model] = projectConfigOptions(shapes.get(shape));
  }
  return recorded;
}

export function creationOptions(
  projectId: string | undefined,
  meta: Flock,
  machines: Map<string, Flock>,
  refreshed: {
    machineId: string;
    configId: string;
    value: Record<string, unknown>;
  }[] = [],
): CreationOptions {
  const catalog = projectRows(meta.scan(), 'meta');
  const projects = [...catalog.projects];
  for (const [id, flock] of machines)
    projects.push(...projectRows(flock.scan(), id).projects);
  const chat = !projectId;
  let project = projects.findLast((p) => p.id === projectId);
  if (projectId?.startsWith('github:')) {
    // Repository discovery comes from Cloud, not existing session history.
    // Repository access is still checked by the official token broker.
    project = githubProject(projectId.slice(7));
  }
  if (
    !chat &&
    (!project || (!projectId.startsWith('github:') && !project.rootPath))
  )
    throw new Error('project_unavailable');
  if (!chat && project && projectId && !projectId.startsWith('github:')) {
    const localId = projectId.slice(`${project.machineId}:local:`.length);
    if (
      machines
        .get(project.machineId)
        ?.get(['cmd', 'deleteLocalProject', localId]) !== undefined
    )
      throw new Error('project_unavailable');
  }
  const capabilities = new Map<string, Capability & { fetchedAt: number }>();

  const agents = new Map<string, CreationOptions['agents'][number]>();
  const legacyAgents = metadataAgents(meta);
  for (const [machineId, flock] of machines) {
    if (
      !chat &&
      !projectId.startsWith('github:') &&
      machineId !== project!.machineId
    )
      continue;
    for (const row of [
      ...legacyAgents,
      ...flock.scan(),
      ...refreshed
        .filter((row) => row.machineId === machineId)
        .map((row) => ({
          key: ['acpCapability', row.configId],
          value: row.value,
        })),
    ]) {
      const value = row.value as Record<string, unknown> | undefined;
      if (row.key[0] === 'acpCapability' && value) {
        const cliType = String(value.cliType);
        const agentType = String(value.agentType);
        if (!agentType || !cliType) continue;
        // Rows are keyed by agent config (`['acpCapability', configId]`, web's
        // `machineFlockKeys.acpCapability`): two ACP providers of one agent type
        // offer different models, so never merge them by type. Legacy
        // ['acpCapability', cliType, agentType] rows fall back to the type key.
        const configId =
          row.key.length === 2 && typeof row.key[1] === 'string'
            ? row.key[1]
            : '';
        const key = configId
          ? `${machineId}:config:${configId}`
          : `${machineId}:${cliType}:${agentType}`;
        // The same config can publish more than one capability row; the most
        // recently fetched one describes what the machine will actually accept.
        const fetchedAt = Number(value.fetchedAt) || 0;
        if ((capabilities.get(key)?.fetchedAt ?? -1) >= fetchedAt) continue;
        const efforts = value.modelReasoningEfforts;
        const configOptions: ConfigOption[] = projectConfigOptions(
          value.configOptions,
        );
        // Model controls are stored separately from the probe snapshot. Only merge
        // the declaration for this config and the same launch/source version.
        const declaration = configId
          ? (flock.get(['acpModelCapability', configId]) as
              | {
                  version?: number;
                  sourceVersion?: string;
                  models?: Record<
                    string,
                    { effortValues?: string[]; fastMode?: boolean }
                  >;
                }
              | undefined)
          : undefined;
        const modelControls =
          declaration?.version === 1 &&
          typeof value.sourceVersion === 'string' &&
          declaration.sourceVersion === value.sourceVersion &&
          declaration.models &&
          typeof declaration.models === 'object' &&
          !Array.isArray(declaration.models) &&
          Object.values(declaration.models).every(
            (control) =>
              control &&
              typeof control === 'object' &&
              !Array.isArray(control) &&
              (control.effortValues === undefined ||
                (Array.isArray(control.effortValues) &&
                  control.effortValues.every((v) => typeof v === 'string'))) &&
              (control.fastMode === undefined ||
                typeof control.fastMode === 'boolean'),
          )
            ? declaration.models
            : undefined;
        const declaredEfforts: Record<string, string[]> = {};
        const fastModes: Record<string, boolean> = {};
        for (const [model, control] of Object.entries(modelControls ?? {})) {
          if (control.effortValues) {
            declaredEfforts[model] =
              cliType === 'builtin' && agentType === 'claude'
                ? [...new Set(['default', ...control.effortValues])]
                : control.effortValues;
          } else if (cliType === 'builtin' && agentType === 'claude')
            declaredEfforts[model] = [];
          if (control.fastMode !== undefined)
            fastModes[model] = control.fastMode;
        }
        // Each model's own options from a refresh that read every model. A
        // declaration still decides effort and Fast, then `modelReasoningEfforts`;
        // a model without a record keeps the snapshot, as before.
        const recorded = configId ? recordedModelOptions(flock, configId) : {};
        const recordedEfforts: Record<string, string[]> = {};
        for (const [model, options] of Object.entries(recorded)) {
          const effort = options.find(isThoughtLevel);
          recordedEfforts[model] = effort?.options.map((o) => o.id) ?? [];
          if (effort && !configOptions.some(isThoughtLevel)) {
            // The snapshot's model had no effort control; another model has one.
            const { currentValue: _current, ...control } = effort;
            configOptions.push(control);
          }
          const fast = options.find(isFastToggle);
          if (fastModes[model] === undefined)
            fastModes[model] = fast !== undefined;
          if (fast && !configOptions.some(isFastToggle))
            configOptions.push({ ...fast, currentValue: false });
        }
        const binding =
          cliType === 'builtin'
            ? (
                {
                  codex: ['reasoning_effort', 'fast-mode'],
                  claude: ['effort', 'fast'],
                } as Record<string, string[]>
              )[agentType]
            : undefined;
        if (
          binding &&
          !configOptions.some(isThoughtLevel) &&
          Object.values(declaredEfforts).some((v) => v.length)
        ) {
          configOptions.push({
            id: binding[0],
            name: 'Reasoning effort',
            type: 'select',
            category: 'thought_level',
            options: [...new Set(Object.values(declaredEfforts).flat())].map(
              (id) => ({ id, name: id }),
            ),
          });
        }
        if (
          binding &&
          Object.values(fastModes).includes(true) &&
          !configOptions.some((o) => o.id === binding[1])
        ) {
          configOptions.push({
            id: binding[1],
            name: 'Fast',
            type: 'boolean',
            currentValue: false,
            options: [],
          });
        }
        const effortOption = configOptions.find(isThoughtLevel);
        const modelOption = configOptions.find(
          (option) => option.category === 'model' && option.type === 'select',
        );
        const modeOption = configOptions.find(
          (option) => option.category === 'mode' && option.type === 'select',
        );
        capabilities.set(key, {
          machineId,
          ...(configId ? { agentConfigId: configId } : {}),
          cliType,
          agentType,
          models: modelOption?.options ?? choices(value.models, 'modelId'),
          modes: modeOption?.options ?? choices(value.modes, 'id'),
          legacyModes: choices(value.modes, 'id'),
          configOptions,
          ...(Object.keys(fastModes).length ? { fastModes } : {}),
          reasoningEfforts: {
            ...recordedEfforts,
            ...Object.fromEntries(
              Object.entries(
                (efforts && typeof efforts === 'object'
                  ? efforts
                  : {}) as Record<string, unknown>,
              ).flatMap(([modelId, levels]) =>
                Array.isArray(levels)
                  ? [[modelId, levels.filter((l) => typeof l === 'string')]]
                  : [],
              ),
            ),
            ...declaredEfforts,
          },
          ...(typeof effortOption?.id === 'string' && effortOption.id
            ? { reasoningEffortConfigId: effortOption.id }
            : {}),
          steer:
            value.acknowledgedSteer === true && value.provenance === 'runtime',
          fetchedAt,
        });
        continue;
      }
      if (
        row.key[0] !== 'agentConfig' ||
        !value ||
        value.machineId !== machineId
      )
        continue;
      if (
        typeof value.id !== 'string' ||
        value.id !== row.key[1] ||
        typeof value.name !== 'string' ||
        typeof value.agentType !== 'string' ||
        !value.agentType ||
        !['builtin', 'registry', 'custom'].includes(String(value.cliType))
      )
        continue;
      // Project only labels and IDs; never send launch environment or secrets to the UI.
      agents.set(`${machineId}:${value.id}`, {
        id: value.id,
        name: value.name,
        machineId,
        machineName: (() => {
          const value =
            meta.get(['m', `machine-${machineId}`, 'name']) ??
            (
              meta.get(['m', `machine-${machineId}`]) as
                Record<string, unknown> | undefined
            )?.name;
          return typeof value === 'string' && value ? value : '未命名电脑';
        })(),
        cliType: String(value.cliType),
        agentType: value.agentType,
      });
    }
  }
  return {
    sessionId: crypto.randomUUID(),
    ...(project ? { project } : {}),
    agents: [...agents.values()],
    capabilities: [...capabilities.values()].map(
      ({ fetchedAt: _fetchedAt, ...capability }) => capability,
    ),
  };
}

const attempted = new Set<string>();

export async function createSession(
  args: CreateSessionArgs,
  options: CreationOptions,
  replica: { flock: Flock; client: StreamsClient },
  getGrant: () => Promise<{ token: string; gatewayBaseUrl: string }>,
  /** A multi-repository project (web Project group), read fresh by the caller. */
  group?: WorkspaceProject,
): Promise<CreateSessionResult> {
  const agent = options.agents.find(
    (a) => a.id === args.agentConfigId && a.machineId === args.machineId,
  );
  const chat = !args.projectId && !options.project;
  const github = options.project?.id.startsWith('github:') === true;
  if (
    !agent ||
    (!chat && args.projectId !== options.project?.id) ||
    typeof args.sessionId !== 'string' ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.sessionId) ||
    typeof args.userId !== 'string' ||
    !args.userId.trim() ||
    typeof args.title !== 'string' ||
    !args.title.trim() ||
    args.title.length > 200 ||
    (github &&
      (typeof args.branch !== 'string' ||
        !args.branch.trim() ||
        args.branch.length > 255)) ||
    (args.agentRoleId !== undefined &&
      (typeof args.agentRoleId !== 'string' ||
        !args.agentRoleId ||
        args.agentRoleId.length > 4096 ||
        !Number.isInteger(args.agentRoleRevision) ||
        args.agentRoleRevision! < 1))
  )
    throw new Error('invalid_session');
  const room = `session-${args.sessionId}`;
  if (
    attempted.has(args.sessionId) ||
    replica.flock.get(['e', room]) !== undefined
  )
    throw new Error('session_already_exists');
  const reason = quotaReason(
    'session',
    args.billingEntitlement,
    workspaceSessionCount(replica.flock.scan()),
  );
  if (reason) return { state: 'rejected', reason } as const;
  let project: Record<string, string | boolean> | undefined;
  // A Project group runs on its local members' machine, needs the machine's multi-repo
  // support, and carries the frozen run (web chat landing `startSession`).
  const projectRun = group
    ? groupRun(group, agent.machineId, replica.flock)
    : undefined;
  const groupFirst = group?.members[0];
  const groupRepo = group?.members.find(
    (member) => member.source.kind === 'github',
  )?.source;
  if (group && groupFirst) {
    project = buildProjectGroupProjectRef(groupFirst);
  } else if (!chat && github) {
    project = {
      kind: 'github',
      repoFullName: options.project!.id.slice(7),
      branch: args.branch!.trim(),
    };
  } else if (!chat) {
    project = {
      kind: 'local',
      localProjectId: options.project!.id.slice(
        `${agent.machineId}:local:`.length,
      ),
      ...(args.useWorktree === true ? { useWorktree: true } : {}),
    };
  }
  const tab = args.tabContext;
  const meta = {
    id: args.sessionId,
    machineId: agent.machineId,
    userId: args.userId,
    title: args.title.trim(),
    titleSource: 'draft',
    status: { type: 'idle' },
    historyBackend: resolveNewSessionHistoryBackend(
      machineMeta(replica.flock, agent.machineId) as {
        protocolCapabilities?: Record<string, number>;
      },
      { preferred: args.preferRoost ? 'roost' : 'loro' },
    ),
    isArchived: false,
    createdAt: new Date().toISOString(),
    cliType: agent.cliType,
    agentType: agent.agentType,
    agentConfigId: agent.id,
    ...(args.agentRoleId
      ? {
          agentRoleId: args.agentRoleId,
          agentRoleRevision: args.agentRoleRevision,
        }
      : {}),
    ...(project ? { project } : {}),
    ...(projectRun ? { projectRun } : {}),
    ...(group
      ? {
          ...(groupRepo?.kind === 'github'
            ? { repoFullName: groupRepo.repoFullName }
            : {}),
          isWorktree: true,
        }
      : {}),
    ...(tab
      ? {
          parentSessionId: tab.parentSessionId,
          ...(tab.project ? { project: tab.project } : {}),
          ...(tab.repoFullName ? { repoFullName: tab.repoFullName } : {}),
          ...(tab.baseBranch ? { baseBranch: tab.baseBranch } : {}),
        }
      : {}),
    ...(github
      ? {
          repoFullName: options.project!.id.slice(7),
          baseBranch: args.branch!.trim(),
          isWorktree: true,
        }
      : {}),
  };
  const session: Session = {
    id: meta.id,
    machineId: meta.machineId,
    title: meta.title,
    status: 'idle',
    archived: false,
    pinned: false,
    projectId:
      tab?.projectId ??
      (group ? groupProjectId(group, agent.machineId) : undefined) ??
      args.projectId ??
      `${agent.machineId}:unassigned`,
    ...(tab ? { parentSessionId: tab.parentSessionId } : {}),
    createdAt: meta.createdAt,
    cliType: meta.cliType,
    agentType: meta.agentType,
  };
  // Create the empty stream before publishing the list entry, so it can be opened immediately.
  const stream = await clientFor(
    `${args.workspaceId}:s:${args.sessionId}`,
    getGrant,
  );
  const created = await stream.create({
    contentType: 'application/octet-stream',
  });
  if (!created.ok) throw new Error(created.result.code);
  const write = new Flock(`lody-ios-create-${crypto.randomUUID()}`);
  write.set(['e', room], true);
  write.set(['m', room], meta);
  write.commit();
  const update = write.exportJson();
  attempted.add(args.sessionId);
  try {
    const result = await replica.client.append({
      part: {
        contentType: 'application/octet-stream',
        body: encodeFrame(new TextEncoder().encode(JSON.stringify(update))),
      },
    });
    if (!result.ok) throw new Error(result.result.code);
    replica.flock.importJson(update);
    return { state: 'created', session };
  } catch {
    // A lost ACK can still mean durable metadata. Keep the ID; never replay creation.
    return { state: 'unknown', session };
  }
}

/** Where a group's session lists: the group itself, or its one member's project. */
function groupProjectId(group: WorkspaceProject, machineId: string): string {
  if (group.members.length > 1) return `group:${group.id}`;
  const source = group.members[0]!.source;
  return source.kind === 'github'
    ? `github:${source.repoFullName}`
    : `${machineId}:local:${source.localProjectId}`;
}

/** A machine's merged metadata row (`['m', 'machine-<id>']` plus field rows). */
export function machineMeta(
  flock: Flock,
  machineId: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const id = `machine-${machineId}`;
  for (const row of flock.scan()) {
    if (row.key[0] !== 'm' || row.key[1] !== id) continue;
    if (row.key.length === 2 && row.value && typeof row.value === 'object')
      Object.assign(fields, row.value);
    else if (row.key.length === 3 && typeof row.key[2] === 'string')
      fields[row.key[2]] = row.value;
  }
  return fields;
}

function supports(meta: Record<string, unknown>, capability: string): boolean {
  const capabilities = meta.protocolCapabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  return Number((capabilities as Record<string, unknown>)[capability]) >= 1;
}

/**
 * The group's frozen run on this machine (undefined for a one-member group, which
 * is the single-repository flow). Throws when the group cannot run there.
 */
function groupRun(group: WorkspaceProject, machineId: string, flock: Flock) {
  const bound = getProjectBoundMachineId(group.members);
  if (bound === 'conflict' || (bound !== null && bound !== machineId))
    throw new Error('project_machine_mismatch');
  const run = buildSessionProjectRun(group);
  if (!run) return undefined;
  const meta = machineMeta(flock, machineId);
  if (!supports(meta, 'multiRepoProject'))
    throw new Error('multi_repo_unsupported');
  const preferLocal = group.members.some(
    (member) => member.source.kind === 'github' && member.source.preferLocal,
  );
  if (preferLocal && !supports(meta, 'projectRepositoryMembers'))
    throw new Error('multi_repo_unsupported');
  return run;
}
