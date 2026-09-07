import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { Archive, Bot, FolderPlus, Search, SlidersHorizontal } from 'lucide-react';
import type { LocalProjectId, MachineId, SessionId, SessionMeta } from '@lody/shared';
import { SessionStatusFactory } from '@lody/shared';
import { toast } from 'sonner';

import {
  ArchivedSessionGroupSection,
  type ArchivedSessionGroup,
} from '@/components/archive/archive-view';
import { WebArchiveScreen } from '@/components/archive/web-archive-screen';
import {
  LocalProjectItem,
  RemoveLocalProjectDialog,
  type LocalProjectRemovalState,
} from '@/components/loro-app-sidebar';
import { LoroSidebar, type LoroSidebarNavKey } from '@/components/loro-sidebar';
import { MobileHomeScreen } from '@/components/mobile/mobile-home-screen';
import { MobileRemoveLocalProjectSheet } from '@/components/mobile/mobile-remove-local-project-sheet';
import { SidebarSectionHeader } from '@/components/sidebar-row-shared';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Toaster } from '@/ui/sonner';

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
      canNavigateProject
      removalState={state ?? null}
      collapsed={false}
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
      className="h-full shrink-0"
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
        <div className="mb-3 space-y-0.5">
          <SidebarSectionHeader
            label="本地项目"
            collapsed={false}
            count={2}
            isMobile={false}
            toggleLabel="展开或收起本地项目"
            onToggleCollapsed={() => {}}
            action={
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground"
                aria-label="添加文件夹"
              >
                <FolderPlus className="h-4 w-4" />
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
            canNavigateProject
            collapsed
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
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <div className="truncate text-sm font-medium">完善移除项目的 UX</div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end px-8 pb-8">
          <div className="mb-8 space-y-6">
            <div className="ml-auto max-w-[72%] rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed">
              移除项目时已有对话要保留，而且设备离线时不要让项目突然消失。
            </div>
            <div className="flex max-w-[78%] gap-3 text-sm leading-relaxed">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
                <Bot className="h-4 w-4" />
              </span>
              <p className="pt-1 text-foreground/90">
                可以。项目会留在侧栏并显示处理状态，已有对话仍然可以打开查看；设备重新上线后再完成移除。
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
            <p className="min-h-12 text-sm text-muted-foreground">继续讨论这个项目…</p>
            <div className="mt-2 flex items-center justify-between">
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                <FolderPlus className="h-4 w-4" />
                Lody Desktop
              </Button>
              <Button size="sm">发送</Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function DesktopApp({ state }: { state?: LocalProjectRemovalState }) {
  return (
    <div className="flex h-screen min-h-0 w-full overflow-hidden bg-background text-foreground">
      <DesktopSidebar state={state} />
      <ProjectConversationPane />
    </div>
  );
}

function DesktopConfirmation() {
  const [open, setOpen] = useState(true);
  return (
    <div className="relative h-screen">
      <DesktopApp />
      <RemoveLocalProjectDialog
        open={open}
        target={{
          machineId,
          localProjectId: projectId,
          name: project.name,
          pathLabel: project.rootPath,
          conversationCount: 12,
          runningSessionCount: 2,
        }}
        isRemote
        machineName="MacBook Pro"
        deviceOnline
        canCleanupWorktrees
        isRemoving={false}
        onOpenChange={setOpen}
        onPreflightCleanup={async () => ({
          clean: [
            {
              sessionId: 'session-clean' as SessionId,
              title: '完善移除项目的 UX',
              path: '/tmp/session-clean',
            },
          ],
          dirty: [
            {
              sessionId: 'session-dirty' as SessionId,
              title: '清理本地 worktree',
              path: '/tmp/session-dirty',
            },
          ],
          failed: [],
        })}
        onConfirm={() => {}}
      />
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

function MobileConfirmation() {
  const [open, setOpen] = useState(true);
  return (
    <div className="h-dvh overflow-hidden bg-background">
      <MobileProjectHome />
      <MobileRemoveLocalProjectSheet
        open={open}
        onOpenChange={setOpen}
        projectName={project.name}
        pathLabel={project.rootPath}
        deviceName="MacBook Pro"
        deviceOnline
        conversationCount={12}
        runningSessionCount={2}
        canCleanupWorktrees
        onPreflightCleanup={async () => ({
          clean: [
            {
              sessionId: 'session-clean' as SessionId,
              title: '完善移除项目的 UX',
              path: '/tmp/session-clean',
            },
          ],
          dirty: [
            {
              sessionId: 'session-dirty' as SessionId,
              title: '清理本地 worktree',
              path: '/tmp/session-dirty',
            },
          ],
          failed: [],
        })}
        onConfirm={async () => true}
      />
    </div>
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
    <div className="flex h-screen min-h-0 w-full overflow-hidden bg-background text-foreground">
      <DesktopSidebar activeNav="archive" />
      <div className="min-w-0 flex-1">
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
          <div className="mx-auto w-full max-w-5xl px-8 py-6">
            <div className="mb-5 flex items-center gap-2">
              <div className="relative max-w-sm flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-9" placeholder="搜索归档对话" />
              </div>
              <Button variant="outline" size="icon" aria-label="筛选归档对话">
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            </div>
            <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Archive className="h-4 w-4" />
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
      <Toaster />
    </>
  );
}

type RemovalUxPreviewProps = {
  surface:
    | 'project-removing'
    | 'project-waiting'
    | 'desktop-confirmation'
    | 'mobile-project-waiting'
    | 'mobile-confirmation'
    | 'cleanup-result'
    | 'archive';
};

function RemovalUxPreview({ surface }: RemovalUxPreviewProps) {
  if (surface === 'desktop-confirmation') return <DesktopConfirmation />;
  if (surface === 'mobile-project-waiting') return <MobileProjectHome waiting />;
  if (surface === 'mobile-confirmation') return <MobileConfirmation />;
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
export const DesktopRemoveConfirmation: Story = { args: { surface: 'desktop-confirmation' } };
export const MobileProjectWaitingForDevice: Story = {
  args: { surface: 'mobile-project-waiting' },
};
export const MobileRemoveConfirmation: Story = { args: { surface: 'mobile-confirmation' } };
export const CleanupResultVisible: Story = { args: { surface: 'cleanup-result' } };
export const RemovedProjectInArchive: Story = { args: { surface: 'archive' } };
