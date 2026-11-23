import type { Meta, StoryObj } from '@storybook/react';
import type { LocalProjectId, MachineId, ProjectMemberId } from '@lody/shared';
import { Dialog } from '@lody/ui/dialog';
import { ProjectGroupView } from '@/components/settings/project-group-form';
import { SETTINGS_EDITOR_DIALOG_WIDTH } from '@/components/settings/surface';
import type { ProjectGroupFormValue, ProjectGroupMemberDraft } from '@/lib/project-group-form';

const here = 'machine-1' as MachineId;
const member = (
  id: string,
  source: ProjectGroupMemberDraft['source'],
  placement: ProjectGroupMemberDraft['placement']
): ProjectGroupMemberDraft => ({
  id: id as ProjectMemberId,
  source,
  placement,
  placementOrigin: 'user',
});

// `proto` is a submodule of `api`, and `docs` one of `proto`; `notes` is a
// folder on one machine.
const shop: ProjectGroupFormValue = {
  name: 'Shop',
  instructions:
    'web is the Next.js frontend; api is the Go backend; proto holds the interfaces both share.',
  members: [
    member('web', { kind: 'github', repoFullName: 'acme/web' }, { kind: 'root', dir: 'web' }),
    member(
      'api',
      { kind: 'github', repoFullName: 'acme/api', preferLocal: true },
      { kind: 'root', dir: 'api' }
    ),
    member(
      'proto',
      { kind: 'github', repoFullName: 'acme/proto' },
      { kind: 'submodule', parent: 'api' as ProjectMemberId, path: 'proto' }
    ),
    member(
      'docs',
      { kind: 'github', repoFullName: 'acme/docs' },
      { kind: 'submodule', parent: 'proto' as ProjectMemberId, path: 'packages/docs' }
    ),
    member(
      'notes',
      { kind: 'local', machineId: here, localProjectId: 'notes' as LocalProjectId },
      { kind: 'root', dir: 'notes' }
    ),
  ],
};

const labelOf = (entry: ProjectGroupMemberDraft) =>
  entry.source.kind === 'github' ? entry.source.repoFullName : entry.source.localProjectId;

/** A teammate's project, seen by someone who may not change it. */
function ReadOnlyProject({ value }: { value: ProjectGroupFormValue }) {
  return (
    <Dialog.Root open modal={false}>
      <Dialog.Content width={SETTINGS_EDITOR_DIALOG_WIDTH} style={{ height: 'min(680px, 88dvh)' }}>
        <Dialog.Header>
          <Dialog.Title>{value.name}</Dialog.Title>
        </Dialog.Header>
        <ProjectGroupView
          value={value}
          labelOf={labelOf}
          detailOf={(entry) => (entry.source.kind === 'local' ? '/Users/demo/notes' : undefined)}
          onClose={() => undefined}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

const meta = {
  title: 'Settings/ProjectGroupView',
  component: ReadOnlyProject,
  args: { value: shop },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReadOnlyProject>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Submodules nest one step per level, each with the path it gets on disk. */
export const ReadOnly: Story = {};

export const WithoutInstructions: Story = { args: { value: { ...shop, instructions: '' } } };
