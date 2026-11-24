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
import type { ClientCatalogInstallation } from './client-host-provider';
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
      useNavigation: () => ReturnType<typeof useWorkspaceNavigation>;
      useExecute: () => ReturnType<typeof usePluginCommandBindings>['execute'];
      useLodyCommand: ClientHostBindings['useLodyCommand'];
    },
  assets: ClientPluginRegistry['assets']
) => Surfaces;
export function createWorkspacePluginRegistry(
  entry: ClientCatalogInstallation,
  port: PluginCallPort,
  reads: WorkspacePluginReads,
  storageNamespace: string
): ClientCatalogInstallation['registry'] {
  return (files, signal, queries) => {
    const assets = createPluginAssets(entry.dev.manifest.assets ?? [], files, signal);
    const readConfig = (project?: ProjectRef) => {
      if (
        project &&
        (project.workspaceId !== entry.workspaceId || project.machineId !== entry.dev.machineId)
      )
        throw Error('Invalid project configuration target');
      return Object.freeze(
        Object.fromEntries(
          Object.entries(entry.dev.manifest.config ?? {}).flatMap(([key, f]) => {
            if (f.type === 'secret' || f.scope === 'machine' || (f.scope === 'project' && !project))
              return [];
            const value =
              (f.scope === 'project'
                ? entry.inspection?.projectPreferences?.[project!.projectId]?.[key]
                : entry.inspection?.preferences[key]) ?? ('default' in f ? f.default : undefined);
            return value === undefined ? [] : [[key, value]];
          })
        )
      );
    };
    const hooks = createPluginQueryBindings(queries, port, {
      workspaceId: entry.workspaceId,
      machineId: entry.dev.machineId,
      signal,
    });
    return {
      ...createProductionSurfaces(
        entry,
        signal,
        {
          storage: clientStorage(
            storageNamespace,
            JSON.stringify([entry.sourceKey, entry.pluginId]),
            signal
          ),
          port,
          ...hooks,
          ...reads.bindings(
            signal,
            entry.pluginId,
            entry.dev.manifest.permissions?.includes('unstable.rawState')
          ),
          useNavigation: () =>
            useWorkspaceNavigation(entry.workspaceId, entry.dev.machineId, signal),
          useExecute: () =>
            usePluginCommandBindings(
              entry.workspaceId,
              entry.dev.machineId,
              signal,
              entry.dev.manifest.permissions ?? [],
              entry.reserveSession
            ).execute,
          useLodyCommand(target, command) {
            return usePluginCommandBindings(
              entry.workspaceId,
              entry.dev.machineId,
              signal,
              entry.dev.manifest.permissions ?? [],
              entry.reserveSession
            ).useLodyCommand(target, command);
          },
        },
        assets
      ),
      ...createPluginAppearance(entry, entry.dev.manifest, files, signal),
      signal,
      assets,
      events: clientPluginEvents.subscribe(entry.workspaceId, signal, (e) =>
        clientDiagnostics.report(entry, 'event_handler_failed', String(e))
      ),
      config: {
        get: <T extends Readonly<Record<string, ReadonlyJsonPrimitive>>>(project?: ProjectRef) =>
          readConfig(project) as T,
      },
    };
  };
}
