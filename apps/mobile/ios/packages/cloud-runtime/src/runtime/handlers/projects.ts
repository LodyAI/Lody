import type { CreationOptions as CreationOptionsWire } from '../../contract/methods.ts';
import { projectRows } from '../../protocol/catalog.ts';
import { creationOptions } from '../create-session';
import { createCapabilityRefresh } from '../capability-refresh';
import { machineRpc } from '../machine-rpc';
import {
  directoryResult,
  projectControl,
  registerProject,
} from '../local-projects';
import { availableCreationOptions } from '../machine-presence';
import { readWorkspaceProjects } from '../project-groups';
import { projectGroupItems } from '../../protocol/project-groups.ts';
import type { RuntimeContext } from './context.ts';

export function registerProjects(ctx: RuntimeContext) {
  const { channel, state, getGrant } = ctx;
  const refreshMissing = createCapabilityRefresh(
    (owner, agent, signal) =>
      machineRpc(
        owner,
        agent.machineId,
        'machine/acp-capabilities-refresh',
        { configId: agent.id },
        async () => {
          if (state.workspace !== owner) throw new Error('workspace_changed');
          return getGrant();
        },
        signal,
      ),
    () => state.workspace,
    () => ctx.publish(),
  );
  const browsers = new Map<string, AbortController>();
  let registering = false;
  function browserSignal(browserId: string) {
    let controller = browsers.get(browserId);
    if (!controller) {
      controller = new AbortController();
      browsers.set(browserId, controller);
    }
    return controller.signal;
  }
  channel.handle('creationOptions', (args) => {
    if (
      args.workspaceId !== state.workspace ||
      !state.metaReplica ||
      state.unhealthy.has('meta')
    )
      throw new Error('metadata_not_ready');
    const options = creationOptions(
      args.projectId,
      state.metaReplica.flock,
      new Map(
        [...state.machineReplicas].filter(([id]) => !state.unhealthy.has(id)),
      ),
      refreshMissing.rows(state.workspace),
    );
    const available = availableCreationOptions(
      options,
      state.presence,
    ) as CreationOptionsWire;
    if (args.agentConfigId)
      refreshMissing(state.workspace, {
        ...available,
        agents: available.agents.filter(
          (agent) => agent.id === args.agentConfigId,
        ),
      });
    return available;
  });
  // The workspace's multi-repository projects for the new-chat picker (a fresh read).
  channel.handle('projectGroups', async (args) => {
    const workspace = state.workspace;
    if (args.workspaceId !== workspace) throw new Error('metadata_not_ready');
    const projects = await readWorkspaceProjects(
      workspace,
      getGrant,
      AbortSignal.timeout(30000),
    );
    if (state.workspace !== workspace) throw new Error('workspace_changed');
    const names = (machineId: string, localProjectId: string) => {
      const row = state.machineReplicas
        .get(machineId)
        ?.get(['localProject', localProjectId]) as
        Record<string, unknown> | undefined;
      return typeof row?.name === 'string' && row.name ? row.name : undefined;
    };
    return { groups: projectGroupItems(projects, names) };
  });
  channel.handle('localProjects', async (args) => {
    const { workspace, machineReplicas } = state;
    if (args.workspaceId !== workspace) throw new Error('metadata_not_ready');
    if (args.action === 'cancel') {
      browsers.get(args.browserId)?.abort();
      browsers.delete(args.browserId);
      return { outcome: 'cancelled' };
    }
    if (!state.metaReplica || state.unhealthy.size)
      throw new Error('metadata_not_ready');
    if (args.action === 'machines') {
      const meta = state.metaReplica.flock;
      return {
        outcome: 'machines',
        machines: (state.catalogs.get('meta')?.machineIds ?? []).map((id) => {
          const value = meta.get(['m', `machine-${id}`]) as
            Record<string, unknown> | undefined;
          const name = meta.get(['m', `machine-${id}`, 'name']) ?? value?.name;
          return {
            id,
            name: typeof name === 'string' && name ? name : '未命名电脑',
          };
        }),
      };
    }
    const machineId = args.machineId;
    if (!machineId || !machineReplicas.has(machineId))
      throw new Error('machine_unavailable');
    if (
      args.path !== undefined &&
      (args.path.length > 32768 || args.path.includes('\0'))
    )
      throw new Error('invalid_path');
    const signal = AbortSignal.any([
      browserSignal(args.browserId),
      AbortSignal.timeout(35000),
    ]);
    const flock = machineReplicas.get(machineId)!;
    if (args.action === 'browse')
      return {
        outcome: 'directory',
        ...directoryResult(
          await projectControl(
            workspace,
            machineId,
            {
              type: 'local-project/browse-dir',
              absolutePath: args.path,
              cursor: args.cursor,
              limit: 100,
            },
            getGrant,
            signal,
          ),
        ),
      };
    if (registering || !args.path) throw new Error('project_not_ready');
    registering = true;
    try {
      const prepared = await projectControl(
        workspace,
        machineId,
        { type: 'local-project/prepare-add', rootPath: args.path },
        getGrant,
        signal,
      );
      signal.throwIfAborted();
      if (machineReplicas.get(machineId) !== flock)
        throw new Error('metadata_not_ready');
      const project = await registerProject(
        state.workspace,
        machineId,
        prepared,
        flock,
        getGrant,
        signal,
      );
      if (machineReplicas.get(machineId) === flock) {
        state.catalogs.set(machineId, projectRows(flock.scan(), machineId));
        ctx.publish();
      }
      return { outcome: 'project', project };
    } finally {
      registering = false;
    }
  });
}
