import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { Bot, Github, Monitor } from 'lucide-react';
import { fn } from 'storybook/test';

import { ChatLandingView } from '@/components/chat/chat-landing-view';
import { useChatLandingKeyboardNav } from '@/hooks/use-chat-landing-keyboard-nav';
import { ContextSwitch } from '@/components/chat/context-switch';
import type { SessionContextType } from '@/components/chat/context-switch';
import { getSelectorTagClassName } from '@/components/chat/chat-landing-selectors';
import { AcpBottomBarModeSelector, AcpFooterSelectorGroup } from '@/components/shared';
import type { OptionSelectorOption } from '@/components/shared/option-selector';
import { OptionSelector } from '@/components/shared/option-selector';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import { getPastedTextCharacterCount, type PastedTextDraft } from '@/lib/pasted-text-draft';

const samplePromptPlaceholder = "Press '/' for commands, '@' for mentions.";
const sampleZhCnPromptPlaceholder = "按 '/' 使用命令，'@' 添加提及。";

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

const machineOptions: OptionSelectorOption<string>[] = [
  { value: 'machine-1', label: 'Mac Studio' },
  { value: 'machine-2', label: 'MacBook Pro' },
];

const agentOptions: OptionSelectorOption<string>[] = [
  {
    value: 'agent-1',
    label: 'Aurora',
    startContent: <Bot className="h-3! w-3! shrink-0 opacity-80" />,
  },
  {
    value: 'agent-2',
    label: 'Atlas',
    startContent: <Bot className="h-3! w-3! shrink-0 opacity-80" />,
  },
];

const repoOptions: OptionSelectorOption<string>[] = [
  {
    value: 'loro-dev/lody',
    label: 'loro-dev/lody',
    description: 'Realtime collaboration engine',
    startContent: <Github className="h-4 w-4 opacity-70" />,
  },
  {
    value: 'loro-dev/doha',
    label: 'loro-dev/doha',
    description: 'Desktop shell',
    startContent: <Github className="h-4 w-4 opacity-70" />,
  },
  // Pad past the virtualization threshold (60) so the dropdown shows a search input AND
  // virtualizes its list.
  ...Array.from({ length: 120 }, (_, i) => ({
    value: `loro-dev/sample-${i + 1}`,
    label: `loro-dev/sample-${i + 1}`,
    description: 'Sample repository',
    startContent: <Github className="h-4 w-4 opacity-70" />,
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

function DemoLanding({
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

  const selectorTagClassName = getSelectorTagClassName(tone);

  // Top selector: repo (shown above textarea)
  const topSelectorNode = (
    <div className="flex items-center gap-1">
      <OptionSelector
        value={selectedRepo}
        options={repoOptions}
        onSelect={(option) => setSelectedRepo(option.value)}
        placeholder="Select repo"
        placeholderIcon={Github}
        tone={tone}
        searchable
        searchPlaceholder="Search repos"
        className="h-6 gap-1 rounded-md border-none bg-transparent px-1 [&_span]:text-[11px] [&_span]:leading-tight"
        contentClassName="w-72"
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
    <div className="flex w-full items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex shrink-0 items-center gap-1">
        <OptionSelector
          value={selectedMachine}
          options={machineOptions}
          onSelect={(option) => setSelectedMachine(option.value)}
          placeholder="Machine"
          placeholderIcon={Monitor}
          tone={tone}
          className={selectorTagClassName}
          contentClassName="w-56"
          renderTriggerValue={(option) => (
            <div className="flex min-w-0 items-center gap-1.5">
              <Monitor className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span className="truncate text-sm font-medium">{option?.label ?? 'Machine'}</span>
            </div>
          )}
          renderOption={(option) => (
            <div className="flex min-w-0 items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0 opacity-70" />
              <span className="truncate text-sm">{option.label}</span>
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
          className={selectorTagClassName}
          contentClassName="w-64"
        />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
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
      <div className="flex h-full w-full">
        {/* Stand-in for the sidebar: focus here and arrows/Tab must NOT be hijacked. */}
        <button
          type="button"
          data-testid="outside-sidebar-button"
          className="m-3 self-start rounded border px-3 py-1 text-sm"
        >
          Sidebar item
        </button>
        <div className="min-w-0 flex-1">
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
