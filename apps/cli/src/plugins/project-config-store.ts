import {
  getWorkspaceFlockDocId,
  projectConfigPrefix,
  projectPluginValues,
  type WorkspaceId,
} from '@lody/shared';
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';
import type { LoroDocumentManager } from '../lib/loro/doc';
export function projectConfigStore(
  manager: () =>
    | (Pick<LoroDocumentManager, 'syncFlockDocOrThrow'> & {
        repo: Pick<LoroDocumentManager['repo'], 'openFlockDoc' | 'flush'>;
      })
    | undefined,
  workspace: WorkspaceId,
  machine: string
) {
  return async (
    manifest: PluginManifest,
    project: string,
    changes?: Record<string, string | number | boolean>,
    check?: () => void
  ) => {
    if (!changes && !Object.values(manifest.config ?? {}).some((f) => f.scope === 'project'))
      return {};
    const m = manager();
    if (!m) throw Error('Workspace configuration unavailable');
    const id = getWorkspaceFlockDocId(workspace);
    await m.syncFlockDocOrThrow(id, { timeoutMs: 10000, reason: 'plugin-project-config' });
    const handle = await m.repo.openFlockDoc(id);
    const { flock } = handle;
    const key = [...projectConfigPrefix(machine, manifest.id), project];
    const existing =
      Array.from(flock.scan({ prefix: key })).find((r) => r.key.length === key.length)?.value ?? {};
    const values = projectPluginValues(manifest, {
      ...projectPluginValues(manifest, existing),
      ...changes,
    });
    if (changes) {
      check?.();
      flock.set(key, values);
      flock.commit();
      await m.repo.flush();
      void handle.syncOnce().catch(() => {});
    }
    return values;
  };
}
