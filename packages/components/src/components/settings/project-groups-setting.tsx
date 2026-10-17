import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceProject } from '@lody/shared';
import { userAtom } from '@/atoms';
import { useProjectMemberSources } from '@/hooks/use-project-member-sources';
import {
  canManageWorkspaceProject,
  useWorkspaceProjectActions,
  useWorkspaceProjects,
} from '@/hooks/use-workspace-projects';
import { getProjectMemberSourceKey } from '@/lib/project-group-form';
import { AlertDialog } from '@/ui/dialog';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { SettingsEmptyList, settingsRecordsCard } from './compact-layout';
import {
  openProjectGroupEditorForCreate,
  openProjectGroupEditorForEdit,
  ProjectGroupEditorDialog,
  type ProjectGroupEditorState,
} from './project-group-editor-dialog';
import { SettingsPageActions, SettingsPageLead } from './settings-page-header';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

/**
 * Settings → Project groups.
 *
 * Its own page beside Projects: a project is one folder or repository, a
 * Project group is several of them that one conversation works across.
 */
export function ProjectGroupsSetting() {
  const { t } = useTranslation();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const { projects, synced } = useWorkspaceProjects();
  const { remove } = useWorkspaceProjectActions();
  const { byKey } = useProjectMemberSources();
  const [editor, setEditor] = useState<ProjectGroupEditorState | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<WorkspaceProject | null>(null);
  const [removing, setRemoving] = useState(false);

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    setRemoving(true);
    try {
      await remove(pendingRemoval.id);
    } catch (cause) {
      console.error('Failed to delete project group', cause);
    } finally {
      setRemoving(false);
      setPendingRemoval(null);
    }
  };

  return (
    <div {...stylex.props(surface.container)}>
      <SettingsPageLead>{t('settings.projectGroups.description')}</SettingsPageLead>

      <SettingsPageActions>
        {!synced ? (
          <span {...stylex.props(catalog.syncing)}>
            <Spinner size="small" aria-hidden="true" />
            {t('settings.projectGroups.syncing')}
          </span>
        ) : null}
        <Button
          size="small"
          variant="secondary"
          onClick={() => setEditor(openProjectGroupEditorForCreate())}
        >
          <Plus {...stylex.props(catalog.icon)} />
          {t('settings.projectGroups.add')}
        </Button>
      </SettingsPageActions>

      {projects.length === 0 ? (
        <SettingsEmptyList>{t('settings.projectGroups.empty')}</SettingsEmptyList>
      ) : (
        <div {...stylex.props(settingsRecordsCard)}>
          {projects.map((project, index) => {
            const canManage = canManageWorkspaceProject(project, currentUserId);
            return (
              <div key={project.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
                <ProjectGroupRow
                  project={project}
                  memberNames={project.members.map(
                    (member) =>
                      byKey.get(getProjectMemberSourceKey(member.source))?.label ??
                      (member.source.kind === 'github'
                        ? member.source.repoFullName
                        : t('settings.projectGroups.source.missingLocal'))
                  )}
                  canManage={canManage}
                  onOpen={() => setEditor(openProjectGroupEditorForEdit(project, !canManage))}
                  onRemove={() => setPendingRemoval(project)}
                />
              </div>
            );
          })}
        </div>
      )}

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
    </div>
  );
}

/**
 * One group: its name and its members by name, which is what a group IS.
 */
export function ProjectGroupRow({
  project,
  memberNames,
  canManage,
  onOpen,
  onRemove,
}: {
  project: WorkspaceProject;
  /** Member names in the group's order. */
  memberNames: readonly string[];
  canManage: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div {...stylex.props(catalog.row, surface.pressableLine)}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={canManage ? t('common.edit') : t('common.view')}
        {...stylex.props(catalog.rowMain)}
      >
        <span {...stylex.props(catalog.glyph)}>
          <Boxes aria-hidden="true" {...stylex.props(catalog.icon)} />
        </span>
        <span {...stylex.props(catalog.body)}>
          <span {...stylex.props(catalog.titleLine)}>
            <span {...stylex.props(catalog.name)}>{project.name}</span>
            {project.instructions ? (
              <Badge>{t('settings.projectGroups.hasInstructions')}</Badge>
            ) : null}
          </span>
          <span {...stylex.props(catalog.meta)}>
            <span {...stylex.props(catalog.truncate)}>
              {t('settings.projectGroups.memberSummary', {
                count: memberNames.length,
                names: memberNames.join(' · '),
              })}
            </span>
          </span>
        </span>
      </button>
      <div {...stylex.props(catalog.actions)}>
        {canManage ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={t('common.remove')}
            size="small"
            icon
            tone="destructive"
            onClick={onRemove}
          >
            <Trash2 {...stylex.props(catalog.icon)} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
