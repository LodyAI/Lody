import { useEffect, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { WorkspaceProject } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { AlertDialog } from '@/ui/dialog';
import { userAtom } from '@/atoms';
import { projectEditorRequestAtom } from '@/atoms/project-editor';
import { useProjectMemberSources } from '@/hooks/use-project-member-sources';
import {
  canManageWorkspaceProject,
  useWorkspaceProjectActions,
  useWorkspaceProjects,
} from '@/hooks/use-workspace-projects';
import { addProjectGroupMember, EMPTY_PROJECT_GROUP_FORM_VALUE } from '@/lib/project-group-form';
import {
  openProjectGroupEditorForCreate,
  openProjectGroupEditorForEdit,
  ProjectGroupEditorDialog,
  type ProjectGroupEditorState,
} from './project-group-editor-dialog';

/**
 * The one multi-repository project editor, mounted once beside the other
 * workspace dialogs. Any surface opens it through `projectEditorRequestAtom`;
 * an edit request waits until its project has synced, then the request is
 * consumed so reopening a surface does not reopen the editor.
 */
export function ProjectEditorHost() {
  const [request, setRequest] = useAtom(projectEditorRequestAtom);
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const { projects, synced } = useWorkspaceProjects();
  const { byKey } = useProjectMemberSources();
  const { t } = useTranslation();
  const { remove } = useWorkspaceProjectActions();
  const [editor, setEditor] = useState<ProjectGroupEditorState | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<WorkspaceProject | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!request) return;
    if (request.kind === 'edit' || request.kind === 'delete') {
      const project = projects.find((candidate) => candidate.id === request.projectId);
      if (!project) {
        if (synced) setRequest(null);
        return;
      }
      const canManage = canManageWorkspaceProject(project, currentUserId);
      if (request.kind === 'edit') setEditor(openProjectGroupEditorForEdit(project, !canManage));
      // Only the creator deletes; anyone else asking is a no-op, not an error.
      else if (canManage) setPendingRemoval(project);
      setRequest(null);
      return;
    }
    const created = openProjectGroupEditorForCreate();
    // A folder with a GitHub remote is listed under its repository, so its
    // own key finds the repository row and the seed becomes a repository Member.
    const seed = request.seedSourceKey ? byKey.get(request.seedSourceKey) : undefined;
    setEditor(
      seed
        ? {
            ...created,
            value: addProjectGroupMember(
              { ...EMPTY_PROJECT_GROUP_FORM_VALUE, name: request.seedName ?? seed.label },
              seed.source,
              seed.label
            ),
          }
        : created
    );
    setRequest(null);
  }, [byKey, currentUserId, projects, request, setRequest, synced]);

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    setRemoving(true);
    try {
      await remove(pendingRemoval.id);
    } catch (cause) {
      console.error('Failed to delete project', cause);
    } finally {
      setRemoving(false);
      setPendingRemoval(null);
    }
  };

  return (
    <>
      <ProjectGroupEditorDialog
        editor={editor}
        onChange={setEditor}
        onClose={() => setEditor(null)}
      />
      <AlertDialog.Root
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('settings.projectGroups.removeTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.projectGroups.confirmRemove', { name: pendingRemoval?.name ?? '' })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={removing}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={removing}
              variant="destructive"
              onClick={() => {
                void confirmRemoval();
              }}
            >
              {removing ? <Spinner size="small" /> : null}
              {t('common.remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
