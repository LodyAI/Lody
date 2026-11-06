import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { Archive, Bot, FolderPlus, Search, SlidersHorizontal } from 'lucide-react';
import type { LocalProjectId, MachineId, SessionId, SessionMeta } from '@lody/shared';
import { SessionStatusFactory } from '@lody/shared';
import { toast } from '@/lib/toast';

import {
  ArchivedSessionGroupSection,
  type ArchivedSessionGroup,
} from '@/components/archive/archive-view';
import { WebArchiveScreen } from '@/components/archive/web-archive-screen';
import { LocalProjectItem, type LocalProjectRemovalState } from '@/components/loro-app-sidebar';
import { LoroSidebar, type LoroSidebarNavKey } from '@/components/loro-sidebar';
import { MobileHomeScreen } from '@/components/mobile/mobile-home-screen';
import { SidebarSectionHeader } from '@/components/sidebar-row-shared';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Toast } from '@lody/ui';
import { toastManager } from '@/lib/toast';
const removalStory = stylex.create({
  sidebar: { height: '100%', flexShrink: 0 },
  add: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-sm)',
    color: {
      default: 'color-mix(in oklab,hsl(var(--muted-foreground) / 1) 80%,transparent)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 1)' },
    },
    backgroundColor: {
      default: null,
      '@media (hover: hover)': {
        ':hover': 'color-mix(in oklab,hsl(var(--muted) / 1) 30%,transparent)',
      },
    },
  },
  search: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 'calc(var(--spacing) * 3)',
    top: '50%',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    translate: '0 -50%',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});
const storySpacing = stylex.create({
  children: {
    marginBottom: 'calc(var(--spacing) * 3)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 0.5)',
    },
  },
  children1: {
    marginBottom: 'calc(var(--spacing) * 8)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 6)',
    },
  },
});

const storyLayoutStylesStylesStylesStyles = stylex.create({
  element: {
    paddingLeft: 'calc(var(--spacing) * 9)',
  },
});

const storyLayoutStylesStylesStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
});

const storyLayoutStylesStyles = stylex.create({
  canvas: {
    'border-radius': 'var(--radius-2xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'background-color': 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 3)',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  },
});

const storyLayoutStyles = stylex.create({
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 11)',
    'flex-shrink': '0',
    'align-items': 'center',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'padding-inline': 'calc(var(--spacing) * 4)',
  },
  caption: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  canvas: {
    'margin-left': 'auto',
    'max-width': '72%',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--muted) / 1)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--leading-relaxed)',
  },
  row2: {
    display: 'flex',
    'max-width': '78%',
    gap: 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--leading-relaxed)',
  },
  frame: {
    'min-height': 'calc(var(--spacing) * 12)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  row3: {
    'margin-bottom': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
    'flex-direction': 'column',
    'background-color': 'hsl(var(--background) / 1)',
  },
  stack2: {
    display: 'flex',
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
    'flex-direction': 'column',
  },
  stack3: {
    'margin-inline': 'auto',
    display: 'flex',
    width: '100%',
    'max-width': '48rem',
    flex: '1',
    'flex-direction': 'column',
    'justify-content': 'flex-end',
    'padding-inline': 'calc(var(--spacing) * 8)',
    'padding-bottom': 'calc(var(--spacing) * 8)',
  },
  row: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--foreground) / 1)',
    color: 'hsl(var(--background) / 1)',
  },
  caption: {
    'padding-top': 'calc(var(--spacing) * 1)',
    color: 'color-mix(in oklab, hsl(var(--foreground) / 1) 90%, transparent)',
  },
  row2: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
  },
  row3: {
    display: 'flex',
    height: '100vh',
    'min-height': 'calc(var(--spacing) * 0)',
    width: '100%',
    overflow: 'hidden',
    'background-color': 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  section: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
  frame: {
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
    'overflow-y': 'auto',
  },
  frame2: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': '64rem',
    'padding-inline': 'calc(var(--spacing) * 8)',
    'padding-block': 'calc(var(--spacing) * 6)',
  },
  row4: {
    'margin-bottom': 'calc(var(--spacing) * 5)',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  section2: {
    position: 'relative',
    'max-width': '24rem',
    flex: '1',
  },
});

const now = Date.now();
const machineId = 'machine-mac-studio' as MachineId;
const projectId = 'local-project-lody' as LocalProjectId;
const project = {
  id: projectId,
  name: 'Lody Desktop',
  rootPath: '/Users/developer/Code/Lody',
  createdAtMs: now - 86_400_000,
};

const activeProjectSessions = [
  {
    id: 'session-removal-ux' as SessionId,
    machineId,
    userId: 'user-demo',
    title: '完善移除项目的 UX',
    createdAt: '2026-08-28T08:30:00.000Z',
    lastMessageAt: now - 8 * 60_000,
    status: SessionStatusFactory.idle(),
    agentType: 'codex',
    project: { kind: 'local', localProjectId: projectId },
  },
  {
    id: 'session-cleanup' as SessionId,
    machineId,
    userId: 'user-demo',
    title: '清理本地 worktree',
    createdAt: '2026-08-27T14:20:00.000Z',
    lastMessageAt: now - 4 * 3_600_000,
    status: SessionStatusFactory.idle(),
    agentType: 'claude',
    project: { kind: 'local', localProjectId: projectId },
  },
] as SessionMeta[];

function ProjectRow({ state }: { state?: LocalProjectRemovalState }) {
  return (
    <LocalProjectItem
      machineId={machineId}
      machineName={state === 'removing' ? 'Mac Studio' : 'MacBook Pro'}
      project={project}
      canRemoveProject
      removalState={state ?? null}
      collapsed={false}
      whetherShowFullList={false}
      isSelected={false}
      sessionsForProject={activeProjectSessions}
      childSessionsByParent={new Map()}
      liveSessionStatuses={new Map()}
      formattedPath="~/Developer/Lody"
      defaultSessionTitle="未命名对话"
      selectedSessionId={null}
      removeProjectLabel="移除项目"
      archiveTooltipLabel="归档"
      archiveActionLabel="归档"
      archiveConfirmLabel="归档对话"
      isMobile={false}
      toggleLabel="展开或收起对话"
      onNavigateProject={() => {}}
      onNavigateSession={() => {}}
      onArchive={() => {}}
      collapsedOpenedBySessionIds={{}}
      onToggleOpenedBySessions={() => {}}
      onToggleCollapsed={() => {}}
      onToggleFullList={() => {}}
      onRequestRemoval={() => {}}
    />
  );
}

function DesktopSidebar({
  state,
  activeNav = 'home',
}: {
  state?: LocalProjectRemovalState;
  activeNav?: LoroSidebarNavKey;
}) {
  return (
    <LoroSidebar
      xstyle={removalStory.sidebar}
      defaultWidth={296}
      workspaceName="Lody"
      userEmail="developer@example.com"
      workspaces={[{ id: 'workspace-lody', name: 'Lody', planTier: 'plus' }]}
      currentWorkspaceId="workspace-lody"
      workspaceSwitcherEnabled
      activeNav={activeNav}
      repoSections={[]}
      chats={[]}
      topContent={
        <div {...stylex.props(storySpacing.children)}>
          <SidebarSectionHeader
            label="本地项目"
            collapsed={false}
            count={2}
            isMobile={false}
            toggleLabel="展开或收起本地项目"
            onToggleCollapsed={() => {}}
            action={
              <button type="button" {...stylex.props(removalStory.add)} aria-label="添加文件夹">
                <FolderPlus
                  {...stylex.props(storyLayoutStylesStylesStyles.frame)}
                  strokeWidth={1.8}
                />
              </button>
            }
          />
          {activeNav !== 'archive' ? <ProjectRow state={state} /> : null}
          <LocalProjectItem
            machineId={machineId}
            machineName="Mac Studio"
            project={{
              id: 'local-project-loro' as LocalProjectId,
              name: 'Loro',
              rootPath: '/Users/developer/Code/Loro',
              createdAtMs: now - 172_800_000,
            }}
            canRemoveProject
            collapsed
            whetherShowFullList={false}
            isSelected={!state}
            sessionsForProject={[]}
            childSessionsByParent={new Map()}
            liveSessionStatuses={new Map()}
            formattedPath="~/Developer/Loro"
            defaultSessionTitle="未命名对话"
            selectedSessionId={null}
            removeProjectLabel="移除项目"
            archiveTooltipLabel="归档"
            archiveActionLabel="归档"
            archiveConfirmLabel="归档对话"
            isMobile={false}
            toggleLabel="展开或收起对话"
            onNavigateProject={() => {}}
            onNavigateSession={() => {}}
            onArchive={() => {}}
            collapsedOpenedBySessionIds={{}}
            onToggleOpenedBySessions={() => {}}
            onToggleCollapsed={() => {}}
            onToggleFullList={() => {}}
            onRequestRemoval={() => {}}
          />
        </div>
      }
      onHomeClicked={() => {}}
      onArchiveClicked={() => {}}
      onSettingsClicked={() => {}}
      onRequestCollapse={() => {}}
    />
  );
}

function ProjectConversationPane() {
  return (
    <main {...stylex.props(storyLayout.stack)}>
      <header {...stylex.props(storyLayoutStyles.row)}>
        <div {...stylex.props(storyLayoutStyles.caption)}>完善移除项目的 UX</div>
      </header>
      <div {...stylex.props(storyLayout.stack2)}>
        <div {...stylex.props(storyLayout.stack3)}>
          <div {...stylex.props(storySpacing.children1)}>
            <div {...stylex.props(storyLayoutStyles.canvas)}>
              移除项目时已有对话要保留，而且设备离线时不要让项目突然消失。
            </div>
            <div {...stylex.props(storyLayoutStyles.row2)}>
              <span {...stylex.props(storyLayout.row)}>
                <Bot {...stylex.props(storyLayoutStylesStylesStyles.frame)} />
              </span>
              <p {...stylex.props(storyLayout.caption)}>
                可以。项目会留在侧栏并显示处理状态，已有对话仍然可以打开查看；设备重新上线后再完成移除。
              </p>
            </div>
          </div>
          <div {...stylex.props(storyLayoutStylesStyles.canvas)}>
            <p {...stylex.props(storyLayoutStyles.frame)}>继续讨论这个项目…</p>
            <div {...stylex.props(storyLayout.row2)}>
              <Button variant="ghost" size="small">
                <FolderPlus
                  {...stylex.props(storyLayoutStylesStylesStyles.frame)}
                  strokeWidth={1.8}
                />
                Lody Desktop
              </Button>
              <Button size="small">发送</Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function DesktopApp({ state }: { state?: LocalProjectRemovalState }) {
  return (
    <div {...stylex.props(storyLayout.row3)}>
      <DesktopSidebar state={state} />
      <ProjectConversationPane />
    </div>
  );
}

function MobileProjectHome({ waiting = false }: { waiting?: boolean }) {
  return (
    <MobileHomeScreen
      workspace={{ id: 'workspace-lody', name: 'Lody' }}
      machines={[
        { id: machineId, name: waiting ? 'MacBook Pro' : 'Mac Studio', isOnline: !waiting },
      ]}
      selectedTab="projects"
      selectedProjectsSubTab="local"
      localProjects={[
        {
          id: projectId,
          machineId,
          name: project.name,
          path: project.rootPath,
          conversationCount: 12,
          latestMessageAt: now - 8 * 60_000,
          removalState: waiting ? 'waiting_for_device' : null,
        },
        {
          id: 'local-project-loro',
          machineId,
          name: 'Loro',
          path: '/Users/developer/Code/Loro',
          conversationCount: 5,
          latestMessageAt: now - 3_600_000,
        },
      ]}
      githubRepositories={[]}
      chats={[]}
      labels={{
        projectRemovalWaiting: '设备上线后移除',
        projectRemoving: '正在移除…',
      }}
      onProjectsSubTabSelect={() => {}}
      onTabSelect={() => {}}
      onLocalProjectSelect={() => {}}
      onSettingsOpen={() => {}}
      onAddLocalProject={() => {}}
      onAddGitHubRepository={() => {}}
    />
  );
}

const archivedSessions = [
  {
    id: 'archived-session-1' as SessionId,
    machineId,
    userId: 'user-demo',
    title: 'Fix desktop reconnect behavior',
    createdAt: '2026-08-26T11:00:00.000Z',
    lastMessageAt: now - 7_200_000,
    status: SessionStatusFactory.idle(),
    isArchived: true,
    agentType: 'codex',
    project: { kind: 'local', localProjectId: projectId },
  },
  {
    id: 'archived-session-2' as SessionId,
    machineId,
    userId: 'user-demo',
    title: 'Review project removal UX',
    createdAt: '2026-08-25T08:30:00.000Z',
    lastMessageAt: now - 86_400_000,
    status: SessionStatusFactory.idle(),
    isArchived: true,
    agentType: 'claude',
    project: { kind: 'local', localProjectId: projectId },
  },
] as SessionMeta[];

const removedProjectGroup: ArchivedSessionGroup = {
  key: `local:${machineId}:${projectId}`,
  kind: 'local',
  label: project.rootPath,
  local: {
    name: project.name,
    path: project.rootPath,
    title: project.rootPath,
    available: false,
  },
  sessions: archivedSessions,
  collapsed: false,
};

function RemovedProjectArchive() {
  return (
    <div {...stylex.props(storyLayout.row3)}>
      <DesktopSidebar activeNav="archive" />
      <div {...stylex.props(storyLayout.section)}>
        <WebArchiveScreen
          archiveScope="my"
          isMultiSelectMode={false}
          selectedCount={0}
          isBulkActionBusy={false}
          onArchiveScopeChange={() => {}}
          onExitMultiSelect={() => {}}
          onBulkRestore={() => {}}
          onRequestBulkDelete={() => {}}
          dialogs={null}
        >
          <div {...stylex.props(storyLayout.frame)}>
            <div {...stylex.props(storyLayout.frame2)}>
              <div {...stylex.props(storyLayout.row4)}>
                <div {...stylex.props(storyLayout.section2)}>
                  <Search {...stylex.props(removalStory.search)} />
                  <Input
                    xstyle={storyLayoutStylesStylesStylesStyles.element}
                    placeholder="搜索归档对话"
                  />
                </div>
                <Button variant="secondary" aria-label="筛选归档对话" icon>
                  <SlidersHorizontal
                    {...stylex.props(storyLayoutStylesStylesStyles.frame)}
                    strokeWidth={1.8}
                  />
                </Button>
              </div>
              <div {...stylex.props(storyLayoutStyles.row3)}>
                <Archive {...stylex.props(storyLayoutStylesStylesStyles.frame)} />
                <span>较早</span>
              </div>
              <ArchivedSessionGroupSection
                group={removedProjectGroup}
                now={new Date(now)}
                onRestore={() => {}}
                onDelete={() => {}}
                onNavigate={() => {}}
                onToggleCollapse={() => {}}
                restoreLabel="恢复"
                restoreUnavailableLabel="重新添加此本地项目后即可恢复其中的对话。"
                removedProjectLabel="项目已移除"
                restoreActionLabel="恢复"
                deleteLabel="永久删除"
                deleteActionLabel="删除"
                chatLabel="对话"
                isMobile={false}
                isMultiSelectMode={false}
                selectedIds={new Set()}
                onToggleSelect={() => {}}
                onToggleGroupSelect={() => {}}
                onEnterMultiSelect={() => {}}
                membersByUserId={new Map()}
              />
            </div>
          </div>
        </WebArchiveScreen>
      </div>
    </div>
  );
}

function CleanupResult() {
  useEffect(() => {
    const id = 'local-project-removal-result';
    toast.warning('已从 Lody 移除“Lody Desktop”', {
      id,
      description: '已删除 1 个 worktree；另有 1 个因包含改动或清理失败而保留在磁盘上。',
      duration: Infinity,
    });
    return () => {
      toast.dismiss(id);
    };
  }, []);

  return (
    <>
      <RemovedProjectArchive />
      <Toast.Provider manager={toastManager} />
    </>
  );
}

type RemovalUxPreviewProps = {
  surface:
    | 'project-removing'
    | 'project-waiting'
    | 'mobile-project-waiting'
    | 'cleanup-result'
    | 'archive';
};

function RemovalUxPreview({ surface }: RemovalUxPreviewProps) {
  if (surface === 'mobile-project-waiting') return <MobileProjectHome waiting />;
  if (surface === 'cleanup-result') return <CleanupResult />;
  if (surface === 'archive') return <RemovedProjectArchive />;
  return <DesktopApp state={surface === 'project-waiting' ? 'waiting_for_device' : 'removing'} />;
}

const meta = {
  title: 'Projects/LocalProjectRemovalUX',
  component: RemovalUxPreview,
  parameters: { layout: 'fullscreen' },
  globals: { locale: 'zh_CN' },
} satisfies Meta<typeof RemovalUxPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProjectRemoving: Story = { args: { surface: 'project-removing' } };
export const ProjectWaitingForDevice: Story = { args: { surface: 'project-waiting' } };
export const MobileProjectWaitingForDevice: Story = {
  args: { surface: 'mobile-project-waiting' },
};
export const CleanupResultVisible: Story = { args: { surface: 'cleanup-result' } };
export const RemovedProjectInArchive: Story = { args: { surface: 'archive' } };
