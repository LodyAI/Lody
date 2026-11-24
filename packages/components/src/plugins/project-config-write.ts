import {
  getWorkspaceFlockDocId,
  projectConfigPrefix,
  projectPluginValues,
  type WorkspaceId,
} from '@lody/shared';
import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';
import type { WorkspaceWriter } from '../providers/workspace-writer';
import type { E2eeMachineSharingView } from '@lody/platform';
export async function writeProjectConfig(input: {
  workspaceId: WorkspaceId;
  machine: string;
  project: string;
  manifest: PluginManifest;
  changes: Record<string, string | number | boolean>;
  writer: Pick<WorkspaceWriter, 'flockRowUpdate'>;
  check: () => void;
  readSharing?: () => Promise<E2eeMachineSharingView | undefined>;
}) {
  const { workspaceId, machine, project, manifest, changes, writer, check, readSharing } = input;
  check();
  if (readSharing) {
    const view = await readSharing();
    if (
      !view ||
      view.machineId !== machine ||
      view.removed ||
      view.unavailable ||
      (!view.canManage &&
        (!view.sharedWithTeam || !view.projects.includes(project) || view.deniedReason))
    )
      throw Error('Project configuration forbidden');
  }
  await writer.flockRowUpdate(
    getWorkspaceFlockDocId(workspaceId),
    [...projectConfigPrefix(machine, manifest.id), project],
    (current) => {
      check();
      return projectPluginValues(manifest, {
        ...projectPluginValues(manifest, current ?? {}),
        ...changes,
      });
    }
  );
}
