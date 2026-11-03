import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { ProjectId, ProjectMemberId, WorkspaceProject } from '@lody/shared';
import { Tooltip } from '@lody/ui/tooltip';
import type { SidebarPrimaryView } from '@/atoms/sidebar-state';
import { ProjectHubView } from '@/components/project-hub/project-hub-workspace';
import {
  SidebarPrimaryViewSwitcher,
  SidebarProjectList,
} from '@/components/project-hub/sidebar-project-list';
import type { SessionListRow } from '@/components/session-list';

/**
 * Project hub prototype: the sidebar's 项目 / 对话 capsule with its project
 * cards, and the hub a project opens — the coordinator conversation on the
 * left, its sub-conversations grouped by what they need on the right.
 */
const meta = {
  title: 'Components/Project Hub',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

function project(id: string, name: string, repos: string[]): WorkspaceProject {
  return {
    v: 1,
    id: id as ProjectId,
    name,
    ownerUserId: 'user-demo',
    createdAtMs: minutesAgo(10_000),
    revision: 1,
    members: repos.map((repo, index) => ({
      id: `${id}-m${index}` as ProjectMemberId,
      source: { kind: 'github', repoFullName: repo },
      placement: { kind: 'root', dir: repo.split('/')[1] ?? repo },
    })),
  };
}

const PROJECTS: WorkspaceProject[] = [
  project('p-web', 'Storefront', ['acme/storefront']),
  project('p-platform', 'Platform release', ['acme/api', 'acme/web', 'acme/infra']),
  project('p-docs', 'Docs site', ['acme/docs']),
];

function row(
  sessionId: string,
  title: string,
  projectId: string,
  minutes: number,
  fields: Partial<SessionListRow> = {}
): SessionListRow {
  const owner = PROJECTS.find((candidate) => candidate.id === projectId);
  return {
    sessionId,
    title,
    branchName: `lody/${sessionId}`,
    latestMessageAt: minutesAgo(minutes),
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    projectGroup: owner ? { id: owner.id, name: owner.name } : null,
    ...fields,
  };
}

const ROWS: SessionListRow[] = [
  row('s1', 'Migrate auth middleware to the new session API', 'p-platform', 2, {
    isWaitingPermission: true,
  }),
  row('s2', 'Which feature flag owns the checkout rollout?', 'p-platform', 6, {
    isWaitingPermission: true,
  }),
  row('s3', 'Bump infra Terraform providers', 'p-platform', 1, { isWorking: true }),
  row('s4', 'Generate API client from OpenAPI spec', 'p-platform', 4, { isWorking: true }),
  row('s5', 'Fix flaky e2e login test', 'p-platform', 18, {
    hasUnreadMessages: true,
    prNumber: 4182,
    prStatus: 'open',
  }),
  row('s6', 'Add release notes for 2.4', 'p-platform', 45, {
    hasUnreadMessages: true,
    prNumber: 4177,
    prStatus: 'merged',
  }),
  row('s7', 'Audit unused env variables', 'p-platform', 60 * 26),
  row('s8', 'Investigate p95 latency regression', 'p-platform', 60 * 50),
  row('s9', 'Polish product page gallery', 'p-web', 12, { isWorking: true }),
];

function SidebarFrame() {
  const [view, setView] = useState<SidebarPrimaryView>('projects');
  const [selected, setSelected] = useState<string | null>('p-platform');
  return (
    <div className="flex h-[640px] w-[280px] flex-col bg-sidebar">
      <SidebarPrimaryViewSwitcher value={view} onChange={setView} />
      <div className="mt-3 px-1.5">
        {view === 'projects' ? (
          <SidebarProjectList
            projects={PROJECTS}
            rows={ROWS}
            selectedProjectId={selected}
            onSelectProject={setSelected}
            onCreateProject={() => {}}
          />
        ) : (
          <p className="px-2 text-sm text-muted-foreground">(existing conversation list)</p>
        )}
      </div>
    </div>
  );
}

export const SidebarProjects: Story = {
  render: () => (
    <Tooltip.Provider>
      <SidebarFrame />
    </Tooltip.Provider>
  ),
};

export const SidebarEmpty: Story = {
  render: () => (
    <Tooltip.Provider>
      <div className="h-[320px] w-[280px] bg-sidebar px-1.5">
        <SidebarPrimaryViewSwitcher value="projects" onChange={() => {}} />
        <div className="mt-3">
          <SidebarProjectList
            projects={[]}
            rows={[]}
            selectedProjectId={null}
            onSelectProject={() => {}}
            onCreateProject={() => {}}
          />
        </div>
      </div>
    </Tooltip.Provider>
  ),
};

export const Hub: Story = {
  render: () => (
    <Tooltip.Provider>
      <div className="h-[760px] w-full">
        <ProjectHubView
          project={PROJECTS[1]!}
          rows={ROWS.filter((candidate) => candidate.projectGroup?.id === 'p-platform')}
          onOpenSession={() => {}}
          onNewSubConversation={() => {}}
        />
      </div>
    </Tooltip.Provider>
  ),
};

export const HubEmpty: Story = {
  render: () => (
    <Tooltip.Provider>
      <div className="h-[560px] w-full">
        <ProjectHubView
          project={PROJECTS[2]!}
          rows={[]}
          onOpenSession={() => {}}
          onNewSubConversation={() => {}}
        />
      </div>
    </Tooltip.Provider>
  ),
};
