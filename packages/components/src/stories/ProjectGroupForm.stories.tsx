import {
  AddLocalProjectDialog,
  type RemoteDirectoryOps,
} from '@/components/local-projects/add-local-project-dialog';
import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { LocalProjectId, MachineId, ProjectMemberId } from '@lody/shared';
import {
  ProjectGroupForm,
  type ProjectGroupFormProps,
  type ProjectGroupMemberStatus,
} from '@/components/settings/project-group-form';
import {
  buildProjectMemberSourceOptions,
  type ProjectMemberSourceOption,
} from '@/lib/project-member-sources';
import {
  addProjectGroupDirectory,
  EMPTY_PROJECT_GROUP_FORM_VALUE,
  getProjectMemberSourceKey,
  validateProjectGroupForm,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
} from '@/lib/project-group-form';

const here = 'machine-1' as MachineId;
const studio = 'machine-2' as MachineId;
const mini = 'machine-3' as MachineId;
const lz = 'machine-4' as MachineId;
const build = 'machine-5' as MachineId;
const local = (
  machineId: MachineId,
  machineName: string,
  id: string,
  githubRepoFullName?: string
) => ({
  machineId,
  machineName,
  online: true,
  project: {
    id: id as LocalProjectId,
    name: id,
    createdAtMs: 1,
    ...(githubRepoFullName ? { githubRepoFullName } : {}),
  },
});

// `web` has copies on two machines and `api` on one; `notes` and `ios` have
// no GitHub remote, so each binds a group to its machine.
const sources: ProjectMemberSourceOption[] = buildProjectMemberSourceOptions({
  localProjects: [
    local(here, 'zhaoliangdeMacBook-Pro.local', 'web', 'acme/web'),
    local(studio, 'wibusdeMacBook-Air-M2.local', 'web', 'acme/web'),
    local(studio, 'wibusdeMacBook-Air-M2.local', 'api', 'acme/api'),
    local(mini, "Lampese's Mac mini", 'api', 'acme/api'),
    local(here, 'zhaoliangdeMacBook-Pro.local', 'notes'),
    local(studio, 'wibusdeMacBook-Air-M2.local', 'ios'),
    local(lz, "lz's mac studio", 'loro', 'loro-dev/loro'),
    local(build, 'build-runner-02.internal', 'loro-ffi', 'loro-dev/loro-ffi'),
  ],
  githubRepositories: [
    { fullName: 'acme/web', description: 'Next.js frontend' },
    { fullName: 'acme/api', description: 'Go backend' },
    { fullName: 'acme/proto', description: 'Shared interface definitions' },
    { fullName: 'acme/docs' },
    ...Array.from({ length: 40 }, (_, index) => ({ fullName: `acme/service-${index + 1}` })),
  ],
});
const source = (key: string) => {
  const option = sources.find((candidate) => candidate.key === key);
  if (!option) throw new Error(`No story source ${key}`);
  return option.source;
};

const member = (
  id: string,
  sourceKey: string,
  placement: ProjectGroupMemberDraft['placement'],
  placementOrigin: ProjectGroupMemberDraft['placementOrigin'] = 'default'
): ProjectGroupMemberDraft => ({
  id: id as ProjectMemberId,
  source: source(sourceKey),
  placement,
  placementOrigin,
});

const shop: ProjectGroupFormValue = {
  name: 'Shop',
  instructions: '',
  members: [
    member('web', 'github:acme/web', { kind: 'root', dir: 'web' }),
    member('api', 'github:acme/api', { kind: 'root', dir: 'api' }),
    member(
      'proto',
      'github:acme/proto',
      { kind: 'submodule', parent: 'api' as ProjectMemberId, path: 'proto' },
      'detected'
    ),
  ],
};

const byKey = new Map(sources.map((option) => [option.key, option]));

/** The dialog owns the value and its validation in the product; the story does here. */
function StatefulProjectGroupForm(
  props: Omit<ProjectGroupFormProps, 'validation' | 'labelOf' | 'detailOf' | 'statusOf'> & {
    statuses?: Record<string, ProjectGroupMemberStatus>;
    nonGitIds?: readonly string[];
  }
) {
  const [value, setValue] = useState(props.value);
  const validation = useMemo(() => validateProjectGroupForm(value), [value]);
  return (
    <ProjectGroupForm
      {...props}
      value={value}
      onChange={setValue}
      validation={validation}
      labelOf={(m) => byKey.get(getProjectMemberSourceKey(m.source))?.label ?? 'Unknown'}
      detailOf={(m) => byKey.get(getProjectMemberSourceKey(m.source))?.description}
      statusOf={(id) => props.statuses?.[id]}
      isNonGit={(id) => props.nonGitIds?.includes(id) ?? false}
    />
  );
}

const meta = {
  title: 'Settings/ProjectGroupForm',
  component: StatefulProjectGroupForm,
  args: {
    value: shop,
    onChange: () => undefined,
    sources,
    currentMachineId: here,
    onSubmit: () => undefined,
    onCancel: () => undefined,
  },
  decorators: [
    // Mirrors the settings dialog that hosts the form.
    (Story) => (
      <div className="mx-auto flex h-[620px] w-[620px] flex-col gap-4 overflow-hidden rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatefulProjectGroupForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewGroup: Story = { args: { value: EMPTY_PROJECT_GROUP_FORM_VALUE } };

/** `proto` was found in `api`'s `.gitmodules`, so it nests under `api/`. */
export const DetectedSubmodule: Story = {};

/** Detection still running for one member and impossible for another. */
export const DetectionStates: Story = {
  args: {
    value: {
      ...shop,
      members: [
        member('web', 'github:acme/web', { kind: 'root', dir: 'web' }),
        member('api', 'github:acme/api', { kind: 'root', dir: 'api' }),
        member('proto', 'github:acme/proto', { kind: 'root', dir: 'proto' }),
      ],
    },
    statuses: { web: 'unavailable', api: 'pending' },
  },
};

/** Two members claim one directory; both rows carry the mark, the card says why. */
export const DuplicateDirectory: Story = {
  args: {
    value: {
      ...shop,
      members: [
        member('web', 'github:acme/web', { kind: 'root', dir: 'app' }),
        member('api', 'github:acme/api', { kind: 'root', dir: 'app' }),
      ],
    },
  },
};

export const WithInstructions: Story = {
  args: {
    value: {
      ...shop,
      instructions:
        'web is the Next.js frontend; api is the Go backend; proto holds the interfaces both share.',
    },
    isEditing: true,
  },
};

/** Someone else's group: visible, not editable. */
export const ReadOnly: Story = { args: { readOnly: true, isEditing: true } };

/** Submodules of submodules step in once per level, as they will on disk. */
export const NestedSubmodules: Story = {
  args: {
    value: {
      name: 'Lody',
      instructions: '',
      members: [
        member('api', 'github:acme/api', { kind: 'root', dir: 'api' }),
        member(
          'proto',
          'github:acme/proto',
          { kind: 'submodule', parent: 'api' as ProjectMemberId, path: 'proto' },
          'detected'
        ),
        member(
          'docs',
          'github:acme/docs',
          {
            kind: 'submodule',
            parent: 'proto' as ProjectMemberId,
            path: 'packages/acp-extension-docs',
          },
          'detected'
        ),
        member('web', 'github:acme/web', { kind: 'root', dir: 'web' }),
      ],
    },
  },
};

/** A folder without Git is used in place: it says so, and cannot be a submodule. */
export const NonGitDirectory: Story = {
  args: {
    value: {
      ...shop,
      members: [
        member('web', 'github:acme/web', { kind: 'root', dir: 'web' }),
        member('notes', `local:${here}:notes`, { kind: 'root', dir: 'notes' }),
      ],
    },
    nonGitIds: ['notes'],
  },
};

/**
 * The picker, open. `notes` binds the group to this machine, so folders on
 * other machines are disabled with the reason said once; repositories stay
 * open on any machine, and GitHub-only ones wait for a search.
 */
export const Picker: Story = {
  args: {
    value: {
      ...shop,
      members: [
        member('web', 'github:acme/web', { kind: 'root', dir: 'web' }),
        member('notes', `local:${here}:notes`, { kind: 'root', dir: 'notes' }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.click();
  },
};

/** Real creation controls with synthetic filesystem responses; no host folders are touched. */
function DirectFolderCreationPreview() {
  const [value, setValue] = useState<ProjectGroupFormValue>({
    name: 'Product workspace',
    instructions: '',
    members: [],
  });
  const [open, setOpen] = useState(false);
  const home = '/Users/demo/Projects';
  const folders = ['backend', 'frontend', 'design-notes'];
  const ops: RemoteDirectoryOps = {
    listRoots: async () => ({
      ok: true,
      value: { platform: 'darwin', pathSeparator: '/', homeDir: home },
    }),
    browseDir: async (_machineId, { absolutePath = home }) => ({
      ok: true,
      value: {
        path: absolutePath,
        parentPath: absolutePath === home ? null : home,
        truncated: false,
        entries:
          absolutePath === home
            ? folders.map((name) => ({
                name,
                absolutePath: `${home}/${name}`,
                isSymlink: false,
                hidden: false,
                hints: { git: name !== 'design-notes' },
              }))
            : [],
      },
    }),
    createDirectory: async () => ({ ok: false, message: 'Not available in this preview' }),
    addProject: async (machineId, { rootPath }) => {
      const name = rootPath.split('/').pop()!;
      const directory = {
        machineId,
        name,
        rootPath,
        localProjectId: `local-${name}` as LocalProjectId,
        inspection: { isGit: name !== 'design-notes', submodules: [] },
      };
      setValue((previous) => addProjectGroupDirectory(previous, directory));
      return { ok: true, value: { ...directory, status: 'added' } };
    },
  };
  return (
    <>
      <ProjectGroupForm
        value={value}
        onChange={setValue}
        sources={[]}
        currentMachineId={here}
        labelOf={(entry) => entry.directory?.name ?? 'Folder'}
        detailOf={(entry) => entry.directory?.rootPath}
        statusOf={() => undefined}
        isNonGit={(id) =>
          value.members.find((entry) => entry.id === id)?.directory?.inspection.isGit === false
        }
        validation={validateProjectGroupForm(value)}
        onSelectFolders={() => setOpen(true)}
        onSubmit={() => undefined}
        onCancel={() => setValue({ ...value, members: [] })}
      />
      <AddLocalProjectDialog
        selectionOnly
        open={open}
        onOpenChange={setOpen}
        initialMachineId={here}
        machines={[
          { id: here, name: 'This Mac', online: true, canAddProjects: true, ownerName: 'Demo' },
        ]}
        ops={ops}
        onAdded={() => undefined}
      />
    </>
  );
}

export const DirectFolderCreation: Story = { render: () => <DirectFolderCreationPreview /> };
