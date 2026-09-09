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
  mobileModelPickerTriggerClassName,
} from '@/components/mobile/mobile-session-composer-footer';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import type { AcpConfigOptionValue } from '@/components/shared/acp-selector-options';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';

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
  { value: 'zx-macbook', label: 'zx-macbook', icon: <Monitor className="h-3.5 w-3.5" /> },
  { value: 'lab-m2', label: 'lab-m2', icon: <Monitor className="h-3.5 w-3.5" /> },
];

const githubRepoOptions: MobileInlinePickerOption[] = [
  {
    value: 'loro-dev/lody',
    label: 'loro-dev/lody',
    description: 'AI-native local-first coding companion',
    icon: <Github className="h-3.5 w-3.5" />,
  },
  {
    value: 'loro-dev/loro',
    label: 'loro-dev/loro',
    description: 'High-performance CRDT framework',
    icon: <Github className="h-3.5 w-3.5" />,
  },
];

const localProjectOptions: MobileInlinePickerOption[] = [
  {
    value: 'zx-macbook:lody',
    label: 'lody',
    description: '~/code/lody',
    icon: <Folder className="h-3.5 w-3.5" />,
  },
];

const branchOptions: MobileInlinePickerOption[] = [
  { value: 'main', label: 'main', icon: <GitBranch className="h-3.5 w-3.5" /> },
  {
    value: 'feat/audit-mobile-coupling',
    label: 'feat/audit-mobile-coupling',
    icon: <GitBranch className="h-3.5 w-3.5" />,
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
  { value: 'claude-code', label: 'Claude Code', icon: <Sparkles className="h-3.5 w-3.5" /> },
  { value: 'codex', label: 'Codex', icon: <Sparkles className="h-3.5 w-3.5" /> },
];

const permissionOptions: MobileInlinePickerOption[] = [
  {
    value: 'askPermission',
    label: 'Ask permission',
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
  },
];

function MockContextTypeNode({
  value,
  onChange,
}: {
  value: 'local' | 'github' | 'chat';
  onChange: (next: 'local' | 'github' | 'chat') => void;
}) {
  const triggerClassName = cn(
    'flex-1 inline-flex items-center justify-start gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-all',
    'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs',
    'text-muted-foreground'
  );
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onChange(v as 'local' | 'github' | 'chat')}
      className="w-full"
    >
      <TabsList className="flex h-10 w-full rounded-md bg-muted p-1">
        <TabsTrigger value="local" className={triggerClassName}>
          <Folder className="h-3.5 w-3.5" />
          <span>Local</span>
        </TabsTrigger>
        <TabsTrigger value="github" className={triggerClassName}>
          <Github className="h-3.5 w-3.5" />
          <span>GitHub</span>
        </TabsTrigger>
        <TabsTrigger value="chat" className={triggerClassName}>
          <MessageCircle className="h-3.5 w-3.5" />
          <span>Chat</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function MockWorkdirModeNode({ contextType }: { contextType: 'local' | 'github' | 'chat' }) {
  if (contextType !== 'local') return null;
  const triggerClassName =
    'flex-1 inline-flex items-center justify-start gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-all';
  return (
    <div className="flex h-10 w-full rounded-md bg-muted p-1">
      <button type="button" className={cn(triggerClassName, 'text-muted-foreground')}>
        <Folder className="h-3.5 w-3.5" />
        <span>本地文件</span>
      </button>
      <button
        type="button"
        className={cn(triggerClassName, 'bg-background text-foreground shadow-xs')}
      >
        <GitBranch className="h-3.5 w-3.5" />
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
      <div className="rounded-2xl border border-input-border/70 bg-input/90 p-3">
        <textarea
          rows={2}
          placeholder="描述你的需求。"
          className="input-scrollbar w-full resize-none bg-transparent text-sm leading-6 text-input-foreground placeholder:text-input-placeholder focus:outline-none"
        />
        {/* Mirrors the real composer footer: the configOptions cluster
            fills the row (`w-full` inside the `flex-1` wrapper) so each
            config shows in full, and only the model shrinks/truncates
            (keeping its tail) once the row is too narrow — thinking is
            pinned `shrink-0`. The send button sits at the far right. */}
        <div className="flex items-center pt-1">
          <div className="flex min-w-0 flex-1 items-center">
            <div className="flex w-full min-w-0 items-center">
              <div className="min-w-0">
                <MobileInlinePicker
                  id="story-model"
                  value={selectedModel}
                  onChange={setSelectedModel}
                  options={modelPickerOptions}
                  ariaLabel="Model"
                  triggerClassName={mobileModelPickerTriggerClassName}
                  triggerContent={<MobileModelPickerLabel>{selectedModel}</MobileModelPickerLabel>}
                />
              </div>
              <div className="ml-1 shrink-0">
                <MobileInlinePicker
                  id="story-thinking"
                  value={selectedThinking}
                  onChange={setSelectedThinking}
                  options={thinkingOptions}
                  ariaLabel="Thinking"
                  triggerClassName="h-8 px-2 py-1 text-sm"
                  triggerContent={<span className="truncate">{selectedThinking}</span>}
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
            className="ml-2 shrink-0"
          >
            <ArrowUp className="h-5 w-5" />
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
    <div className="relative h-[956px] w-full bg-background text-foreground">
      <div className="flex h-full items-end justify-center">
        <Button type="button" onClick={() => setOpen(true)} className="mb-6">
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
                <Monitor className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="truncate">{machine}</span>
              </>
            }
          />
        }
        contextTypeNode={<MockContextTypeNode value={contextType} onChange={setContextType} />}
        perTypeNode={
          contextType === 'chat' ? null : (
            <div className="flex w-full items-start gap-2">
              <div className="min-w-0 flex-1">
                {contextType === 'github' ? (
                  <MobileInlinePicker
                    id="story-repo"
                    value={repo}
                    onChange={setRepo}
                    options={githubRepoOptions}
                    ariaLabel="Repository"
                    triggerContent={
                      <>
                        <Github className="h-3.5 w-3.5 shrink-0 opacity-70" />
                        <span className="truncate">{repo}</span>
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
                        <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
                        <span className="truncate">{localProject.split(':')[1] ?? 'lody'}</span>
                      </>
                    }
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <MobileInlinePicker
                  id="story-branch"
                  value={branch}
                  onChange={setBranch}
                  options={branchOptions}
                  ariaLabel="Branch"
                  triggerContent={
                    <>
                      <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span className="truncate">{branch}</span>
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
            <div className="flex w-full items-start gap-2">
              <div className="min-w-0">
                <MobileInlinePicker
                  id="story-agent"
                  value={agent}
                  onChange={setAgent}
                  options={agentOptions}
                  ariaLabel="Agent"
                  triggerContent={
                    <>
                      <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span className="truncate">
                        {agentOptions.find((o) => o.value === agent)?.label ?? agent}
                      </span>
                    </>
                  }
                />
              </div>
              <div className="ml-auto min-w-0">
                <MobileInlinePicker
                  id="story-permission"
                  value={permission}
                  onChange={setPermission}
                  options={permissionOptions}
                  ariaLabel="Permission"
                  triggerContent={
                    <>
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span className="truncate">
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
