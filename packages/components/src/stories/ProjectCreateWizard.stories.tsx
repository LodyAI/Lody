import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { LocalProjectId, MachineId, ProjectMemberId } from '@lody/shared';
import { Dialog } from '@lody/ui/dialog';
import {
  ProjectCreateWizard,
  type ProjectCreateWizardMachine,
  type ProjectCreateWizardStep,
} from '@/components/settings/project-create-wizard';
import { SETTINGS_EDITOR_DIALOG_WIDTH } from '@/components/settings/surface';
import {
  AddLocalProjectDialog,
  type RemoteDirectoryOps,
} from '@/components/local-projects/add-local-project-dialog';
import { buildProjectMemberSourceOptions } from '@/lib/project-member-sources';
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

const machines: ProjectCreateWizardMachine[] = [
  { id: here, name: 'zhaoliangdeMacBook-Pro.local', online: true },
  { id: studio, name: 'wibusdeMacBook-Air-M2.local', online: true },
  { id: mini, name: "Lampese's Mac mini", online: false },
];
const nameOf = new Map(machines.map((machine) => [machine.id, machine.name]));

const local = (
  machineId: MachineId,
  id: string,
  rootPath: string,
  githubRepoFullName?: string
) => ({
  machineId,
  machineName: nameOf.get(machineId)!,
  online: machineId !== mini,
  project: {
    id: id as LocalProjectId,
    name: id,
    createdAtMs: 1,
    rootPath,
    ...(githubRepoFullName ? { githubRepoFullName } : {}),
  },
});

// `web` and `api` have copies on this machine; `notes` and `design` have no
// GitHub remote, so they bind a project to it.
const sources = buildProjectMemberSourceOptions({
  localProjects: [
    local(here, 'web', '/Users/demo/code/web', 'acme/web'),
    local(here, 'api', '/Users/demo/code/api', 'acme/api'),
    local(here, 'notes', '/Users/demo/Documents/notes'),
    local(here, 'design', '/Users/demo/Documents/design-system'),
    // Its remote is outside the workspace's GitHub integration.
    local(here, 'tool', '/Users/demo/code/tool', 'private/tool'),
    local(studio, 'web', '/Users/wibus/web', 'acme/web'),
    local(studio, 'ios', '/Users/wibus/ios'),
    local(mini, 'api', '/Users/lampese/api', 'acme/api'),
  ],
  githubRepositories: [
    { fullName: 'acme/web', description: 'Next.js storefront' },
    { fullName: 'acme/api', description: 'Go backend and REST API' },
    { fullName: 'acme/proto', description: 'Shared interface definitions' },
    { fullName: 'acme/docs', description: 'Public documentation site' },
    { fullName: 'acme/infra', description: 'Terraform and deployment' },
    { fullName: 'acme/mobile', description: 'React Native app' },
    // Enough to show that the whole list is listed, not a searchable excerpt.
    ...Array.from({ length: 24 }, (_, index) => ({ fullName: `acme/service-${index + 1}` })),
  ],
});
const byKey = new Map(sources.map((option) => [option.key, option]));
const labelOf = (member: ProjectGroupMemberDraft) =>
  member.directory?.name ?? byKey.get(getProjectMemberSourceKey(member.source))?.label ?? 'Unknown';
const detailOf = (member: ProjectGroupMemberDraft) => {
  if (member.directory) return member.directory.rootPath;
  const option = byKey.get(getProjectMemberSourceKey(member.source));
  if (member.source.kind === 'local') return option?.copies[0]?.rootPath;
  return option?.description;
};

const member = (id: string, key: string, dir: string): ProjectGroupMemberDraft => ({
  id: id as ProjectMemberId,
  source: byKey.get(key)!.source,
  placement: { kind: 'root', dir },
  placementOrigin: 'default',
});

const localDraft: ProjectGroupFormValue = {
  name: '',
  instructions: '',
  members: [
    member('web', 'github:acme/web', 'web'),
    member('notes', `local:${here}:notes`, 'notes'),
    member('proto', 'github:acme/proto', 'proto'),
  ],
};
const githubDraft: ProjectGroupFormValue = {
  name: '',
  instructions: '',
  members: [
    {
      ...member('web', 'github:acme/web', 'web'),
      source: { kind: 'github', repoFullName: 'acme/web' },
    },
    member('proto', 'github:acme/proto', 'proto'),
  ],
};

/** A synthetic folder picked from the browser: not a listed project yet. */
const picked = addProjectGroupDirectory(localDraft, {
  machineId: here,
  localProjectId: 'scratch' as LocalProjectId,
  name: 'scratch',
  rootPath: '/Users/demo/scratch',
  inspection: { isGit: false, submodules: [] },
});

/**
 * The real folder browser over a synthetic filesystem; no host folders are
 * touched. Picking a folder drafts it into the project, as the dialog does.
 */
function browseOps(
  onPicked: (update: (value: ProjectGroupFormValue) => ProjectGroupFormValue) => void
): RemoteDirectoryOps {
  const home = '/Users/demo/Projects';
  const folders = ['backend', 'frontend', 'design-notes'];
  return {
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
      onPicked((value) => addProjectGroupDirectory(value, directory));
      return { ok: true, value: { ...directory, status: 'added' } };
    },
  };
}

/** The dialog owns the value and saving in the product; the story owns the value. */
function WizardInDialog({
  value: initial,
  initialStep,
  mode,
  takenNames = [],
}: {
  value: ProjectGroupFormValue;
  initialStep?: ProjectCreateWizardStep;
  mode?: 'create' | 'edit';
  /** Other projects' names, as the dialog normalizes them. */
  takenNames?: string[];
}) {
  const [value, setValue] = useState(initial);
  const [created, setCreated] = useState(false);
  const [single, setSingle] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const ops = useMemo(() => browseOps(setValue), []);
  const taken = useMemo(() => new Set(takenNames), [takenNames]);
  const validation = useMemo(
    () => validateProjectGroupForm(value, undefined, taken),
    [taken, value]
  );
  return (
    <>
      {/* The product saves here; the story records that it was asked to. */}
      {created ? <p role="status">Submitted</p> : null}
      {single ? <p role="status">Added as an ordinary project: {single}</p> : null}
      <Dialog.Root open modal={false}>
        <Dialog.Content
          width={SETTINGS_EDITOR_DIALOG_WIDTH}
          style={{ height: 'min(680px, 88dvh)' }}
        >
          <ProjectCreateWizard
            value={value}
            onChange={setValue}
            sources={sources}
            machines={machines}
            currentMachineId={here}
            labelOf={labelOf}
            detailOf={detailOf}
            validation={validation}
            canBrowseFolders={(machineId) => machineId !== mini}
            onBrowseFolders={() => setBrowsing(true)}
            initialStep={initialStep}
            mode={mode}
            onSubmit={() => setCreated(true)}
            onFinishSingle={(draft) => setSingle(draft.members.map(labelOf).join(', '))}
            takenNames={taken}
            onCancel={() => setValue(EMPTY_PROJECT_GROUP_FORM_VALUE)}
          />
        </Dialog.Content>
      </Dialog.Root>
      <AddLocalProjectDialog
        selectionOnly
        open={browsing}
        onOpenChange={setBrowsing}
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

const meta = {
  title: 'Settings/ProjectCreateWizard',
  component: WizardInDialog,
  args: { value: EMPTY_PROJECT_GROUP_FORM_VALUE },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WizardInDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first question: whether the project includes folders on a machine. */
export const ChooseKind: Story = {};

export const ChooseMachine: Story = { args: { initialStep: 'machine' } };

/** Folders on the chosen machine, with GitHub repositories one tab away. */
export const LocalSources: Story = { args: { value: picked } };

export const GithubSources: Story = { args: { value: githubDraft } };

export const LocalDetails: Story = {
  args: { value: { ...localDraft, name: 'Shop' }, initialStep: 'details' },
};

export const GithubDetails: Story = {
  args: { value: { ...githubDraft, name: 'Shop' }, initialStep: 'details' },
};

/** Editing walks the same questions; the project's current answers are marked. */
export const EditProject: Story = {
  args: { value: { ...localDraft, name: 'Shop' }, mode: 'edit' },
};

/** Another project already has this name. */
export const NameTaken: Story = {
  args: { value: { ...githubDraft, name: 'Shop' }, initialStep: 'details', takenNames: ['shop'] },
};
