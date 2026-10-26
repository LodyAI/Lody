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

/** The dialog owns the value and saving in the product; the story owns the value. */
function WizardInDialog({
  value: initial,
  initialStep,
}: {
  value: ProjectGroupFormValue;
  initialStep?: ProjectCreateWizardStep;
}) {
  const [value, setValue] = useState(initial);
  const validation = useMemo(() => validateProjectGroupForm(value), [value]);
  return (
    <Dialog.Root open modal={false}>
      <Dialog.Content width={SETTINGS_EDITOR_DIALOG_WIDTH} style={{ height: 'min(680px, 88dvh)' }}>
        <ProjectCreateWizard
          value={value}
          onChange={setValue}
          sources={sources}
          machines={machines}
          currentMachineId={here}
          labelOf={labelOf}
          detailOf={detailOf}
          validation={validation}
          canBrowseFolders={(machineId) => machineId === here}
          onBrowseFolders={() => undefined}
          initialStep={initialStep}
          onSubmit={() => undefined}
          onCancel={() => setValue(EMPTY_PROJECT_GROUP_FORM_VALUE)}
        />
      </Dialog.Content>
    </Dialog.Root>
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
