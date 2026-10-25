import {
  normalizeWorkspaceProject,
  type WorkspaceProject,
  type ProjectId,
} from './workspace-project';
import { normalizeAgentRole, serializeAgentRoleRow, type AgentRole } from './agent-role';
import type { AgentRoleId, McpServerId, WorkspaceId } from './ids';
import {
  isWorkspaceMcpServerMeta,
  isProjectMcpKey,
  normalizeProjectMcpDefault,
  type ProjectMcpDefault,
  type WorkspaceMcpServerMeta,
} from './workspace-mcp';

export const WORKSPACE_FLOCK_DOC_STREAM_SEGMENT = 'wf';
const WORKSPACE_FLOCK_DOC_NAME = 'workspace';

export const getWorkspaceFlockDocId = (workspaceId: WorkspaceId): string =>
  `${workspaceId}:${WORKSPACE_FLOCK_DOC_STREAM_SEGMENT}:${WORKSPACE_FLOCK_DOC_NAME}`;

export type WorkspaceFlockMcpServerKey = ['mcpServer', McpServerId];
export type WorkspaceFlockAgentRoleKey = ['agentRole', AgentRoleId];
export type WorkspaceFlockProjectKey = ['project', ProjectId];
export type WorkspaceFlockProjectMcpDefaultKey = ['projectMcpDefault', string];
export type WorkspaceFlockKey =
  | WorkspaceFlockProjectKey
  | WorkspaceFlockMcpServerKey
  | WorkspaceFlockAgentRoleKey
  | WorkspaceFlockProjectMcpDefaultKey;

/**
 * Every family stored in the one workspace document.
 *
 * Agent Roles share this document with the MCP catalog rather than getting a
 * document of their own, and private/workspace Roles share one family rather
 * than two: sharing a Role is then an ordinary update of its own row, with no
 * data moved between documents and no window where a Role exists in both or
 * neither.
 */
export const WORKSPACE_FLOCK_ROW_FAMILIES = [
  'mcpServer',
  'agentRole',
  'project',
  'projectMcpDefault',
] as const;

export const workspaceFlockKeys = {
  project: (id: ProjectId): WorkspaceFlockProjectKey => ['project', id],
  projectMcpDefault: (projectKey: string): WorkspaceFlockProjectMcpDefaultKey => [
    'projectMcpDefault',
    projectKey,
  ],
  mcpServer: (id: McpServerId): WorkspaceFlockMcpServerKey => ['mcpServer', id],
  agentRole: (id: AgentRoleId): WorkspaceFlockAgentRoleKey => ['agentRole', id],
} as const;

export type ParsedWorkspaceFlockKey =
  | { kind: 'project'; key: WorkspaceFlockProjectKey; projectId: ProjectId }
  | { kind: 'projectMcpDefault'; key: WorkspaceFlockProjectMcpDefaultKey; projectKey: string }
  | {
      kind: 'mcpServer';
      key: WorkspaceFlockMcpServerKey;
      mcpServerId: McpServerId;
    }
  | {
      kind: 'agentRole';
      key: WorkspaceFlockAgentRoleKey;
      agentRoleId: AgentRoleId;
    };

export const parseWorkspaceFlockKey = (
  key: readonly unknown[]
): ParsedWorkspaceFlockKey | undefined => {
  if (key.length !== 2 || typeof key[1] !== 'string') {
    return undefined;
  }
  const id = key[1].trim();
  if (!id) {
    return undefined;
  }
  if (key[0] === 'project') {
    const projectId = id as ProjectId;
    return { kind: 'project', key: workspaceFlockKeys.project(projectId), projectId };
  }
  if (key[0] === 'projectMcpDefault' && isProjectMcpKey(id)) {
    return {
      kind: 'projectMcpDefault',
      key: workspaceFlockKeys.projectMcpDefault(id),
      projectKey: id,
    };
  }
  if (key[0] === 'mcpServer') {
    const mcpServerId = id as McpServerId;
    return { kind: 'mcpServer', key: workspaceFlockKeys.mcpServer(mcpServerId), mcpServerId };
  }
  if (key[0] === 'agentRole') {
    const agentRoleId = id as AgentRoleId;
    return { kind: 'agentRole', key: workspaceFlockKeys.agentRole(agentRoleId), agentRoleId };
  }
  return undefined;
};

export type WorkspaceFlockMcpServerRow = {
  key: WorkspaceFlockMcpServerKey;
  value: WorkspaceMcpServerMeta;
};
export type WorkspaceFlockAgentRoleRow = {
  key: WorkspaceFlockAgentRoleKey;
  value: AgentRole;
};
export type WorkspaceFlockProjectRow = { key: WorkspaceFlockProjectKey; value: WorkspaceProject };
export type WorkspaceFlockProjectMcpDefaultRow = {
  key: WorkspaceFlockProjectMcpDefaultKey;
  value: ProjectMcpDefault;
};
export type WorkspaceFlockRow =
  | WorkspaceFlockProjectRow
  | WorkspaceFlockMcpServerRow
  | WorkspaceFlockAgentRoleRow
  | WorkspaceFlockProjectMcpDefaultRow;
export type WorkspaceFlockRowId = string & { __brand: 'WorkspaceFlockRowId' };
export type WorkspaceFlockRowMap = Record<WorkspaceFlockRowId, WorkspaceFlockRow>;

export type WorkspaceFlockScanRow = {
  readonly key: readonly unknown[];
  readonly value?: unknown;
};
export type WorkspaceFlockEvent = WorkspaceFlockScanRow;
export type WorkspaceFlockScanOptions = { readonly prefix?: readonly unknown[] };
export type WorkspaceFlockReadableFlock = {
  scan(options?: WorkspaceFlockScanOptions): Iterable<WorkspaceFlockScanRow>;
};
export type WorkspaceFlockWritableFlock = WorkspaceFlockReadableFlock & {
  set(key: WorkspaceFlockKey, value: unknown, timestamp?: number): void;
  delete(key: WorkspaceFlockKey, timestamp?: number): void;
  commit(): void;
};

export const serializeWorkspaceFlockKey = (key: WorkspaceFlockKey): WorkspaceFlockRowId =>
  JSON.stringify(key) as WorkspaceFlockRowId;

export const parseWorkspaceFlockRow = (
  key: readonly unknown[],
  value: unknown
): WorkspaceFlockRow | undefined => {
  const parsedKey = parseWorkspaceFlockKey(key);
  if (!parsedKey) {
    return undefined;
  }
  if (parsedKey.kind === 'project') {
    const project = normalizeWorkspaceProject(value);
    return project?.id === parsedKey.projectId ? { key: parsedKey.key, value: project } : undefined;
  }
  if (parsedKey.kind === 'projectMcpDefault') {
    const preference = normalizeProjectMcpDefault(value);
    return preference ? { key: parsedKey.key, value: preference } : undefined;
  }
  if (parsedKey.kind === 'mcpServer') {
    if (!isWorkspaceMcpServerMeta(value) || value.id !== parsedKey.mcpServerId) {
      return undefined;
    }
    return { key: parsedKey.key, value };
  }
  // Normalized rather than merely validated: an option key an older client
  // should never have written must not survive into a Session config just
  // because it is already in the document.
  const role = normalizeAgentRole(value);
  if (!role || role.id !== parsedKey.agentRoleId) {
    return undefined;
  }
  return { key: parsedKey.key, value: role };
};

const isMcpServerRow = (row: WorkspaceFlockRow): row is WorkspaceFlockMcpServerRow =>
  row.key[0] === 'mcpServer';

const isAgentRoleRow = (row: WorkspaceFlockRow): row is WorkspaceFlockAgentRoleRow =>
  row.key[0] === 'agentRole';

export const readWorkspaceFlockRowsFromFlock = (
  flock: WorkspaceFlockReadableFlock
): WorkspaceFlockRowMap => {
  const rows: WorkspaceFlockRowMap = {};
  for (const family of WORKSPACE_FLOCK_ROW_FAMILIES) {
    for (const row of flock.scan({ prefix: [family] })) {
      const parsed = parseWorkspaceFlockRow(row.key, row.value);
      if (parsed) {
        rows[serializeWorkspaceFlockKey(parsed.key)] = parsed;
      }
    }
  }
  return rows;
};

export const getWorkspaceMcpCatalog = (
  rows: WorkspaceFlockRowMap
): Record<McpServerId, WorkspaceMcpServerMeta> => {
  const catalog = {} as Record<McpServerId, WorkspaceMcpServerMeta>;
  for (const row of Object.values(rows)) {
    if (isMcpServerRow(row)) {
      catalog[row.key[1]] = row.value;
    }
  }
  return catalog;
};

export const listWorkspaceMcpServers = (rows: WorkspaceFlockRowMap): WorkspaceMcpServerMeta[] =>
  Object.values(rows)
    .filter(isMcpServerRow)
    .map((row) => row.value)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

export const listWorkspaceAgentRoles = (rows: WorkspaceFlockRowMap): AgentRole[] =>
  Object.values(rows)
    .filter(isAgentRoleRow)
    .map((row) => row.value)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

const workspaceFlockRowsEqual = (
  left: WorkspaceFlockRow | undefined,
  right: WorkspaceFlockRow | undefined
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

export const writeWorkspaceMcpServerToFlock = (
  flock: WorkspaceFlockWritableFlock,
  entry: WorkspaceMcpServerMeta
): boolean => writeWorkspaceFlockRow(flock, workspaceFlockKeys.mcpServer(entry.id), entry);

export const deleteWorkspaceMcpServerFromFlock = (
  flock: WorkspaceFlockWritableFlock,
  id: McpServerId
): boolean => deleteWorkspaceFlockRow(flock, workspaceFlockKeys.mcpServer(id));

export const writeWorkspaceAgentRoleToFlock = (
  flock: WorkspaceFlockWritableFlock,
  role: AgentRole
): boolean => writeWorkspaceFlockRow(flock, workspaceFlockKeys.agentRole(role.id), role);

export const deleteWorkspaceAgentRoleFromFlock = (
  flock: WorkspaceFlockWritableFlock,
  id: AgentRoleId
): boolean => deleteWorkspaceFlockRow(flock, workspaceFlockKeys.agentRole(id));

const writeWorkspaceFlockRow = (
  flock: WorkspaceFlockWritableFlock,
  key: WorkspaceFlockKey,
  value: unknown
): boolean => {
  const row = parseWorkspaceFlockRow(key, value);
  if (!row) {
    return false;
  }
  const rowId = serializeWorkspaceFlockKey(row.key);
  const previous = readSingleRow(flock, row.key)[rowId];
  if (workspaceFlockRowsEqual(previous, row)) {
    return false;
  }
  flock.set(row.key, isAgentRoleRow(row) ? serializeAgentRoleRow(row.value) : row.value);
  flock.commit();
  return true;
};

const deleteWorkspaceFlockRow = (
  flock: WorkspaceFlockWritableFlock,
  key: WorkspaceFlockKey
): boolean => {
  const rowId = serializeWorkspaceFlockKey(key);
  if (!readSingleRow(flock, key)[rowId]) {
    return false;
  }
  flock.delete(key);
  flock.commit();
  return true;
};

export const applyWorkspaceFlockRowEvents = (
  previous: WorkspaceFlockRowMap,
  events: readonly WorkspaceFlockEvent[]
): WorkspaceFlockRowMap => {
  let next: WorkspaceFlockRowMap | null = null;
  const mutableNext = (): WorkspaceFlockRowMap => {
    next ??= { ...previous };
    return next;
  };

  for (const event of events) {
    const parsedKey = parseWorkspaceFlockKey(event.key);
    if (!parsedKey) continue;
    const rowId = serializeWorkspaceFlockKey(parsedKey.key);
    const current = next ?? previous;
    if (event.value === undefined) {
      if (Object.prototype.hasOwnProperty.call(current, rowId)) {
        delete mutableNext()[rowId];
      }
      continue;
    }
    const parsed = parseWorkspaceFlockRow(event.key, event.value);
    if (!parsed) {
      if (Object.prototype.hasOwnProperty.call(current, rowId)) {
        delete mutableNext()[rowId];
      }
      continue;
    }
    if (!workspaceFlockRowsEqual(current[rowId], parsed)) {
      mutableNext()[rowId] = parsed;
    }
  }
  return next ?? previous;
};

const readSingleRow = (
  flock: WorkspaceFlockReadableFlock,
  key: WorkspaceFlockKey
): WorkspaceFlockRowMap => {
  const rows: WorkspaceFlockRowMap = {};
  for (const candidate of flock.scan({ prefix: key })) {
    const row = parseWorkspaceFlockRow(candidate.key, candidate.value);
    if (row) rows[serializeWorkspaceFlockKey(row.key)] = row;
  }
  return rows;
};

export const listWorkspaceProjects = (rows: WorkspaceFlockRowMap): WorkspaceProject[] =>
  Object.values(rows)
    .filter((row): row is WorkspaceFlockProjectRow => row.key[0] === 'project')
    .map((row) => row.value)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
export const writeWorkspaceProjectToFlock = (
  flock: WorkspaceFlockWritableFlock,
  project: WorkspaceProject
): boolean => writeWorkspaceFlockRow(flock, workspaceFlockKeys.project(project.id), project);
export const deleteWorkspaceProjectFromFlock = (
  flock: WorkspaceFlockWritableFlock,
  id: ProjectId
): boolean => deleteWorkspaceFlockRow(flock, workspaceFlockKeys.project(id));

export const getProjectMcpDefaults = (
  rows: WorkspaceFlockRowMap
): Record<string, ProjectMcpDefault> => {
  const defaults: Record<string, ProjectMcpDefault> = {};
  for (const row of Object.values(rows)) {
    if (isProjectMcpDefaultRow(row)) defaults[row.key[1]] = row.value;
  }
  return defaults;
};

const isProjectMcpDefaultRow = (
  row: WorkspaceFlockRow
): row is WorkspaceFlockProjectMcpDefaultRow => row.key[0] === 'projectMcpDefault';
