import {
  planAgentRoleSchemaReconciliation,
  type ReconcileAgentRoleSchemaCommand,
} from './agent-role-schema-reconciliation';
import type { AgentRole } from './agent-role';
import { normalizeAgentRole, serializeAgentRoleRow } from './agent-role';
import type { AgentRoleId, McpServerId, WorkspaceId } from './ids';
import type { WorkspaceMcpServerMeta, ProjectMcpDefault } from './workspace-mcp';
import { normalizeProjectMcpDefault, isWorkspaceMcpServerMeta } from './workspace-mcp';
import type { ProjectId, WorkspaceProject } from './workspace-project';
import { normalizeWorkspaceProject } from './workspace-project';
import { assertPublicMcpServer } from './mcp-authentication';
import {
  applyWorkspaceFlockRowEvents,
  getProjectMcpDefaults,
  listWorkspaceAgentRoles,
  listWorkspaceMcpServers,
  listWorkspaceProjects,
  readWorkspaceFlockRowsFromFlock,
  workspaceFlockKeys,
  parseWorkspaceFlockKey,
  type WorkspaceFlockEvent,
  type WorkspaceFlockKey,
  type WorkspaceFlockReadableFlock,
} from './workspace-flock';

/** Binding is selected by the composition owner, never by a room ID in a request. */
export type WorkspaceCatalogBinding = {
  readonly accountId: string | null;
  readonly workspaceId: WorkspaceId;
};
export type WorkspaceCatalogProjection = {
  readonly servers: WorkspaceMcpServerMeta[];
  readonly roles: AgentRole[];
  readonly projects: WorkspaceProject[];
  readonly projectMcpDefaults: Readonly<Record<string, ProjectMcpDefault>>;
};
export type WorkspaceCatalogUpdate = {
  readonly projection: WorkspaceCatalogProjection;
  readonly synced: boolean;
};
export type WorkspaceCatalogObservation = { close(): void | Promise<void> };
/** Transport-safe failure code; a terminal owner must be reacquired, not reused. */
export class WorkspaceCatalogError extends Error {
  constructor(
    readonly code: 'restart_required' | 'cleanup_unconfirmed',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'WorkspaceCatalogError';
  }
}
export function isWorkspaceCatalogRestartRequired(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'restart_required'
  );
}
/** Trusted CLI exact-ID resolution, separate from renderer summary discovery. */
export interface WorkspaceCatalogRoleLookup {
  readRole(binding: WorkspaceCatalogBinding, id: AgentRoleId): Promise<AgentRole | undefined>;
}
export interface WorkspaceCatalogQuery {
  read(binding: WorkspaceCatalogBinding): Promise<WorkspaceCatalogProjection>;
}
export interface WorkspaceCatalogReader extends WorkspaceCatalogQuery {
  observe(
    binding: WorkspaceCatalogBinding,
    onUpdate: (update: WorkspaceCatalogUpdate) => void,
    onError: (error: unknown) => void
  ): Promise<WorkspaceCatalogObservation>;
}
export type WorkspaceCatalogCommand =
  | ReconcileAgentRoleSchemaCommand
  | { readonly kind: 'put-mcp'; readonly entry: WorkspaceMcpServerMeta }
  | { readonly kind: 'delete-mcp'; readonly id: McpServerId }
  | { readonly kind: 'put-role'; readonly role: AgentRole; readonly expectedRevision?: number }
  | { readonly kind: 'delete-role'; readonly id: AgentRoleId; readonly expectedRevision?: number }
  | {
      readonly kind: 'put-project';
      readonly project: WorkspaceProject;
      readonly expectedRevision?: number;
    }
  | { readonly kind: 'delete-project'; readonly id: ProjectId; readonly expectedRevision?: number }
  | {
      readonly kind: 'set-project-defaults';
      readonly projectKey: string;
      readonly ids: readonly McpServerId[];
    };
export interface WorkspaceCatalogCommands {
  execute(
    binding: WorkspaceCatalogBinding,
    command: WorkspaceCatalogCommand,
    options?: { signal?: AbortSignal }
  ): Promise<{ changed: boolean }>;
  /** Separate from local durability; callers choose background upload or explicit confirmation. */
  upload(binding: WorkspaceCatalogBinding): Promise<void>;
}

export function assertWorkspaceCatalogBinding(
  expected: WorkspaceCatalogBinding,
  actual: WorkspaceCatalogBinding
): void {
  if (expected.accountId !== actual.accountId || expected.workspaceId !== actual.workspaceId)
    throw new Error('Workspace catalog binding mismatch');
}

/** Only normalized, finite public fields leave the backend. Opaque rows stay private. */
export function projectWorkspaceCatalog(
  flock: WorkspaceFlockReadableFlock
): WorkspaceCatalogProjection {
  const rows = readWorkspaceFlockRowsFromFlock(flock);
  return {
    servers: listWorkspaceMcpServers(rows),
    roles: listWorkspaceAgentRoles(rows),
    projects: listWorkspaceProjects(rows),
    projectMcpDefaults: getProjectMcpDefaults(rows),
  };
}

export function workspaceCatalogMutation(
  command: Exclude<WorkspaceCatalogCommand, ReconcileAgentRoleSchemaCommand>
): {
  key: WorkspaceFlockKey;
  value?: unknown;
} {
  switch (command.kind) {
    case 'put-mcp':
      if (!isWorkspaceMcpServerMeta(command.entry)) throw new Error('Invalid MCP catalog command');
      assertPublicMcpServer(command.entry);
      return { key: workspaceFlockKeys.mcpServer(command.entry.id), value: command.entry };
    case 'delete-mcp':
      return { key: workspaceFlockKeys.mcpServer(command.id) };
    case 'put-role': {
      const role = normalizeAgentRole(command.role);
      if (!role) throw new Error('Invalid Agent Role catalog command');
      return { key: workspaceFlockKeys.agentRole(role.id), value: serializeAgentRoleRow(role) };
    }
    case 'delete-role':
      return { key: workspaceFlockKeys.agentRole(command.id) };
    case 'put-project': {
      const project = normalizeWorkspaceProject(command.project);
      if (!project) throw new Error('Invalid Project catalog command');
      return { key: workspaceFlockKeys.project(project.id), value: project };
    }
    case 'delete-project':
      return { key: workspaceFlockKeys.project(command.id) };
    case 'set-project-defaults': {
      if (!parseWorkspaceFlockKey(['projectMcpDefault', command.projectKey]))
        throw new Error('Invalid Project MCP defaults target');
      const value = normalizeProjectMcpDefault({ ids: command.ids });
      if (!value) throw new Error('Invalid Project MCP defaults command');
      return { key: workspaceFlockKeys.projectMcpDefault(command.projectKey), value };
    }
  }
}

/** Cold catalog queries borrow the existing room without joining it. */
export function createLegacyWorkspaceCatalogQuery(options: {
  binding: WorkspaceCatalogBinding;
  authorizeRoleLookup?: (id: AgentRoleId) => boolean;
  open(): Promise<{ flock: WorkspaceFlockReadableFlock }>;
}): WorkspaceCatalogQuery & WorkspaceCatalogRoleLookup {
  const expected = Object.freeze({ ...options.binding });
  return {
    async readRole(binding, id) {
      assertWorkspaceCatalogBinding(expected, binding);
      if (options.authorizeRoleLookup?.(id) !== true)
        throw new Error('Explicit Role lookup access denied');
      const projection = await this.read(binding);
      if (options.authorizeRoleLookup?.(id) !== true)
        throw new Error('Explicit Role lookup access denied');
      return projection.roles.find((role) => role.id === id);
    },
    async read(binding) {
      assertWorkspaceCatalogBinding(expected, binding);
      const handle = await options.open();
      assertWorkspaceCatalogBinding(expected, binding);
      return projectWorkspaceCatalog(handle.flock);
    },
  };
}

type LegacyCatalogHandle = {
  flock: WorkspaceFlockReadableFlock & {
    subscribe(listener: (batch: { events?: WorkspaceFlockEvent[] }) => void): () => void;
  };
  joinRoom(): Promise<{ unsubscribe(): void; firstSyncedWithRemote: Promise<void> }>;
};
/** Borrow the existing whole-room owner; no extra persistence, writer or replica. */
export function createLegacyWorkspaceCatalogReader(options: {
  binding: WorkspaceCatalogBinding;
  open(): Promise<LegacyCatalogHandle>;
  isCurrent?: () => boolean;
}): WorkspaceCatalogReader {
  const expected = Object.freeze({ ...options.binding });
  const check = (binding: WorkspaceCatalogBinding) => {
    assertWorkspaceCatalogBinding(expected, binding);
    if (options.isCurrent?.() === false) throw new Error('Workspace catalog scope is closed');
  };
  return {
    async read(binding) {
      check(binding);
      const handle = await options.open();
      check(binding);
      return projectWorkspaceCatalog(handle.flock);
    },
    async observe(binding, onUpdate, onError) {
      check(binding);
      const handle = await options.open();
      check(binding);
      let closed = false;
      let synced = false;
      let rows = readWorkspaceFlockRowsFromFlock({ scan: () => [] });
      const publish = () => {
        if (closed) return;
        check(binding);
        onUpdate({
          projection: {
            servers: listWorkspaceMcpServers(rows),
            roles: listWorkspaceAgentRoles(rows),
            projects: listWorkspaceProjects(rows),
            projectMcpDefaults: getProjectMcpDefaults(rows),
          },
          synced,
        });
      };
      // Subscribe before the cold scan. Both operations are synchronous in this
      // borrowed legacy adapter; native observers replace their full projection.
      const unsubscribe = handle.flock.subscribe((batch) => {
        if (closed) return;
        rows = applyWorkspaceFlockRowEvents(rows, batch.events ?? []);
        try {
          publish();
        } catch (error) {
          onError(error);
        }
      });
      let room: Awaited<ReturnType<LegacyCatalogHandle['joinRoom']>> | undefined;
      try {
        rows = readWorkspaceFlockRowsFromFlock(handle.flock);
        publish();
      } catch (error) {
        unsubscribe();
        throw error;
      }
      void handle
        .joinRoom()
        .then(async (joined) => {
          room = joined;
          if (closed) {
            joined.unsubscribe();
            return;
          }
          await joined.firstSyncedWithRemote;
          if (closed) return;
          synced = true;
          rows = readWorkspaceFlockRowsFromFlock(handle.flock);
          publish();
        })
        .catch((error) => {
          if (!closed) onError(error);
        });
      return {
        close() {
          if (closed) return;
          closed = true;
          unsubscribe();
          room?.unsubscribe();
        },
      };
    },
  };
}

/** Phase-one in-process command adapter. Existing authorization remains at its callers. */
export function createLegacyWorkspaceCatalogCommands(options: {
  binding: WorkspaceCatalogBinding;
  isCurrent?: () => boolean;
  put(key: WorkspaceFlockKey, value: unknown): Promise<void | boolean>;
  remove(key: WorkspaceFlockKey): Promise<void | boolean>;
  update?(key: WorkspaceFlockKey, plan: (stored: unknown) => unknown | undefined): Promise<boolean>;
  upload(): Promise<void>;
}): WorkspaceCatalogCommands {
  const expected = Object.freeze({ ...options.binding });
  const check = (binding: WorkspaceCatalogBinding) => {
    assertWorkspaceCatalogBinding(expected, binding);
    if (options.isCurrent?.() === false) throw new Error('Workspace catalog scope is closed');
  };
  return {
    async execute(binding, command, execution) {
      check(binding);
      if (execution?.signal?.aborted) return { changed: false };
      if (command.kind === 'reconcile-role-schema') {
        if (!options.update) throw new Error('Conditional Role maintenance is unavailable');
        const changed = await options.update(
          workspaceFlockKeys.agentRole(command.expected.id),
          (stored) => {
            check(binding);
            return execution?.signal?.aborted
              ? undefined
              : planAgentRoleSchemaReconciliation(stored, command, expected.accountId);
          }
        );
        return { changed };
      }
      const mutation = workspaceCatalogMutation(command);
      const changed =
        mutation.value === undefined
          ? await options.remove(mutation.key)
          : await options.put(mutation.key, mutation.value);
      return { changed: changed !== false };
    },
    async upload(binding) {
      check(binding);
      await options.upload();
    },
  };
}
