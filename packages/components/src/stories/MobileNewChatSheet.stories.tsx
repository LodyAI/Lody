import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  ArrowUp,
  Folder,
  GitBranch,
  Github,
  MessageCircle,
  Monitor,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { MobileNewChatSheet } from '@/components/mobile/mobile-new-chat-sheet';
import {
  MobileInlinePicker,
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';
import {
  MobileModelPickerLabel,
  mobileModelPickerTriggerStyle,
} from '@/components/mobile/mobile-session-composer-footer';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
import type { AcpConfigOptionValue } from '@/components/shared/acp-selector-options';
import { Tabs } from '@lody/ui/tabs';

const styles = stylex.create({
  glyph: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
  pickerGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    opacity: 0.7,
  },
  sendGlyph: { width: 'calc(var(--spacing) * 5)', height: 'calc(var(--spacing) * 5)' },
  fullWidth: { width: '100%' },
  tabsList: {
    display: 'flex',
    height: 'calc(var(--spacing) * 10)',
    width: '100%',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--muted) / 1)',
    padding: 'calc(var(--spacing) * 1)',
  },
  tab: {
    flex: '1 1 0%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 'calc(var(--spacing) * 1.5)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    transitionProperty: 'all',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  muted: { color: 'hsl(var(--muted-foreground) / 1)' },
  selectedTab: {
    backgroundColor: 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
    boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  composer: {
    borderRadius: 'var(--radius-2xl)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--input-border) / 1) 70%, transparent)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--input) / 1) 90%, transparent)',
    padding: 'calc(var(--spacing) * 3)',
  },
  input: {
    width: '100%',
    resize: 'none',
    backgroundColor: 'transparent',
    fontSize: 'var(--text-sm)',
    lineHeight: 'calc(var(--spacing) * 6)',
    color: {
      default: 'hsl(var(--input-foreground) / 1)',
      '::placeholder': 'hsl(var(--input-placeholder) / 1)',
    },
    ':focus': { outlineStyle: 'none' },
  },
  footer: { display: 'flex', alignItems: 'center', paddingTop: 'calc(var(--spacing) * 1)' },
  footerFill: { display: 'flex', minWidth: 0, flex: '1 1 0%', alignItems: 'center' },
  configRow: { display: 'flex', width: '100%', minWidth: 0, alignItems: 'center' },
  minWidth: { minWidth: 0 },
  thinkingBox: { marginLeft: 'calc(var(--spacing) * 1)', flexShrink: 0 },
  thinkingTrigger: {
    height: 'calc(var(--spacing) * 8)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  send: { marginLeft: 'calc(var(--spacing) * 2)', flexShrink: 0 },
  frame: {
    position: 'relative',
    height: '956px',
    width: '100%',
    backgroundColor: 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  openRow: { display: 'flex', height: '100%', alignItems: 'flex-end', justifyContent: 'center' },
  openButton: { marginBottom: 'calc(var(--spacing) * 6)' },
  pickerRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  pickerFill: { minWidth: 0, flex: '1 1 0%' },
  trailingPicker: { marginLeft: 'auto', minWidth: 0 },
});

const meta = {
  title: 'Mobile/MobileNewChatSheet',
  component: MobileNewChatSheet,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof MobileNewChatSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

/* The story wires real `MobileInlinePicker`s for the row chips so the
   drawer-from-behind animation, single-open coordination, and trigger
   styling are screenshot-verifiable. Composer-internal chips (model /
   thinking) still need a real `ChatComposer` to test fully; the mock
   composer here renders just the picker triggers so we can see them
   inline in the footer row. */

const machineOptions: MobileInlinePickerOption[] = [
  { value: 'zx-macbook', label: 'zx-macbook', icon: <Monitor {...stylex.props(styles.glyph)} /> },
  { value: 'lab-m2', label: 'lab-m2', icon: <Monitor {...stylex.props(styles.glyph)} /> },
];

const githubRepoOptions: MobileInlinePickerOption[] = [
  {
    value: 'loro-dev/lody',
    label: 'loro-dev/lody',
    description: 'AI-native local-first coding companion',
    icon: <Github {...stylex.props(styles.glyph)} />,
  },
  {
    value: 'loro-dev/loro',
    label: 'loro-dev/loro',
    description: 'High-performance CRDT framework',
    icon: <Github {...stylex.props(styles.glyph)} />,
  },
];

const localProjectOptions: MobileInlinePickerOption[] = [
  {
    value: 'zx-macbook:lody',
    label: 'lody',
    description: '~/code/lody',
    icon: <Folder {...stylex.props(styles.glyph)} />,
  },
];

const branchOptions: MobileInlinePickerOption[] = [
  { value: 'main', label: 'main', icon: <GitBranch {...stylex.props(styles.glyph)} /> },
  {
    value: 'feat/audit-mobile-coupling',
    label: 'feat/audit-mobile-coupling',
    icon: <GitBranch {...stylex.props(styles.glyph)} />,
  },
];

const modelOptions: MobileInlinePickerOption[] = [
  { value: 'claude-3.5-sonnet', label: 'claude-3.5-sonnet', description: 'Fast & balanced' },
  { value: 'claude-opus-4', label: 'claude-opus-4', description: 'Highest quality' },
];

const longModelName = 'MiniMax Token Plan (minimaxi.com)/MiniMax-M3';
const longModelOptions: MobileInlinePickerOption[] = [
  { value: longModelName, label: longModelName, description: 'Long provider display name' },
  ...modelOptions,
];

const thinkingOptions: MobileInlinePickerOption[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

const agentOptions: MobileInlinePickerOption[] = [
  {
    value: 'claude-code',
    label: 'Claude Code',
    icon: <Sparkles {...stylex.props(styles.glyph)} />,
  },
  { value: 'codex', label: 'Codex', icon: <Sparkles {...stylex.props(styles.glyph)} /> },
];

const permissionOptions: MobileInlinePickerOption[] = [
  {
    value: 'askPermission',
    label: 'Ask permission',
    icon: <ShieldCheck {...stylex.props(styles.glyph)} />,
  },
];

function MockContextTypeNode({
  value,
  onChange,
}: {
  value: 'local' | 'github' | 'chat';
  onChange: (next: 'local' | 'github' | 'chat') => void;
}) {
  return (
    <Tabs.Root
      value={value}
      onValueChange={(v) => onChange(v as 'local' | 'github' | 'chat')}
      xstyle={styles.fullWidth}
    >
      <Tabs.List xstyle={styles.tabsList}>
        <Tabs.Tab value="local" xstyle={[styles.tab, styles.muted]}>
          <Folder {...stylex.props(styles.glyph)} />
          <span>Local</span>
        </Tabs.Tab>
        <Tabs.Tab value="github" xstyle={[styles.tab, styles.muted]}>
          <Github {...stylex.props(styles.glyph)} />
          <span>GitHub</span>
        </Tabs.Tab>
        <Tabs.Tab value="chat" xstyle={[styles.tab, styles.muted]}>
          <MessageCircle {...stylex.props(styles.glyph)} />
          <span>Chat</span>
        </Tabs.Tab>
      </Tabs.List>
    </Tabs.Root>
  );
}

function MockWorkdirModeNode({ contextType }: { contextType: 'local' | 'github' | 'chat' }) {
  if (contextType !== 'local') return null;
  return (
    <div {...stylex.props(styles.tabsList)}>
      <button type="button" {...stylex.props(styles.tab, styles.muted)}>
        <Folder {...stylex.props(styles.glyph)} />
        <span>本地文件</span>
      </button>
      <button type="button" {...stylex.props(styles.tab, styles.selectedTab)}>
        <GitBranch {...stylex.props(styles.glyph)} />
        <span>新工作树</span>
      </button>
    </div>
  );
}

function MockComposer({
  configOptionValues: _configOptionValues,
  onConfigOptionChange: _onConfigOptionChange,
  selectedModel,
  setSelectedModel,
  modelPickerOptions = modelOptions,
  selectedThinking,
  setSelectedThinking,
}: {
  configOptionValues: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange: (configId: string, value: AcpConfigOptionValue) => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  modelPickerOptions?: MobileInlinePickerOption[];
  selectedThinking: string;
  setSelectedThinking: (v: string) => void;
}) {
  return (
    <MobileInlinePickerRowSlot>
      <div {...stylex.props(styles.composer)}>
        <textarea
          rows={2}
          placeholder="描述你的需求。"
          {...withClassName(stylex.props(styles.input), 'input-scrollbar')}
        />
        {/* Mirrors the real composer footer: the configOptions cluster
            fills the row (`w-full` inside the `flex-1` wrapper) so each
            config shows in full, and only the model shrinks/truncates
            (keeping its tail) once the row is too narrow — thinking is
            pinned `shrink-0`. The send button sits at the far right. */}
        <div {...stylex.props(styles.footer)}>
          <div {...stylex.props(styles.footerFill)}>
            <div {...stylex.props(styles.configRow)}>
              <div {...stylex.props(styles.minWidth)}>
                <MobileInlinePicker
                  id="story-model"
                  value={selectedModel}
                  onChange={setSelectedModel}
                  options={modelPickerOptions}
                  ariaLabel="Model"
                  triggerXstyle={mobileModelPickerTriggerStyle}
                  triggerContent={<MobileModelPickerLabel>{selectedModel}</MobileModelPickerLabel>}
                />
              </div>
              <div {...stylex.props(styles.thinkingBox)}>
                <MobileInlinePicker
                  id="story-thinking"
                  value={selectedThinking}
                  onChange={setSelectedThinking}
                  options={thinkingOptions}
                  ariaLabel="Thinking"
                  triggerXstyle={styles.thinkingTrigger}
                  triggerContent={
                    <span {...stylex.props(styles.truncate)}>{selectedThinking}</span>
                  }
                />
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="primary"
            aria-label="Send"
            icon
            shape="pill"
            xstyle={styles.send}
          >
            <ArrowUp {...stylex.props(styles.sendGlyph)} />
          </Button>
        </div>
      </div>
    </MobileInlinePickerRowSlot>
  );
}

function StoryHarness({
  initialOpen = true,
  initialContextType = 'github' as 'local' | 'github' | 'chat',
  initialModel = 'claude-3.5-sonnet',
  modelPickerOptions = modelOptions,
}) {
  const [open, setOpen] = useState(initialOpen);
  const [contextType, setContextType] = useState<'local' | 'github' | 'chat'>(initialContextType);
  const [configOptionValues, setConfigOptionValues] = useState<
    Record<string, AcpConfigOptionValue>
  >({});
  const [machine, setMachine] = useState('zx-macbook');
  const [repo, setRepo] = useState('loro-dev/lody');
  const [localProject, setLocalProject] = useState('zx-macbook:lody');
  const [branch, setBranch] = useState('main');
  const [model, setModel] = useState(initialModel);
  const [thinking, setThinking] = useState('high');
  const [agent, setAgent] = useState('claude-code');
  const [permission, setPermission] = useState('askPermission');
  const handleConfigOptionChange = (configId: string, value: AcpConfigOptionValue) => {
    setConfigOptionValues((prev) => ({ ...prev, [configId]: value }));
  };

  return (
    <div {...stylex.props(styles.frame)}>
      <div {...stylex.props(styles.openRow)}>
        <Button type="button" onClick={() => setOpen(true)} xstyle={styles.openButton}>
          Open
        </Button>
      </div>
      <MobileNewChatSheet
        open={open}
        onOpenChange={setOpen}
        coordinator={MobileInlinePickerCoordinator}
        machineNode={
          <MobileInlinePicker
            id="story-machine"
            value={machine}
            onChange={setMachine}
            options={machineOptions}
            ariaLabel="Machine"
            triggerContent={
              <>
                <Monitor {...stylex.props(styles.pickerGlyph)} />
                <span {...stylex.props(styles.truncate)}>{machine}</span>
              </>
            }
          />
        }
        contextTypeNode={<MockContextTypeNode value={contextType} onChange={setContextType} />}
        perTypeNode={
          contextType === 'chat' ? null : (
            <div {...stylex.props(styles.pickerRow)}>
              <div {...stylex.props(styles.pickerFill)}>
                {contextType === 'github' ? (
                  <MobileInlinePicker
                    id="story-repo"
                    value={repo}
                    onChange={setRepo}
                    options={githubRepoOptions}
                    ariaLabel="Repository"
                    triggerContent={
                      <>
                        <Github {...stylex.props(styles.pickerGlyph)} />
                        <span {...stylex.props(styles.truncate)}>{repo}</span>
                      </>
                    }
                  />
                ) : (
                  <MobileInlinePicker
                    id="story-local-project"
                    value={localProject}
                    onChange={setLocalProject}
                    options={localProjectOptions}
                    ariaLabel="Project"
                    triggerContent={
                      <>
                        <Folder {...stylex.props(styles.pickerGlyph)} />
                        <span {...stylex.props(styles.truncate)}>
                          {localProject.split(':')[1] ?? 'lody'}
                        </span>
                      </>
                    }
                  />
                )}
              </div>
              <div {...stylex.props(styles.pickerFill)}>
                <MobileInlinePicker
                  id="story-branch"
                  value={branch}
                  onChange={setBranch}
                  options={branchOptions}
                  ariaLabel="Branch"
                  triggerContent={
                    <>
                      <GitBranch {...stylex.props(styles.pickerGlyph)} />
                      <span {...stylex.props(styles.truncate)}>{branch}</span>
                    </>
                  }
                />
              </div>
            </div>
          )
        }
        secondaryPerTypeNode={
          contextType === 'local' ? <MockWorkdirModeNode contextType={contextType} /> : null
        }
        composer={
          <MockComposer
            configOptionValues={configOptionValues}
            onConfigOptionChange={handleConfigOptionChange}
            selectedModel={model}
            setSelectedModel={setModel}
            modelPickerOptions={modelPickerOptions}
            selectedThinking={thinking}
            setSelectedThinking={setThinking}
          />
        }
        belowComposerNode={
          <MobileInlinePickerRowSlot>
            <div {...stylex.props(styles.pickerRow)}>
              <div {...stylex.props(styles.minWidth)}>
                <MobileInlinePicker
                  id="story-agent"
                  value={agent}
                  onChange={setAgent}
                  options={agentOptions}
                  ariaLabel="Agent"
                  triggerContent={
                    <>
                      <Sparkles {...stylex.props(styles.pickerGlyph)} />
                      <span {...stylex.props(styles.truncate)}>
                        {agentOptions.find((o) => o.value === agent)?.label ?? agent}
                      </span>
                    </>
                  }
                />
              </div>
              <div {...stylex.props(styles.trailingPicker)}>
                <MobileInlinePicker
                  id="story-permission"
                  value={permission}
                  onChange={setPermission}
                  options={permissionOptions}
                  ariaLabel="Permission"
                  triggerContent={
                    <>
                      <ShieldCheck {...stylex.props(styles.pickerGlyph)} />
                      <span {...stylex.props(styles.truncate)}>
                        {permissionOptions.find((o) => o.value === permission)?.label ?? permission}
                      </span>
                    </>
                  }
                />
              </div>
            </div>
          </MobileInlinePickerRowSlot>
        }
      />
    </div>
  );
}

export const GitHubContext: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    machineNode: null,
    contextTypeNode: null,
    composer: null,
  },
  render: () => <StoryHarness initialContextType="github" />,
};

export const LocalContext: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    machineNode: null,
    contextTypeNode: null,
    composer: null,
  },
  render: () => <StoryHarness initialContextType="local" />,
};

export const ChatContext: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    machineNode: null,
    contextTypeNode: null,
    composer: null,
  },
  render: () => <StoryHarness initialContextType="chat" />,
};

export const LongModelName: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    machineNode: null,
    contextTypeNode: null,
    composer: null,
  },
  render: () => (
    <StoryHarness
      initialContextType="chat"
      initialModel={longModelName}
      modelPickerOptions={longModelOptions}
    />
  ),
};
