import type { Meta, StoryObj } from '@storybook/react';
import type { ProjectMember, ProjectMemberId } from '@lody/shared';
import { ProjectGroupMemberList } from '@/components/chat/project-group-member-list';

const id = (value: string) => value as ProjectMemberId;

// `lody-oss` is a submodule of `lody`, and `acp-extension-core` a submodule of
// `lody-oss`: two levels, as on disk.
const members: ProjectMember[] = [
  {
    id: id('lody'),
    source: { kind: 'github', repoFullName: 'loro-dev/lody', preferLocal: true },
    placement: { kind: 'root', dir: 'lody' },
  },
  {
    id: id('oss'),
    source: { kind: 'github', repoFullName: 'LodyAI/Lody', preferLocal: true },
    placement: { kind: 'submodule', parent: id('lody'), path: 'lody-oss' },
  },
  {
    id: id('core'),
    source: { kind: 'github', repoFullName: 'LodyAI/acp-extension-core' },
    placement: { kind: 'submodule', parent: id('oss'), path: 'packages/acp-extension-core' },
  },
  {
    id: id('docs'),
    source: { kind: 'github', repoFullName: 'LodyAI/site' },
    placement: { kind: 'root', dir: 'site' },
  },
];

function MemberList(props: { missing?: readonly string[]; canClone?: boolean }) {
  return (
    <div style={{ padding: 24, paddingTop: 260 }}>
      <ProjectGroupMemberList
        members={members}
        labelOf={(member) =>
          member.source.kind === 'github' ? member.source.repoFullName : member.id
        }
        missing={new Set((props.missing ?? []).map(id))}
        canClone={props.canClone}
      />
    </div>
  );
}

const meta = {
  title: 'Chat/ProjectGroupMemberList',
  component: MemberList,
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button')?.click();
  },
} satisfies Meta<typeof MemberList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every member, read-only; submodules step in per level. */
export const NestedSubmodules: Story = {};

/** Managed: a repository this machine has no copy of is cloned on start. */
export const ClonedOnStart: Story = { args: { missing: ['docs'], canClone: true } };

/** Local-only: the repository this machine lacks is why the group cannot start here. */
export const MissingOnThisMachine: Story = { args: { missing: ['docs'], canClone: false } };
