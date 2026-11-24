import { clientStorage } from './client-storage';
import { clientDiagnostics } from './client-diagnostics';
import { createPluginAppearance } from './appearance';
import { createProductionSurfaces } from './surface-factory';

import { useWorkspaceNavigation } from './workspace-navigation';
import { usePluginCommandBindings } from '../commands/plugin-command-bindings';
import type { WorkspacePluginReads } from './workspace-client';
import { createPluginAssets } from './assets';
import type {
  ProjectRef,
  ClientPluginRegistry,
  ClientHostBindings,
  ReadonlyJsonPrimitive,
} from '@lody/plugin-sdk/client';
import type { ClientCatalogInstallation, WorkspaceClientPlugins } from './client-host-provider';
import { createPluginQueryBindings, type PluginCallPort } from './query-bindings';
import { clientPluginEvents } from './client-events';

type Surfaces = Omit<
  ClientPluginRegistry,
  'signal' | 'config' | 'assets' | 'events' | 'themes' | 'styles'
>;
export type SurfaceFactory = (
  entry: ClientCatalogInstallation,
  signal: AbortSignal,
  queries: Pick<ClientHostBindings, 'useQuery' | 'useMutation'> &
    ReturnType<WorkspacePluginReads['bindings']> & {
      storage: import('@lody/plugin-sdk').PluginStorage;
      port: PluginCallPort;
      resolveMachine: (machineId: string) => ClientCatalogInstallation;
      useNavigation: () => ReturnType<typeof useWorkspaceNavigation>;
      useExecute: () => ReturnType<typeof usePluginCommandBindings>['execute'];
      useLodyCommand: ClientHostBindings['useLodyCommand'];
    },
  assets: ClientPluginRegistry['assets']
) => Surfaces;
export function routedPluginPort(
  workspaceId: string,
  resolveMachine: (id: string) => ClientCatalogInstallation
): PluginCallPort {
  return {
    async call(method, descriptor, ref, input, callSignal) {
      callSignal.throwIfAborted();
      if (ref.workspaceId !== workspaceId)
        throw Object.assign(Error('Workspace mismatch'), { code: 'forbidden' });
      const destination = resolveMachine(ref.machineId);
      if (!destination.machinePort)
        throw Object.assign(Error('Missing plugin port'), { code: 'not_found' });
      const data = await destination.machinePort.call(method, descriptor, ref, input, callSignal);
      if (resolveMachine(ref.machineId).digest !== destination.digest)
        throw Error('Target plugin changed');
      return data;
    },
  };
}
export function createWorkspacePluginRegistry(
  entry: ClientCatalogInstallation,
  reads: WorkspacePluginReads,
  owner: WorkspaceClientPlugins
): ClientCatalogInstallation['registry'] {
  return (files, signal, queries, primary = true) => {
    const resolveMachine = (machineId: string) => {
      signal.throwIfAborted();
      if (!primary && machineId !== entry.dev.machineId)
        throw Object.assign(Error('Target outside machine-bound contribution'), {
          code: 'forbidden',
        });
      return owner.resolveMachine(entry.pluginId, machineId);
    };
    const port = routedPluginPort(entry.workspaceId, resolveMachine);
    const assets = createPluginAssets(entry.dev.manifest.assets ?? [], files, signal);
    const readConfig = (project?: ProjectRef) => {
      if (
        project &&
        (project.workspaceId !== entry.workspaceId ||
          (!entry.readProject && project.machineId !== entry.dev.machineId))
      )
        throw Error('Invalid project configuration target');
      return Object.freeze(
        Object.fromEntries(
          Object.entries(entry.dev.manifest.config ?? {}).flatMap(([key, f]) => {
            if (f.type === 'secret' || f.scope === 'machine' || (f.scope === 'project' && !project))
              return [];
            const value =
              (f.scope === 'project'
                ? (entry.readProject?.(project!.machineId, project!.projectId) ??
                    entry.projectValues?.[project!.projectId])?.[key]
                : entry.inspection?.preferences[key]) ?? ('default' in f ? f.default : undefined);
            return value === undefined ? [] : [[key, value]];
          })
        )
      );
    };
    const hooks = createPluginQueryBindings(queries, port, {
      workspaceId: entry.workspaceId,
      signal,
    });
    const surfaces = createProductionSurfaces(
      entry,
      signal,
      {
        storage: clientStorage(
          owner.storageNamespace,
          JSON.stringify([entry.sourceKey, entry.pluginId]),
          signal
        ),
        port,
        resolveMachine,
        ...hooks,
        ...reads.bindings(
          signal,
          entry.pluginId,
          entry.dev.manifest.permissions?.includes('unstable.rawState')
        ),
        useNavigation: () => useWorkspaceNavigation(entry.workspaceId, entry.dev.machineId, signal),
        useExecute: () =>
          usePluginCommandBindings(
            entry.workspaceId,
            entry.dev.machineId,
            signal,
            entry.dev.manifest.permissions ?? [],
            resolveMachine,
            entry.pluginId
          ).execute,
        useLodyCommand(target, command) {
          return usePluginCommandBindings(
            entry.workspaceId,
            entry.dev.machineId,
            signal,
            entry.dev.manifest.permissions ?? [],
            resolveMachine,
            entry.pluginId
          ).useLodyCommand(target, command);
        },
      },
      assets
    );
    const ignore = () => {};
    return {
      ...surfaces,
      ...(primary
        ? createPluginAppearance(entry, entry.dev.manifest, files, signal)
        : {
            settings: {
              pages: {
                add(spec) {
                  if (spec.binding !== 'workspace') surfaces.settings.pages.add(spec);
                },
              },
            },
            commands: { register: ignore },
            composer: {
              ...surfaces.composer,
              actions: { add: ignore },
              slashCommands: { add: ignore },
              beforeSend: ignore,
            },
            tools: { ...surfaces.tools, matchRender: ignore },
            messages: { actions: { add: ignore }, renderBlock: ignore },
            statusBar: { items: { add: ignore } },
            session: { ...surfaces.session, headerActions: { add: ignore } },
            sidebar: {
              headerItems: { add: ignore },
              footerItems: { add: ignore },
              views: { add: ignore },
              sessionRow: { decorate: ignore },
            },
            screens: { add: ignore },
            themes: { add: ignore },
            styles: { add: ignore },
          }),
      signal,
      assets,
      events: !primary
        ? { on: () => ignore }
        : clientPluginEvents.subscribe(entry.workspaceId, signal, (e) =>
            clientDiagnostics.report(entry, 'event_handler_failed', String(e))
          ),
      config: {
        get: <T extends Readonly<Record<string, ReadonlyJsonPrimitive>>>(project?: ProjectRef) =>
          readConfig(project) as T,
      },
    };
  };
}
