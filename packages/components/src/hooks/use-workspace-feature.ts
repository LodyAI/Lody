import { useAtomValue } from 'jotai';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import { workspaceSupports, type WorkspaceRestrictedFeature } from '@lody/shared/workspace-streams-content';

/** Local display guard. The operation must also check its explicit runtime/content. */
export function useWorkspaceFeature(feature: WorkspaceRestrictedFeature): boolean {
  const mode = useAtomValue(workspaceContentModeAtom);
  const encrypted = Boolean(mode?.descriptor && 'contentMode' in mode.descriptor && mode.descriptor.contentMode === 'e2ee');
  return workspaceSupports({ mode: encrypted ? 'protected' : 'plaintext' }, feature);
}
