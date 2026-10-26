import {
  getMachineFlockDocId,
  getServerNow,
  machineFlockKeys,
  parseMachineFlockRow,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type ProjectLocalMemberProbe,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { ProjectGroupMemberDraft } from './project-group-form';

export type AddLocalProjectResult = {
  status: 'added' | 'existing';
  localProjectId: LocalProjectId;
  name: string;
  rootPath: string;
  inspection?: ProjectLocalMemberProbe;
};

type NativeLocalProjectDirectorySelection =
  | { machineId: string; rootPath: string }
  | { error: string }
  | null;

type LocalProjectImportRuntime = Pick<
  WorkspaceRuntime,
  'workspaceId' | 'requestLocalProjectControl'
> & {
  writer: Pick<WorkspaceRuntime['writer'], 'flockRowPutIfAbsent' | 'flockRowUpdate'>;
};

/** Validate a selection without registering it. */
export async function prepareLocalProject(args: {
  runtime: Pick<LocalProjectImportRuntime, 'workspaceId' | 'requestLocalProjectControl'>;
  machineId: MachineId;
  rootPath: string;
  timeoutMessage: string;
  inspect?: boolean;
}) {
  const response = await args.runtime.requestLocalProjectControl(
    {
      type: 'local-project/prepare-add',
      machineId: args.machineId,
      workspaceId: args.runtime.workspaceId,
      rootPath: args.rootPath,
      ...(args.inspect ? { inspect: true } : {}),
    },
    { timeoutMs: 30_000 }
  );
  if (!response) throw new Error(args.timeoutMessage);
  if (!response.ok) throw new Error(response.message);
  if (response.type !== 'local-project/prepare-add') {
    throw new Error(`Unexpected response: ${response.type}`);
  }
  return response.result;
}

export async function setLocalProjectStandaloneVisibility(args: {
  runtime: Pick<LocalProjectImportRuntime, 'workspaceId' | 'writer'>;
  machineId: MachineId;
  localProjectId: LocalProjectId;
  visible: boolean;
}): Promise<boolean> {
  const key = machineFlockKeys.localProject(args.localProjectId);
  return args.runtime.writer.flockRowUpdate(
    getMachineFlockDocId(args.runtime.workspaceId, args.machineId),
    key,
    (current) => {
      const row = parseMachineFlockRow(key, current);
      if (!row || row.key[0] !== 'localProject') throw new Error('Local project is unavailable');
      if (((row.value as LocalProjectMeta).standaloneVisible !== false) === args.visible)
        return undefined;
      return { ...(current as LocalProjectMeta), standaloneVisible: args.visible };
    }
  );
}

export async function prepareAndWriteLocalProject(args: {
  runtime: LocalProjectImportRuntime;
  machineId: MachineId;
  rootPath: string;
  timeoutMessage: string;
  standaloneVisible?: boolean;
  inspect?: boolean;
  expectedLocalProjectId?: LocalProjectId;
  expectedInspection?: ProjectLocalMemberProbe;
  changedMessage?: string;
}): Promise<AddLocalProjectResult> {
  const prepared = await prepareLocalProject(args);
  if (args.expectedLocalProjectId && prepared.localProjectId !== args.expectedLocalProjectId) {
    throw new Error(args.changedMessage ?? 'The selected folder changed. Select it again.');
  }
  if (
    args.expectedInspection &&
    (!prepared.inspection ||
      prepared.inspection.isGit !== args.expectedInspection.isGit ||
      prepared.inspection.repoFullName !== args.expectedInspection.repoFullName)
  ) {
    throw new Error(args.changedMessage ?? 'The selected folder changed. Select it again.');
  }
  const publishInspection = async () => {
    if (!prepared.inspection) return;
    const inspection = prepared.inspection;
    const key = machineFlockKeys.localProject(prepared.localProjectId);
    await args.runtime.writer.flockRowUpdate(
      getMachineFlockDocId(args.runtime.workspaceId, args.machineId),
      key,
      (current) => {
        const row = parseMachineFlockRow(key, current);
        if (!row || row.key[0] !== 'localProject') throw new Error('Local project is unavailable');
        if ((row.value as LocalProjectMeta).githubRepoFullName === inspection.repoFullName)
          return undefined;
        const next = { ...(current as LocalProjectMeta) };
        if (inspection.repoFullName) next.githubRepoFullName = inspection.repoFullName;
        else delete next.githubRepoFullName;
        return next;
      }
    );
  };
  if (prepared.alreadyRegistered) {
    await publishInspection();
    const promoted =
      args.standaloneVisible !== false
        ? await setLocalProjectStandaloneVisibility({
            runtime: args.runtime,
            machineId: args.machineId,
            localProjectId: prepared.localProjectId,
            visible: true,
          })
        : false;
    return {
      status: promoted ? 'added' : 'existing',
      localProjectId: prepared.localProjectId,
      name: prepared.name,
      rootPath: prepared.rootPath,
      ...(prepared.inspection ? { inspection: prepared.inspection } : {}),
    };
  }
  const flockDocId = getMachineFlockDocId(args.runtime.workspaceId, args.machineId);
  const nowMs = getServerNow();
  const project: LocalProjectMeta = {
    id: prepared.localProjectId,
    name: prepared.name,
    rootPath: prepared.rootPath,
    createdAtMs: nowMs,
    lastOpenedAtMs: nowMs,
    ...(prepared.inspection?.repoFullName
      ? { githubRepoFullName: prepared.inspection.repoFullName }
      : {}),
    ...(args.standaloneVisible === false ? { standaloneVisible: false } : {}),
  };
  const projectKey = machineFlockKeys.localProject(project.id);
  const writeResult = await args.runtime.writer.flockRowPutIfAbsent(
    flockDocId,
    projectKey,
    project
  );
  const storedRow = parseMachineFlockRow(projectKey, writeResult.value);
  const storedProject =
    storedRow?.key[0] === 'localProject' ? (storedRow.value as LocalProjectMeta) : undefined;
  if (!storedProject || storedProject.id !== project.id) {
    throw new Error(`Existing local project row is invalid: ${project.id}`);
  }
  await publishInspection();
  const promoted =
    args.standaloneVisible !== false
      ? await setLocalProjectStandaloneVisibility({
          runtime: args.runtime,
          machineId: args.machineId,
          localProjectId: storedProject.id,
          visible: true,
        })
      : false;
  return {
    ...(prepared.inspection ? { inspection: prepared.inspection } : {}),
    status: writeResult.inserted || promoted ? 'added' : 'existing',
    localProjectId: storedProject.id,
    name: storedProject.name,
    rootPath: storedProject.rootPath,
  };
}

/** Complete all registrations before the caller publishes the Project definition. */
export async function registerProjectGroupDirectories(args: {
  runtime: LocalProjectImportRuntime;
  members: readonly ProjectGroupMemberDraft[];
  timeoutMessage: string;
  changedMessage: string;
}): Promise<void> {
  for (const member of args.members) {
    const directory = member.directory;
    if (!directory) continue;
    await prepareAndWriteLocalProject({
      runtime: args.runtime,
      machineId: directory.machineId,
      rootPath: directory.rootPath,
      standaloneVisible: false,
      inspect: true,
      expectedLocalProjectId: directory.localProjectId,
      expectedInspection: directory.inspection,
      changedMessage: args.changedMessage,
      timeoutMessage: args.timeoutMessage,
    });
  }
}

/** A folder picked for a project: a draft until save, or already registered. */
export type PickedProjectGroupFolder =
  | {
      kind: 'draft';
      directory: NonNullable<ProjectGroupMemberDraft['directory']>;
      result: AddLocalProjectResult;
    }
  | { kind: 'registered'; localProjectId: LocalProjectId; result: AddLocalProjectResult };

/**
 * Takes a folder picked for a project. A daemon that can inspect a folder
 * without registering it leaves it a draft until the project is saved. An
 * older daemon cannot, so the folder is registered now, hidden from standalone
 * lists as a save would; its GitHub remote arrives when the daemon publishes it.
 */
export async function pickProjectGroupFolder(args: {
  runtime: LocalProjectImportRuntime;
  machineId: MachineId;
  rootPath: string;
  canInspect: boolean;
  timeoutMessage: string;
  updateRequiredMessage: string;
}): Promise<PickedProjectGroupFolder> {
  if (!args.canInspect) {
    const result = await prepareAndWriteLocalProject({
      runtime: args.runtime,
      machineId: args.machineId,
      rootPath: args.rootPath,
      standaloneVisible: false,
      timeoutMessage: args.timeoutMessage,
    });
    return { kind: 'registered', localProjectId: result.localProjectId, result };
  }
  const prepared = await prepareLocalProject({ ...args, inspect: true });
  if (!prepared.inspection) throw new Error(args.updateRequiredMessage);
  return {
    kind: 'draft',
    directory: { ...prepared, machineId: args.machineId, inspection: prepared.inspection },
    result: { ...prepared, status: 'added' },
  };
}

/**
 * The Electron main process owns the native folder picker, but the renderer
 * owns the import mutation. Keep the picker IPC selection-only, then reuse the
 * same machine validation + WorkspaceWriter path as the remote directory UI.
 */
export async function selectAndWriteLocalProject(args: {
  runtime: LocalProjectImportRuntime;
  selectDirectory: () => Promise<NativeLocalProjectDirectorySelection>;
  timeoutMessage: string;
}): Promise<({ machineId: MachineId } & AddLocalProjectResult) | null> {
  const selection = await args.selectDirectory();
  if (!selection) return null;
  if ('error' in selection) throw new Error(selection.error);

  const machineId = selection.machineId.trim() as MachineId;
  const rootPath = selection.rootPath.trim();
  if (!machineId || !rootPath) throw new Error('Invalid local project directory selection');

  const result = await prepareAndWriteLocalProject({
    runtime: args.runtime,
    machineId,
    rootPath,
    timeoutMessage: args.timeoutMessage,
  });
  return { machineId, ...result };
}
