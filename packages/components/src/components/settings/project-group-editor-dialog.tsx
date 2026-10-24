import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  getProjectRepositoryFullName,
  getServerNow,
  type MachineId,
  type ProjectId,
  type ProjectMemberSource,
  type ProjectMemberId,
  type WorkspaceProject,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useDialogExitSnapshot } from '@/hooks/use-dialog-exit-snapshot';
import { useProjectMemberSources } from '@/hooks/use-project-member-sources';
import {
  useProjectSubmoduleDetection,
  type ProjectSubmoduleProbe,
} from '@/hooks/use-project-submodule-detection';
import { useWorkspaceProjectActions } from '@/hooks/use-workspace-projects';
import {
  applyDetectedProjectSubmodules,
  buildProjectGroupFormValue,
  buildWorkspaceProjectFromForm,
  EMPTY_PROJECT_GROUP_FORM_VALUE,
  getProjectMemberSourceKey,
  upgradeProjectGroupRepositoryMembers,
  validateProjectGroupForm,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
} from '@/lib/project-group-form';
import { Dialog } from '@/ui/dialog';
import { ProjectGroupForm, type ProjectGroupMemberStatus } from './project-group-form';
import { useProjectMemberSourceNames } from './project-group-source-picker';
import { useSettingsPane } from './settings-page-header';
import { SETTINGS_EDITOR_DIALOG_LAYOUT, SETTINGS_EDITOR_DIALOG_WIDTH } from './surface';

/** A `create` carries its id from the moment it opens, like the Role editor. */
export type ProjectGroupEditorState =
  | { mode: 'add'; projectId: ProjectId; value: ProjectGroupFormValue }
  | { mode: 'edit'; project: WorkspaceProject; value: ProjectGroupFormValue; readOnly: boolean };

export const openProjectGroupEditorForCreate = (): ProjectGroupEditorState => ({
  mode: 'add',
  projectId: crypto.randomUUID() as ProjectId,
  value: EMPTY_PROJECT_GROUP_FORM_VALUE,
});

export const openProjectGroupEditorForEdit = (
  project: WorkspaceProject,
  readOnly: boolean
): ProjectGroupEditorState => ({
  mode: 'edit',
  project,
  value: buildProjectGroupFormValue(project),
  readOnly,
});

/**
 * The one Project group editor: name, members, how they nest, and the
 * instructions the agent receives first.
 *
 * Submodule relationships are detected as members are added and applied
 * without moving a member the user placed by hand.
 */
export function ProjectGroupEditorDialog({
  editor: openEditor,
  onChange,
  onClose,
  onSaved,
  probeLocal: probeLocalOverride,
}: {
  editor: ProjectGroupEditorState | null;
  onChange: (editor: ProjectGroupEditorState) => void;
  onClose: () => void;
  onSaved?: (project: WorkspaceProject, meta: { created: boolean }) => void;
  /** Overrides the machine RPC probe of a local member's `.gitmodules` (tests). */
  probeLocal?: ProjectSubmoduleProbe;
}) {
  const { t } = useTranslation();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const settingsPane = useSettingsPane();
  const { upsert } = useWorkspaceProjectActions();
  const { options, byKey } = useProjectMemberSources();
  const { shown: editor, onOpenChangeComplete } = useDialogExitSnapshot(openEditor);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const readOnly = editor?.mode === 'edit' && editor.readOnly;
  const value = editor?.value ?? EMPTY_PROJECT_GROUP_FORM_VALUE;

  const labelOf = useCallback(
    (member: ProjectGroupMemberDraft) =>
      byKey.get(getProjectMemberSourceKey(member.source))?.label ??
      (member.source.kind === 'github'
        ? member.source.repoFullName
        : t('settings.projectGroups.source.missingLocal')),
    [byKey, t]
  );
  const currentMachineId = useAtomValue(localMachineIdAtom);
  const { machineName, machinesOf } = useProjectMemberSourceNames(options, currentMachineId);
  const detailOf = useCallback(
    (member: ProjectGroupMemberDraft) => {
      const option = byKey.get(getProjectMemberSourceKey(member.source));
      if (member.source.kind === 'local') return machineName(member.source.machineId);
      // A repository Member runs wherever there is a copy; a plain GitHub
      // Member is always cloned, so its copies are beside the point.
      return member.source.preferLocal ? machinesOf(option ?? { copies: [] }) : option?.description;
    },
    [byKey, machineName, machinesOf]
  );
  // Where each machine's local project went: a project with a GitHub remote
  // is listed under its repository, not on its own.
  const remoteByLocalKey = useMemo(() => {
    const remotes = new Map<string, string>();
    for (const option of options) {
      for (const key of option.localKeys) remotes.set(key, option.label);
    }
    return remotes;
  }, [options]);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  // A repository Member's submodules are read from a copy on an online
  // machine when there is one, this machine first.
  const localCopyOf = useCallback(
    (
      source: Extract<ProjectMemberSource, { kind: 'github' }>
    ): Extract<ProjectMemberSource, { kind: 'local' }> | undefined => {
      if (!source.preferLocal) return undefined;
      const copies = byKey.get(getProjectMemberSourceKey(source))?.copies ?? [];
      const copy =
        copies.find((candidate) => candidate.machineId === currentMachineId && candidate.online) ??
        copies.find((candidate) => candidate.online);
      return copy
        ? {
            kind: 'local',
            machineId: copy.machineId as MachineId,
            localProjectId: copy.localProjectId,
          }
        : undefined;
    },
    [byKey, currentMachineId]
  );
  // A local member's `.gitmodules` lives on its machine. An offline machine is
  // not asked at all (and nothing is reported), rather than failing a probe.
  const probeLocal = useMemo<ProjectSubmoduleProbe | undefined>(() => {
    if (probeLocalOverride) return probeLocalOverride;
    if (!runtime || !currentUserId) return undefined;
    return async (source) => {
      if (source.kind !== 'local') return undefined;
      if (!onlineMachineIds.has(source.machineId)) return null;
      const result = await runtime.requestProjectProbeLocalMember(
        source.machineId,
        source.localProjectId,
        currentUserId
      );
      if (!result) return undefined;
      return {
        repoFullName: result.repoFullName,
        isGit: result.isGit,
        submodules: result.submodules.map((submodule) => ({
          path: submodule.path,
          repoFullName:
            submodule.repoFullName ??
            getProjectRepositoryFullName(submodule.url, result.repoFullName),
        })),
      };
    };
  }, [currentUserId, onlineMachineIds, probeLocalOverride, runtime]);

  const detection = useProjectSubmoduleDetection(value.members, {
    enabled: openEditor !== null && !readOnly,
    probeLocal,
    localCopyOf,
  });
  // GitHub members name their repository; local members are what their
  // machine reported, so a folder and a GitHub entry of one repo match.
  const repositoryOf = useCallback(
    (member: ProjectGroupMemberDraft) =>
      member.source.kind === 'github'
        ? member.source.repoFullName
        : detection.repositories.get(member.id),
    [detection.repositories]
  );

  // Fold detection into the draft as answers arrive, and turn local members
  // whose machine now publishes a GitHub remote into repository Members. Both
  // helpers return the same value when nothing moves, so this settles.
  useEffect(() => {
    if (!openEditor || readOnly) return;
    const upgraded = upgradeProjectGroupRepositoryMembers(openEditor.value, (source) =>
      remoteByLocalKey.get(getProjectMemberSourceKey(source))
    );
    const next = applyDetectedProjectSubmodules(
      upgraded,
      detection.detected,
      repositoryOf,
      labelOf
    );
    if (next !== openEditor.value) onChange({ ...openEditor, value: next });
  }, [detection.detected, labelOf, onChange, openEditor, readOnly, remoteByLocalKey, repositoryOf]);

  const validation = useMemo(
    () =>
      validateProjectGroupForm(value, (source) => {
        const member = value.members.find(
          (candidate) =>
            candidate.source.kind === 'local' &&
            candidate.source.machineId === source.machineId &&
            candidate.source.localProjectId === source.localProjectId
        );
        const repoFullName = member ? detection.repositories.get(member.id) : undefined;
        return repoFullName ? { repoFullName } : undefined;
      }),
    [detection.repositories, value]
  );
  const statusOf = useCallback(
    (memberId: ProjectMemberId): ProjectGroupMemberStatus =>
      detection.pending.has(memberId)
        ? 'pending'
        : detection.unavailable.has(memberId)
          ? 'unavailable'
          : undefined,
    [detection.pending, detection.unavailable]
  );

  const close = () => {
    setError(undefined);
    onClose();
  };

  const save = async () => {
    if (!editor || readOnly || !validation.valid || !currentUserId) return;
    const project = buildWorkspaceProjectFromForm(editor.value, {
      id: editor.mode === 'add' ? editor.projectId : editor.project.id,
      existing: editor.mode === 'edit' ? editor.project : undefined,
      ownerUserId: currentUserId,
      now: getServerNow(),
    });
    if (!project) {
      setError(t('settings.projectGroups.errors.invalid'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      // Durable locally is done; the upload is not something to wait on.
      await upsert(project);
      onSaved?.(project, { created: editor.mode === 'add' });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={openEditor !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog.Content
        width={SETTINGS_EDITOR_DIALOG_WIDTH}
        centerOn={settingsPane}
        className={SETTINGS_EDITOR_DIALOG_LAYOUT}
        style={{ height: 'min(680px, 88dvh)' }}
      >
        <Dialog.Header>
          <Dialog.Title>
            {editor?.mode === 'edit'
              ? readOnly
                ? editor.project.name
                : t('settings.projectGroups.editTitle')
              : t('settings.projectGroups.addTitle')}
          </Dialog.Title>
          <Dialog.Description>
            {readOnly
              ? t('settings.projectGroups.readOnlyDescription')
              : t('settings.projectGroups.dialogDescription')}
          </Dialog.Description>
        </Dialog.Header>
        {editor ? (
          <ProjectGroupForm
            value={value}
            onChange={(next) => {
              // A panel fading out is not edited: a change there would reopen it.
              if (openEditor) onChange({ ...openEditor, value: next });
            }}
            sources={options}
            labelOf={labelOf}
            detailOf={detailOf}
            statusOf={statusOf}
            isNonGit={(memberId) => detection.nonGit.has(memberId)}
            currentMachineId={currentMachineId}
            validation={validation}
            readOnly={readOnly}
            submitting={submitting}
            error={error}
            isEditing={editor.mode === 'edit'}
            onSubmit={() => void save()}
            onCancel={close}
          />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
