import { useState, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { ChevronRight, Wrench } from 'lucide-react';
import type { WorktreeSetupScriptConfig, WorktreeSetupShell } from '@lody/shared';

import {
  MobileProjectScreen,
  type MobileConversationItem,
  type MobileProjectContext,
} from '@/components/mobile/mobile-project-screen';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { MobileWorktreeConfigSheet } from '@/components/mobile/mobile-worktree-config-sheet';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../style/theme-colors.stylex';
const fileStory = stylex.create({
  list: {
    marginTop: 'calc(var(--spacing) * 4)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 2)',
    },
  },
  file: {
    borderRadius: 'var(--radius-xl)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--muted) / 1) 60%,transparent)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
});
const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
  },
});

const storyLayoutStylesStyles = stylex.create({
  frame: {
    height: '1.05rem',
    width: '1.05rem',
  },
  frame2: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 60%, transparent)',
  },
});

const storyViewport = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    '--story-device-canvas-components': '92.3% 0.003 48.717',
    backgroundColor: 'oklch(var(--story-device-canvas-components))',
    padding: { default: '0px', '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
});

const storyLayoutStyles = stylex.create({
  label: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': '0.95rem',
    'line-height': 'var(--leading-tight)',
    'font-weight': 'var(--font-weight-medium)',
  },
  canvas: {
    'margin-inline': 'calc(var(--spacing) * 3)',
    'margin-top': 'calc(var(--spacing) * 3)',
    'border-radius': 'var(--radius-2xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 40%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
  caption: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'hsl(var(--foreground) / 1)',
  },
  caption2: {
    'margin-top': 'calc(var(--spacing) * 1)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-width': 'calc(var(--spacing) * 0)',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
  },
  row2: {
    display: 'flex',
    height: 'calc(var(--spacing) * 9)',
    width: 'calc(var(--spacing) * 9)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-xl)',
    'background-color': 'color-mix(in oklab, hsl(var(--primary)) 10%, transparent)',
    color: 'hsl(var(--primary))',
  },
});

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
            <div {...stylex.props(storyLayout.row)}>
              <div {...stylex.props(storyLayout.row2)}>
                <Wrench {...stylex.props(storyLayoutStylesStyles.frame)} />
              </div>
              <span {...stylex.props(storyLayoutStyles.label)}>Worktree setup &amp; cleanup</span>
            </div>
          }
          onClick={() => setOpen(true)}
          trailing={<ChevronRight {...stylex.props(storyLayoutStylesStyles.frame2)} />}
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
    <div {...stylex.props(storyLayoutStyles.canvas)}>
      <div {...stylex.props(storyLayoutStyles.caption)}>文件浏览</div>
      <div {...stylex.props(storyLayoutStyles.caption2)}>项目文件树和预览区域</div>
      <div {...stylex.props(fileStory.list)}>
        <div {...stylex.props(fileStory.file)}>apps/mobile/src/main.tsx</div>
        <div {...stylex.props(fileStory.file)}>
          packages/components/src/components/chat/chat-landing.tsx
        </div>
        <div {...stylex.props(fileStory.file)}>packages/shared/src/message.ts</div>
      </div>
    </div>
  );
}

function StoryShell({ project }: { project: MobileProjectContext }) {
  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <MobileProjectScreen
          project={project}
          conversations={conversations}
          labels={{
            backAriaLabel: '返回',
            allConversationsHeading: '全部对话',
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

const ownedStyles = stylex.create({
  frame: { maxWidth: 440, backgroundColor: themeColors.background },
  screen: { width: '100%', height: 'calc(100dvh - 104px)', minHeight: 400, overflow: 'hidden' },
  scopeControls: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 8 },
  result: { display: 'block', padding: 8, fontSize: 12, color: themeColors.mutedForeground },
});

const ownedConversations: MobileConversationItem[] = [
  {
    id: 'alpha',
    title: 'Alpha: preserve project controls',
    branchName: 'fix/alpha',
    ageLabel: '1h',
  },
  { id: 'beta', title: 'Beta: review keyboard behavior', branchName: 'fix/beta', ageLabel: '2h' },
  {
    id: 'long',
    title: 'Long project conversation title preserves truncation at narrow widths',
    ageLabel: '3h',
  },
];

function OwnedProjectFixture({ scoped = false }: { scoped?: boolean }) {
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState('all');
  const [backCount, setBackCount] = useState(0);
  const [scope, setScope] = useState(0);
  const scopeNames = ['dark-scope', 'light-scope', 'nested-light-exclusion'];
  const outerScope = scoped ? (scope === 0 ? 'dark-scope' : 'light-scope') : undefined;
  return (
    <div
      {...stylex.props(ownedStyles.frame)}
      data-owned-project-fixture
      data-owned-project-back-count={backCount}
      data-owned-project-filter={filter}
      data-owned-project-archived={archived}
      data-owned-project-scope={scoped ? scopeNames[scope] : undefined}
    >
      {scoped ? (
        <div {...stylex.props(ownedStyles.scopeControls)}>
          <Button size="small" onClick={() => setScope((current) => (current + 1) % 3)}>
            Change local theme scope
          </Button>
          <output>{scopeNames[scope]}</output>
        </div>
      ) : null}
      <div
        className={outerScope}
        style={scoped ? ({ '--color-white': '#ffdfc4' } as CSSProperties) : undefined}
      >
        <div
          {...withClassName(
            stylex.props(ownedStyles.screen),
            scoped && scope === 2 ? 'dark-scope' : undefined
          )}
        >
          <MobileProjectScreen
            project={localProject}
            conversations={filter === 'alpha' ? ownedConversations.slice(0, 1) : ownedConversations}
            filterPills={[
              {
                kind: 'single',
                id: 'view',
                fallbackLabel: 'Messages',
                options: [
                  { id: 'all', label: 'All messages' },
                  { id: 'alpha', label: 'Alpha only' },
                ],
                selectedId: filter,
                onSelect: setFilter,
              },
            ]}
            labels={{
              backAriaLabel: 'Back to projects',
              archiveToggleLabel: 'Archived conversations',
              filterBarToggleLabel: 'Show project filters',
              searchAriaLabel: 'Search conversations',
              searchPlaceholder: 'Search conversations',
              clearSearchAriaLabel: 'Clear project search',
              emptyConversations: 'No matching conversations',
              archivedConversationsHeading: 'Archived chats',
              chatTab: 'Chat',
              filesTab: 'Files',
              settingsTab: 'Settings',
            }}
            filesTabContent={null}
            onBack={() => setBackCount((count) => count + 1)}
            onConversationSelect={fn()}
            showArchived={archived}
            onShowArchivedToggle={() => setArchived((current) => !current)}
          />
        </div>
      </div>
      <output {...stylex.props(ownedStyles.result)}>
        Back {backCount}; filter {filter}; archived {String(archived)}
      </output>
    </div>
  );
}

type OwnedProjectStory = StoryObj<typeof OwnedProjectFixture>;

export const OwnedControls: OwnedProjectStory = { render: () => <OwnedProjectFixture /> };
export const OwnedScopes: OwnedProjectStory = { render: () => <OwnedProjectFixture scoped /> };
