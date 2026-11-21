import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ChevronRight, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorktreeSetupScriptConfig, WorktreeSetupShell } from '@lody/shared';

import {
  MobileProjectScreen,
  type MobileConversationItem,
  type MobileProjectContext,
} from '@/components/mobile/mobile-project-screen';
import { useMobileBackRevealClass } from '@/components/mobile/mobile-drill-page-layout';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { MobileWorktreeConfigSheet } from '@/components/mobile/mobile-worktree-config-sheet';

const meta = {
  title: 'Mobile/MobileProjectScreen',
  component: MobileProjectScreen,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof MobileProjectScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const githubProject: MobileProjectContext = {
  kind: 'github',
  fullName: 'loro-dev/lody',
  name: 'lody',
  ownerHandle: 'loro-dev',
  avatarUrl: 'https://avatars.githubusercontent.com/loro-dev?size=80',
};

const localProject: MobileProjectContext = {
  kind: 'local',
  machineId: 'zx-macbook',
  projectId: 'zx-macbook:lody',
  name: 'lody',
  path: '~/code/lody',
};

const conversations: MobileConversationItem[] = [
  {
    id: 'pr-154',
    title: '重构部分评估 UI',
    branchName: 'feat/eval-ui-overhaul',
    prNumber: 154,
    prStatus: 'open',
    prUrl: 'https://github.com/loro-dev/lody/pull/154',
    prCiState: 'p',
    addedLines: 156,
    deletedLines: 8,
    ageLabel: '1h',
    isWorking: true,
    machineId: 'zx-macbook',
  },
  {
    id: 'pr-149',
    title: 'PR 看板对齐 + drag-handle',
    branchName: 'fix/board-alignment',
    prNumber: 149,
    prStatus: 'merged',
    prUrl: 'https://github.com/loro-dev/lody/pull/149',
    prCiState: 's',
    addedLines: 42,
    deletedLines: 10,
    ageLabel: '5h',
    machineId: 'zx-macbook',
  },
  {
    id: 'pr-152',
    title: '合并就绪：等待点合并',
    branchName: 'feat/ready-to-merge',
    prNumber: 152,
    prStatus: 'open',
    prUrl: 'https://github.com/loro-dev/lody/pull/152',
    prCiState: 's',
    prReadiness: 'y',
    addedLines: 88,
    deletedLines: 21,
    ageLabel: '2h',
    machineId: 'zx-macbook',
  },
  {
    id: 'session-3',
    title: '同步进度与未读提示',
    branchName: 'feat/sync-progress',
    ageLabel: '1d',
    hasUnreadMessages: true,
    machineId: 'lab-m2',
  },
  {
    id: 'session-4',
    title: '权限审批弹窗布局',
    branchName: 'fix/permission-modal',
    isWaitingPermission: true,
    ageLabel: '2d',
    machineId: 'zx-macbook',
  },
];

/* Mock of the production Settings-tab content (`MobileLocalProjectSettings` /
   `MobileGithubProjectSettings`) so the story can exercise the two-level flow
   without convex providers: a single "Worktree setup & cleanup" row that opens
   the production `MobileWorktreeConfigSheet`. */
function MockWorktreeSettings({ shell }: { shell?: WorktreeSetupShell }) {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<WorktreeSetupScriptConfig>({
    scripts: { bash: 'cp .env.example .env\npnpm install', powershell: 'pnpm install' },
  });
  const [cleanup, setCleanup] = useState<WorktreeSetupScriptConfig>({
    scripts: { bash: 'rm -rf node_modules' },
  });
  return (
    <>
      <MobileSettingsSection title="Worktree">
        <MobileSettingsRow
          label={
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Wrench className="h-[1.05rem] w-[1.05rem]" />
              </div>
              <span className="truncate text-[0.95rem] font-medium leading-tight">
                Worktree setup &amp; cleanup
              </span>
            </div>
          }
          onClick={() => setOpen(true)}
          trailing={<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
        />
      </MobileSettingsSection>
      <MobileWorktreeConfigSheet
        open={open}
        onOpenChange={setOpen}
        shell={shell}
        setupConfig={setup}
        cleanupConfig={cleanup}
        onSetupSave={(config) => setSetup(config)}
        onCleanupSave={(config) => setCleanup(config)}
      />
    </>
  );
}

function ProjectFilesStoryContent() {
  return (
    <div className="mx-3 mt-3 rounded-2xl border border-border/40 bg-card p-4">
      <div className="text-sm font-semibold text-foreground">文件浏览</div>
      <div className="mt-1 text-xs text-muted-foreground">项目文件树和预览区域</div>
      <div className="mt-4 space-y-2 text-sm">
        <div className="rounded-xl bg-muted/60 px-3 py-2 font-mono text-xs">
          apps/mobile/src/main.tsx
        </div>
        <div className="rounded-xl bg-muted/60 px-3 py-2 font-mono text-xs">
          packages/components/src/components/chat/chat-landing.tsx
        </div>
        <div className="rounded-xl bg-muted/60 px-3 py-2 font-mono text-xs">
          packages/shared/src/message.ts
        </div>
      </div>
    </div>
  );
}

function StoryShell({ project }: { project: MobileProjectContext }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <MobileProjectScreen
          project={project}
          conversations={conversations}
          labels={{
            backAriaLabel: '返回',
            emptyConversations: '没有匹配的对话',
            settingsTab: '设置',
          }}
          filesTabContent={<ProjectFilesStoryContent />}
          settingsTabContent={
            <MockWorktreeSettings shell={project.kind === 'local' ? 'bash' : undefined} />
          }
          onBack={fn()}
          onConversationSelect={fn()}
        />
      </div>
    </div>
  );
}

export const IOSGitHub: Story = {
  args: {
    project: githubProject,
    conversations,
    filesTabContent: <ProjectFilesStoryContent />,
    onBack: fn(),
  },
  render: () => <StoryShell project={githubProject} />,
};

export const IOSLocal: Story = {
  args: {
    project: localProject,
    conversations,
    filesTabContent: <ProjectFilesStoryContent />,
    onBack: fn(),
  },
  render: () => <StoryShell project={localProject} />,
};

/* Home ⇄ project in one slot, as in `MobileWorkspaceLayout`: Back slides the
   project off while the list underneath, a stand-in for the home Projects
   tab, mounts with the same reveal `MobileHomeScreen` plays. */
function StandInProjectsHome({ onOpen }: { onOpen: (project: MobileProjectContext) => void }) {
  const backRevealClass = useMobileBackRevealClass();
  return (
    <div
      data-testid="stand-in-home"
      className={cn('safe-areas flex h-full flex-col bg-background', backRevealClass)}
    >
      <h1 className="pt-safe-4 px-4 pb-3 text-2xl font-semibold">项目</h1>
      {[localProject, githubProject].map((item) => (
        <button
          key={item.kind}
          type="button"
          onClick={() => onOpen(item)}
          className="mx-3 mb-2 flex items-center justify-between rounded-xl bg-card px-4 py-3 text-left"
        >
          <span>
            <span className="block text-sm font-medium">{item.name}</span>
            <span className="block text-xs text-muted-foreground">
              {item.kind === 'local' ? item.path : item.fullName}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function BackToHomeShell() {
  const [project, setProject] = useState<MobileProjectContext | null>(null);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="relative h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        {project ? (
          <MobileProjectScreen
            key={project.kind}
            project={project}
            conversations={conversations}
            labels={{ backAriaLabel: '返回', emptyConversations: '没有匹配的对话' }}
            filesTabContent={<ProjectFilesStoryContent />}
            onBack={() => setProject(null)}
            onConversationSelect={fn()}
          />
        ) : (
          <StandInProjectsHome onOpen={setProject} />
        )}
      </div>
    </div>
  );
}

export const BackToHome: Story = {
  args: {
    project: localProject,
    conversations,
    filesTabContent: <ProjectFilesStoryContent />,
    onBack: fn(),
  },
  render: () => <BackToHomeShell />,
};
