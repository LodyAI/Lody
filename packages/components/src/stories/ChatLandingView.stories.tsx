import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { Bot, Github, Monitor } from 'lucide-react';
import { fn } from 'storybook/test';

import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { WorkspaceId } from '@lody/shared';

import { ChatLandingView } from '@/components/chat/chat-landing-view';
import { HomeDashboard } from '@/components/chat/home/home-dashboard';
import { useChatLandingKeyboardNav } from '@/hooks/use-chat-landing-keyboard-nav';
import { ContextSwitch } from '@/components/chat/context-switch';
import type { SessionContextType } from '@/components/chat/context-switch';
import { AcpBottomBarModeSelector, AcpFooterSelectorGroup } from '@/components/shared';
import type { OptionSelectorOption } from '@/components/shared/option-selector';
import { OptionSelector } from '@/components/shared/option-selector';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import { getPastedTextCharacterCount, type PastedTextDraft } from '@/lib/pasted-text-draft';
import {
  HOME_WEEK_NOW,
  HOME_WEEK_USAGE_SOURCES,
  homeNowFixture,
  homeWeekFixture,
  homeWeekAgentIcon,
  homeWeekAgentLabel,
  homeWeekUsageFixture,
} from './fixtures/home-week';
const sceneStyles = stylex.create({
  agentGlyph: {
    height: 'calc(var(--spacing) * 3) !important',
    width: 'calc(var(--spacing) * 3) !important',
    flexShrink: 0,
    opacity: 0.8,
  },
  repoGlyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    opacity: 0.7,
  },
  topSelector: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 1)' },
  repository: {
    height: 'calc(var(--spacing) * 6)',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius-md)',
    borderStyle: 'none',
    backgroundColor: 'transparent',
    paddingInline: 'calc(var(--spacing) * 1)',
    ':is(*) span': { fontSize: '11px', lineHeight: 'var(--leading-tight)' },
  },
  repositoryMenu: { width: 'calc(var(--spacing) * 72)' },
  machineMenu: { width: 'calc(var(--spacing) * 56)' },
  agentMenu: { width: 'calc(var(--spacing) * 64)' },
  bottomBar: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
  bottomSelectors: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
  },
  machineOption: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  machineGlyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    opacity: 0.7,
  },
  optionLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  modeSelectors: {
    marginLeft: 'auto',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    height: '100%',
    width: '100%',
  },
  canvas: {
    margin: 'calc(var(--spacing) * 3)',
    'align-self': 'flex-start',
    'border-radius': '0.25rem',
    'border-style': 'solid',
    'border-width': '1px',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 1)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
  section: {
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
});

const samplePromptPlaceholder = "Press '/' for commands, '@' for mentions.";
const sampleZhCnPromptPlaceholder = "按 '/' 使用命令，'@' 添加提及。";

const STORY_WORKSPACE_ID = 'workspace-storybook-chat-landing' as WorkspaceId;
const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'local:storybook-user', name: 'Storybook user' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      { id: STORY_WORKSPACE_ID, name: 'Storybook Workspace', slug: 'storybook', role: 'owner' },
    ],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

const meta = {
  title: 'Chat/ChatLandingView',
  component: ChatLandingView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    tone: 'dark',
    isMobile: false,
    title: "Let's ship something",
    promptValue: '',
    onPromptChange: () => {},
    promptPlaceholder: samplePromptPlaceholder,
    topSelector: null,
    footerSelector: null,
    bottomBar: null,
    onSubmit: () => {},
    hintType: null,
  },
} satisfies Meta<typeof ChatLandingView>;

export default meta;
type Story = StoryObj<typeof meta>;

const selectorStyles = stylex.create({
  tag: {
    width: 'auto',
    height: 'calc(var(--spacing) * 6)',
    paddingInline: 'calc(var(--spacing) * 2)',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 4,
    color: {
      default: 'hsl(var(--muted-foreground) / 1)',
      '@media (hover: hover)': { default: null, ':hover': 'hsl(var(--foreground) / 1)' },
    },
    backgroundColor: {
      default: colors.wellBackground,
      '@media (hover: hover)': {
        default: null,
        ':hover': 'color-mix(in oklab, hsl(var(--muted) / 1) 60%, transparent)',
      },
    },
  },
  tagText: { fontSize: '0.9em', lineHeight: 1.25 },
  machineValue: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  machineGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    opacity: 0.7,
  },
  machineLabel: {
    fontSize: '0.9em',
    lineHeight: 1.25,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

const machineOptions: OptionSelectorOption<string>[] = [
  { value: 'machine-1', label: 'Mac Studio' },
  { value: 'machine-2', label: 'MacBook Pro' },
];

const agentOptions: OptionSelectorOption<string>[] = [
  {
    value: 'agent-1',
    label: 'Aurora',
    startContent: <Bot {...stylex.props(sceneStyles.agentGlyph)} />,
  },
  {
    value: 'agent-2',
    label: 'Atlas',
    startContent: <Bot {...stylex.props(sceneStyles.agentGlyph)} />,
  },
];

const repoOptions: OptionSelectorOption<string>[] = [
  {
    value: 'loro-dev/lody',
    label: 'loro-dev/lody',
    description: 'Realtime collaboration engine',
    startContent: <Github {...stylex.props(sceneStyles.repoGlyph)} />,
  },
  {
    value: 'loro-dev/doha',
    label: 'loro-dev/doha',
    description: 'Desktop shell',
    startContent: <Github {...stylex.props(sceneStyles.repoGlyph)} />,
  },
  // Pad past the virtualization threshold (60) so the dropdown shows a search input AND
  // virtualizes its list.
  ...Array.from({ length: 120 }, (_, i) => ({
    value: `loro-dev/sample-${i + 1}`,
    label: `loro-dev/sample-${i + 1}`,
    description: 'Sample repository',
    startContent: <Github {...stylex.props(sceneStyles.repoGlyph)} />,
  })),
];

// Claude models (dynamically fetched from agent, mocked here for stories)
const claudeModelOptions: AcpSessionSelectOption[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Use the default model (currently Sonnet 4.5)',
  },
  { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 4.5 - Balanced performance and cost' },
  {
    value: 'opus',
    label: 'Opus',
    description: 'Opus 4.6 · Most capable for complex work · $5/$25 per Mtok',
  },
  {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: 'Opus 4.6 for long sessions · $10/$37.50 per Mtok',
  },
  { value: 'haiku', label: 'Haiku', description: 'Haiku 4.5 - Fastest for quick answers' },
];

// Codex models
const codexModelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.4', label: 'gpt-5.4', description: 'Latest frontier agentic coding model.' },
  {
    value: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    description: 'Smaller frontier agentic coding model.',
  },
  {
    value: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    description: 'Frontier Codex-optimized agentic coding model.',
  },
];

// Long model names with shared prefixes — the abbreviated display used to
// truncate these to identical strings, making them indistinguishable.
const longSharedPrefixModelOptions: AcpSessionSelectOption[] = [
  {
    value: 'claude-sonnet-4-6-20250514',
    label: 'claude-sonnet-4-6-20250514',
    description: 'Claude Sonnet 4.6, 2025-05-14 snapshot.',
  },
  {
    value: 'claude-sonnet-4-6-20250514-thinking',
    label: 'claude-sonnet-4-6-20250514-thinking',
    description: 'Claude Sonnet 4.6 with extended thinking enabled.',
  },
  {
    value: 'claude-sonnet-4-6-20250514-thinking-extended',
    label: 'claude-sonnet-4-6-20250514-thinking-extended',
    description: 'Claude Sonnet 4.6 with longer thinking budget.',
  },
  {
    value: 'claude-opus-4-7-20260101',
    label: 'claude-opus-4-7-20260101',
    description: 'Claude Opus 4.7, 2026-01-01 snapshot.',
  },
];

// Claude modes (dynamically fetched from agent, mocked here for stories)
const claudeModeOptions: AcpSessionSelectOption[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Standard behavior, prompts for dangerous operations',
  },
  { value: 'plan', label: 'Plan', description: 'Planning mode, no actual tool execution' },
];

const configOptionSelectors: AcpConfigOptionSelector[] = [
  {
    configId: 'reasoning_effort',
    label: 'Think level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', label: 'Low', description: 'Fast, minimal reasoning.' },
      { value: 'medium', label: 'Medium', description: 'Balanced depth and speed.' },
      { value: 'high', label: 'High', description: 'More deliberate reasoning for harder tasks.' },
    ],
  },
  {
    configId: 'fast-mode',
    label: 'Fast Mode',
    category: 'fast-mode',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
  {
    configId: 'verbosity',
    label: 'Verbosity',
    type: 'select',
    currentValue: 'balanced',
    options: [
      { value: 'concise', label: 'Concise', description: 'Shorter responses by default.' },
      { value: 'balanced', label: 'Balanced', description: 'Normal response detail.' },
      { value: 'detailed', label: 'Detailed', description: 'Show more intermediate explanation.' },
    ],
  },
];

const zhCnPastedText = [
  '[错误摘要]',
  '在切换到中文后，用户把一整段日志直接粘贴进输入框。',
  '之前的行为是整段文本全部撑开输入区域，真正的问题描述会被顶到折叠线以下。',
  '[期望]',
  '1. 输入框里只保留一段内联提示。',
  '2. 用户仍然知道自己已经粘贴了大量上下文。',
  '3. 点击这段提示后，可以看到完整内容并继续发送。',
  '[原始日志片段]',
  'RangeError: Invalid language tag: zh_CN',
  '    at new NumberFormat (<anonymous>)',
  '    at ChatLanding (chat-landing.tsx:219:27)',
  '    at renderWithHooks (react-dom-client.development.js:5529:22)',
  '    at updateFunctionComponent (react-dom-client.development.js:8897:19)',
  '补充说明：',
  '这类日志在实际使用里通常会更长，里面还会包含堆栈、请求参数、环境信息和用户自己的描述。',
].join('\n');
const zhCnPastedTextLabel = `[已粘贴 ${new Intl.NumberFormat('zh-CN').format(
  getPastedTextCharacterCount(zhCnPastedText)
)} 字符]`;
const zhCnPromptPrefix = '报错 ';
const zhCnPromptSuffix = '，看看为什么';
const zhCnPromptValue = `${zhCnPromptPrefix}${zhCnPastedTextLabel}${zhCnPromptSuffix}`;
const zhCnPastedTextDraft: PastedTextDraft = {
  id: 'pasted-zh-cn',
  text: zhCnPastedText,
  displayText: zhCnPastedTextLabel,
  start: zhCnPromptPrefix.length,
  end: zhCnPromptPrefix.length + zhCnPastedTextLabel.length,
};

interface DemoLandingProps {
  tone: 'light' | 'dark';
  isMobile?: boolean;
  hintType?: 'no-machine' | 'no-agent-config' | null;
  noMachineVariant?: 'download-client' | 'daemon-starting';
  modelOptions?: AcpSessionSelectOption[];
  defaultModel?: string;
  title?: string;
  promptPlaceholder?: string;
  initialPrompt?: string;
  initialPastedTextDrafts?: PastedTextDraft[];
  /** Mount the desktop keyboard-nav controller (arrows/Esc over the config controls). */
  enableKeyboardNav?: boolean;
}

function DemoLandingContent({
  tone,
  isMobile = false,
  hintType = null,
  noMachineVariant = 'download-client',
  modelOptions = claudeModelOptions,
  defaultModel = 'sonnet',
  title = "Let's ship something",
  promptPlaceholder = samplePromptPlaceholder,
  initialPrompt = 'Write a quick plan for the CRDT metadata cleanup.',
  initialPastedTextDrafts = [],
  enableKeyboardNav = false,
}: DemoLandingProps) {
  const navRef = useRef<HTMLDivElement>(null);
  // Landing mode: scoped to navRef, native Tab so focus can leave.
  useChatLandingKeyboardNav(navRef, { enabled: enableKeyboardNav });
  const handleSubmit = fn();
  const handleDownloadClient = fn();
  const handleReportBug = fn();
  const handleGoToAgentSettings = fn();
  const handleOpenMobileDrawer = fn();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [pastedTextDrafts, setPastedTextDrafts] =
    useState<PastedTextDraft[]>(initialPastedTextDrafts);
  const [selectedMachine, setSelectedMachine] = useState<string | null>('machine-1');
  const [selectedAgent, setSelectedAgent] = useState<string | null>('agent-1');
  const [selectedRepo, setSelectedRepo] = useState<string | null>('loro-dev/lody');
  const [selectedModel, setSelectedModel] = useState<string | null>(defaultModel);
  const [selectedMode, setSelectedMode] = useState<string | null>('default');
  const [contextType, setContextType] = useState<SessionContextType>('local');
  const [configValues, setConfigValues] = useState<Record<string, AcpConfigOptionValue>>({
    reasoning_effort: 'medium',
    'fast-mode': 'off',
    verbosity: 'balanced',
  });

  // Top selector: repo (shown above textarea)
  const topSelectorNode = (
    <div {...stylex.props(sceneStyles.topSelector)}>
      <OptionSelector
        value={selectedRepo}
        options={repoOptions}
        onSelect={(option) => setSelectedRepo(option.value)}
        placeholder="Select repo"
        placeholderIcon={Github}
        tone={tone}
        searchable
        searchPlaceholder="Search repos"
        xstyle={sceneStyles.repository}
        contentXstyle={sceneStyles.repositoryMenu}
      />
    </div>
  );

  const footerSelectorNode = (
    <AcpFooterSelectorGroup
      tone={tone}
      modelOptions={modelOptions}
      selectedModelId={selectedModel}
      onModelChange={setSelectedModel}
      configOptionSelectors={configOptionSelectors}
      configOptionValues={configValues}
      onConfigOptionChange={(configId, value) =>
        setConfigValues((prev) => ({ ...prev, [configId]: value }))
      }
    />
  );

  const bottomBarNode = (
    <div {...stylex.props(sceneStyles.bottomBar)}>
      <div {...stylex.props(sceneStyles.bottomSelectors)}>
        <OptionSelector
          value={selectedMachine}
          options={machineOptions}
          onSelect={(option) => setSelectedMachine(option.value)}
          placeholder="Machine"
          placeholderIcon={Monitor}
          tone={tone}
          xstyle={selectorStyles.tag}
          valueXstyle={selectorStyles.tagText}
          labelXstyle={selectorStyles.tagText}
          contentXstyle={sceneStyles.machineMenu}
          renderTriggerValue={(option) => (
            <div {...stylex.props(selectorStyles.machineValue)}>
              <Monitor {...stylex.props(selectorStyles.machineGlyph)} />
              <span {...stylex.props(selectorStyles.machineLabel)}>
                {option?.label ?? 'Machine'}
              </span>
            </div>
          )}
          renderOption={(option) => (
            <div {...stylex.props(sceneStyles.machineOption)}>
              <Monitor {...stylex.props(sceneStyles.machineGlyph)} />
              <span {...stylex.props(sceneStyles.optionLabel)}>{option.label}</span>
            </div>
          )}
        />
        <OptionSelector
          value={selectedAgent}
          options={agentOptions}
          onSelect={(option) => setSelectedAgent(option.value)}
          placeholder="Select agent"
          placeholderIcon={Bot}
          tone={tone}
          xstyle={selectorStyles.tag}
          valueXstyle={selectorStyles.tagText}
          labelXstyle={selectorStyles.tagText}
          contentXstyle={sceneStyles.agentMenu}
        />
      </div>
      <div {...stylex.props(sceneStyles.modeSelectors)}>
        <AcpBottomBarModeSelector
          tone={tone}
          modeOptions={claudeModeOptions}
          selectedModeId={selectedMode}
          onModeChange={setSelectedMode}
          configOptionSelectors={configOptionSelectors}
          configOptionValues={configValues}
          onConfigOptionChange={(configId, value) =>
            setConfigValues((prev) => ({ ...prev, [configId]: value }))
          }
        />
      </div>
    </div>
  );

  if (enableKeyboardNav) {
    return (
      <div {...stylex.props(storyLayout.row)}>
        {/* Stand-in for the sidebar: focus here and arrows/Tab must NOT be hijacked. */}
        <button
          type="button"
          data-testid="outside-sidebar-button"
          {...stylex.props(storyLayout.canvas)}
        >
          Sidebar item
        </button>
        <div {...stylex.props(storyLayout.section)}>
          <ChatLandingView
            tone={tone}
            isMobile={isMobile}
            navRootRef={navRef}
            title={title}
            promptValue={prompt}
            onPromptChange={setPrompt}
            promptPlaceholder={promptPlaceholder}
            pastedTextDrafts={pastedTextDrafts}
            onPastedTextDraftsChange={setPastedTextDrafts}
            topSelector={topSelectorNode}
            footerSelector={footerSelectorNode}
            contextSwitch={
              <ContextSwitch value={contextType} onChange={setContextType} tone={tone} />
            }
            bottomBar={bottomBarNode}
            onSubmit={handleSubmit}
            hintType={hintType}
            noMachineVariant={noMachineVariant}
            onDownloadClient={handleDownloadClient}
            onReportBug={handleReportBug}
            onGoToAgentSettings={handleGoToAgentSettings}
            onOpenMobileDrawer={handleOpenMobileDrawer}
          />
        </div>
      </div>
    );
  }

  return (
    <ChatLandingView
      tone={tone}
      isMobile={isMobile}
      title={title}
      ambient={
        isMobile ? undefined : (
          <HomeDashboard
            now={homeNowFixture('busy')}
            week={homeWeekFixture('busy')}
            agentLabel={homeWeekAgentLabel}
            agentIcon={homeWeekAgentIcon}
            usage={homeWeekUsageFixture()}
            usageSources={HOME_WEEK_USAGE_SOURCES}
            usageSourceId={HOME_WEEK_USAGE_SOURCES[0]!.id}
            nowMs={HOME_WEEK_NOW.getTime()}
            animate={false}
          />
        )
      }
      promptValue={prompt}
      onPromptChange={setPrompt}
      promptPlaceholder={promptPlaceholder}
      pastedTextDrafts={pastedTextDrafts}
      onPastedTextDraftsChange={setPastedTextDrafts}
      topSelector={topSelectorNode}
      footerSelector={footerSelectorNode}
      contextSwitch={<ContextSwitch value={contextType} onChange={setContextType} tone={tone} />}
      bottomBar={bottomBarNode}
      onSubmit={handleSubmit}
      hintType={hintType}
      noMachineVariant={noMachineVariant}
      onDownloadClient={handleDownloadClient}
      onReportBug={handleReportBug}
      onGoToAgentSettings={handleGoToAgentSettings}
      onOpenMobileDrawer={handleOpenMobileDrawer}
    />
  );
}

function DemoLanding(props: DemoLandingProps) {
  return (
    <PlatformContext.Provider value={storyPlatform}>
      <DemoLandingContent {...props} />
    </PlatformContext.Provider>
  );
}

export const DesktopDark: Story = {
  render: () => <DemoLanding tone="dark" />,
};

export const SubmissionPendingDark: Story = {
  args: {
    promptValue: 'This draft stays recoverable until the local writer accepts it.',
    submissionPending: true,
    submitDisabled: true,
  },
};

export const DesktopKeyboardNav: Story = {
  render: () => <DemoLanding tone="dark" initialPrompt="" enableKeyboardNav />,
};

export const DesktopLight: Story = {
  render: () => <DemoLanding tone="light" />,
};

export const MobileDark: Story = {
  render: () => <DemoLanding tone="dark" isMobile />,
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

export const MobileLight: Story = {
  render: () => <DemoLanding tone="light" isMobile />,
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

export const NoMachineDownloadClientHint: Story = {
  render: () => (
    <DemoLanding tone="dark" hintType="no-machine" noMachineVariant="download-client" />
  ),
};

export const NoMachineDaemonStartingHint: Story = {
  render: () => (
    <DemoLanding tone="dark" hintType="no-machine" noMachineVariant="daemon-starting" />
  ),
};

export const NoAgentConfigHint: Story = {
  render: () => <DemoLanding tone="dark" hintType="no-agent-config" />,
};

export const LongModelNames: Story = {
  render: () => <DemoLanding tone="dark" modelOptions={codexModelOptions} defaultModel="gpt-5.4" />,
};

export const LongSharedPrefixModelNames: Story = {
  render: () => (
    <DemoLanding
      tone="dark"
      modelOptions={longSharedPrefixModelOptions}
      defaultModel="claude-sonnet-4-6-20250514-thinking-extended"
    />
  ),
};

export const DesktopDarkZhCnWithPastedText: Story = {
  render: () => (
    <DemoLanding
      tone="dark"
      title="和你的 agent 对话"
      promptPlaceholder={sampleZhCnPromptPlaceholder}
      initialPrompt={zhCnPromptValue}
      initialPastedTextDrafts={[zhCnPastedTextDraft]}
    />
  ),
  globals: {
    theme: 'dark',
    locale: 'zh_CN',
  },
};
