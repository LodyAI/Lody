import type { Meta, StoryObj } from '@storybook/react';
import type { ProjectMemberId } from '@lody/shared';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import { SessionProjectMembersChip } from '@/components/sessions/session-project-members-chip';
import type { SessionProjectMemberRow } from '@/lib/session-project-members';

const rows: SessionProjectMemberRow[] = [
  {
    id: 'web' as ProjectMemberId,
    path: 'web',
    kind: 'local',
    isSubmodule: false,
    depth: 0,
    hasChildren: false,
    repoFullName: 'acme/web',
    branch: 'lody/export-report',
    dirty: true,
    unpushed: false,
    pr: { url: 'https://github.com/acme/web/pull/412', number: 412, status: 'open', ciState: 'f' },
  },
  {
    id: 'api' as ProjectMemberId,
    path: 'api',
    kind: 'github',
    isSubmodule: false,
    depth: 0,
    hasChildren: true,
    repoFullName: 'acme/api',
    branch: 'lody/export-report',
    dirty: false,
    unpushed: false,
    pr: { url: 'https://github.com/acme/api/pull/88', number: 88, status: 'draft', ciState: 's' },
  },
  {
    id: 'proto' as ProjectMemberId,
    path: 'api/proto',
    kind: 'github',
    isSubmodule: true,
    parentId: 'api' as ProjectMemberId,
    depth: 1,
    hasChildren: false,
    repoFullName: 'acme/proto',
    branch: 'lody/export-report-proto',
    dirty: false,
    unpushed: true,
  },
  {
    id: 'docs' as ProjectMemberId,
    path: 'docs',
    kind: 'local',
    isSubmodule: false,
    depth: 0,
    hasChildren: false,
    access: 'additional',
    dirty: true,
    unpushed: false,
  },
];

const meta = {
  title: 'Sessions/SessionProjectMembersChip',
  component: SessionProjectMembersChip,
  args: {
    groupName: 'Shop',
    rows,
    onSelectMember: () => undefined,
    onOpenPullRequest: () => undefined,
    defaultOpen: true,
  },
  // The popover takes the width of the info bar it opens from, so the story
  // renders the real bar rather than the chip alone.
  render: (args) => (
    <div className="flex max-w-full flex-col p-6" style={{ width: 720 }}>
      <div className="h-64" />
      <SessionInfoBar
        status={null}
        projectName="acme/web"
        branch="lody/export-report"
        diffStat={{ add: 212, del: 40 }}
        projectMembers={<SessionProjectMembersChip {...args} />}
      />
    </div>
  ),
} satisfies Meta<typeof SessionProjectMembersChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every state at once: dirty, unpushed, failing and passing CI, no PR yet. */
export const Mixed: Story = {};

/** Nothing pushed yet: every row says No PR, the summary counts zero. */
export const BeforeAnyPr: Story = {
  args: { rows: rows.map(({ pr: _pr, ...row }) => row) },
};

/** The selected repository is the one the context stage describes. */
export const Selected: Story = {
  args: { selectedMemberId: 'web' as ProjectMemberId },
};
