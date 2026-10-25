import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  addProjectGroupDirectory,
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
import { prepareLocalProject, registerProjectGroupDirectories } from '@/lib/local-project-import';
import {
  AddLocalProjectDialog,
  type RemoteDirectoryOps,
} from '../local-projects/add-local-project-dialog';
import { useAddLocalProjectController } from '../local-projects/add-local-project-dialog-container';
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
  const [selectingFolder, setSelectingFolderState] = useState(false);
  const folderSelection = useRef(false);
  const folderSelectionGeneration = useRef(0);
  const setSelectingFolder = (open: boolean) => {
    folderSelection.current = open;
    folderSelectionGeneration.current += 1;
    setSelectingFolderState(open);
  };
  const saving = useRef(false);
  const editorOpen = openEditor !== null;
  useEffect(() => {
    if (!editorOpen) {
      folderSelection.current = false;
      folderSelectionGeneration.current += 1;
      setSelectingFolderState(false);
    }
    return () => {
      folderSelection.current = false;
    };
  }, [editorOpen]);
  const editorRef = useRef(openEditor);
  editorRef.current = openEditor;

  const readOnly = editor?.mode === 'edit' && editor.readOnly;
  const value = editor?.value ?? EMPTY_PROJECT_GROUP_FORM_VALUE;

  const labelOf = useCallback(
    (member: ProjectGroupMemberDraft) =>
      member.directory?.name ??
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
      if (member.directory) return member.directory.rootPath;
      const option = byKey.get(getProjectMemberSourceKey(member.source));
      if (member.source.kind === 'local')
        return option?.copies[0]?.rootPath ?? machineName(member.source.machineId);
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
  const selectProject = useCallback<RemoteDirectoryOps['addProject']>(
    async (machineId, args) => {
      if (!runtime || !editorRef.current)
        return { ok: false, message: t('settings.projectGroups.errors.invalid') };
      const selectionGeneration = folderSelectionGeneration.current;
      const selectingEditor = editorRef.current;
      const id =
        selectingEditor.mode === 'add' ? selectingEditor.projectId : selectingEditor.project.id;
      try {
        const prepared = await prepareLocalProject({
          runtime,
          machineId,
          rootPath: args.rootPath,
          inspect: true,
          timeoutMessage: t('localProjects.add.timeout'),
        });
        if (!prepared.inspection) throw new Error(t('settings.projectGroups.folderUpdateRequired'));
        const latest = editorRef.current;
        if (
          selectionGeneration !== folderSelectionGeneration.current ||
          !folderSelection.current ||
          !latest ||
          (latest.mode === 'add' ? latest.projectId : latest.project.id) !== id
        ) {
          return { ok: false, message: t('settings.projectGroups.errors.invalid') };
        }
        const next = addProjectGroupDirectory(latest.value, {
          ...prepared,
          machineId,
          inspection: prepared.inspection,
        });
        const checked = validateProjectGroupForm(next);
        if (
          [...checked.memberErrors.values()].some((errors) => errors.includes('machine_mismatch'))
        ) {
          throw new Error(t('settings.projectGroups.memberErrors.machine_mismatch'));
        }
        onChange({ ...latest, value: next });
        return { ok: true, value: { ...prepared, status: 'added' } };
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    [onChange, runtime, t]
  );
  const folderController = useAddLocalProjectController(undefined, undefined, selectProject);
  const folderMachines = folderController.machines.filter(
    (machine) =>
      machine.id === currentMachineId &&
      machine.canAddProjects &&
      machine.supportsProjectFolderSelection
  );
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  // A repository Member's submodules are read from a copy on an online
  // machine when there is one, this machine first.
  const localCopyOf = useCallback(
    (
      source: Extract<ProjectMemberSource, { kind: 'github' }>
    ): Extract<ProjectMemberSource, { kind: 'local' }> | undefined => {
      if (!source.preferLocal) return undefined;
      const directory = value.members.find(
        (member) => getProjectMemberSourceKey(member.source) === getProjectMemberSourceKey(source)
      )?.directory;
      if (directory)
        return {
          kind: 'local',
          machineId: directory.machineId,
          localProjectId: directory.localProjectId,
        };
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
    [byKey, currentMachineId, value.members]
  );
  // A local member's `.gitmodules` lives on its machine. An offline machine is
  // not asked at all (and nothing is reported), rather than failing a probe.
  const probeLocal = useMemo<ProjectSubmoduleProbe | undefined>(() => {
    if (probeLocalOverride) return probeLocalOverride;
    if (!runtime || !currentUserId) return undefined;
    return async (source) => {
      if (source.kind !== 'local') return undefined;
      const directory = value.members.find(
        (member) =>
          member.directory?.machineId === source.machineId &&
          member.directory.localProjectId === source.localProjectId
      )?.directory;
      if (directory) return directory.inspection;
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
  }, [currentUserId, onlineMachineIds, probeLocalOverride, runtime, value.members]);

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
    if (submitting) return;
    setSelectingFolder(false);
    setError(undefined);
    onClose();
  };

  const save = async () => {
    if (!editor || readOnly || saving.current || !validation.valid || !currentUserId || !runtime)
      return;
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
    saving.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await registerProjectGroupDirectories({
        runtime,
        members: editor.value.members,
        timeoutMessage: t('localProjects.add.timeout'),
        changedMessage: t('settings.projectGroups.folderChanged'),
      });
      // Durable locally is done; the upload is not something to wait on.
      await upsert(project);
      onSaved?.(project, { created: editor.mode === 'add' });
      setSelectingFolder(false);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      setSubmitting(false);
    }
  };

  return (
    <>
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
              isNonGit={(memberId) =>
                value.members.find((member) => member.id === memberId)?.directory?.inspection
                  .isGit === false || detection.nonGit.has(memberId)
              }
              currentMachineId={currentMachineId}
              validation={validation}
              readOnly={readOnly}
              submitting={submitting}
              error={error}
              isEditing={editor.mode === 'edit'}
              onSelectFolders={() => setSelectingFolder(true)}
              selectFoldersDisabled={
                folderMachines.length === 0 || !folderMachines.some((machine) => machine.online)
              }
              onSubmit={() => void save()}
              onCancel={close}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
      <AddLocalProjectDialog
        selectionOnly
        open={selectingFolder && openEditor !== null}
        onOpenChange={setSelectingFolder}
        machines={folderMachines}
        initialMachineId={currentMachineId}
        ops={folderController.ops}
        onAdded={() => undefined}
      />
    </>
  );
}
