import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ArrowUp, Folder, GitBranch, Github, Monitor, ShieldCheck, Sparkles } from 'lucide-react';

import { MobileNewChatSheet } from '@/components/mobile/mobile-new-chat-sheet';
import {
  MobileInlinePicker,
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';
import {
  MobileNativeSelect,
  type MobileNativeSelectOption,
} from '@/components/mobile/mobile-native-select';
import {
  MobileModelPickerLabel,
  mobileModelPickerTriggerClassName,
} from '@/components/mobile/mobile-session-composer-footer';
import { WorktreeCheckboxPill } from '@/components/shared';
import { Button } from '@/ui/button';
import type { AcpConfigOptionValue } from '@/components/shared/acp-selector-options';

const meta = {
  title: 'Mobile/MobileNewChatSheet',
  component: MobileNewChatSheet,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof MobileNewChatSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

/* The story wires native selects for the new-chat target rows and keeps
   `MobileInlinePicker` for rich composer configuration rows. Composer-internal
   chips still need a real `ChatComposer` to test fully; the mock composer here
   renders just their picker triggers so we can see them in the footer row. */

const machineOptions: MobileNativeSelectOption[] = [
  { value: 'zx-macbook', label: 'zx-macbook' },
  { value: 'lab-m2', label: 'lab-m2' },
];

const githubRepoOptions: MobileNativeSelectOption[] = [
  {
    value: 'loro-dev/lody',
    label: 'loro-dev/lody',
  },
  {
    value: 'loro-dev/loro',
    label: 'loro-dev/loro',
  },
];

const localProjectOptions: MobileNativeSelectOption[] = [
  {
    value: 'zx-macbook:lody',
    label: 'lody',
  },
];

const branchOptions: MobileNativeSelectOption[] = [
  { value: 'main', label: 'main' },
  {
    value: 'feat/audit-mobile-coupling',
    label: 'feat/audit-mobile-coupling',
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

function MockWorkChatNode({
  chat,
  onChange,
}: {
  chat: boolean;
  onChange: (chat: boolean) => void;
}) {
  return (
    <div className="flex h-8 items-center rounded-lg bg-muted/70 p-0.5 text-xs font-medium">
      {(['Work', 'Chat'] as const).map((label) => {
        const active = label === 'Chat' ? chat : !chat;
        return (
          <button
            key={label}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(label === 'Chat')}
            className={`h-7 rounded-md px-2.5 ${
              active ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function MockWorkdirModeNode({
  contextType,
  value,
  onChange,
}: {
  contextType: 'local' | 'github' | 'chat';
  value: 'local' | 'worktree';
  onChange: (next: 'local' | 'worktree') => void;
}) {
  if (contextType !== 'local') return null;
  return (
    <WorktreeCheckboxPill
      checked={value === 'worktree'}
      onCheckedChange={(checked) => onChange(checked ? 'worktree' : 'local')}
      className="h-7 bg-transparent px-1.5 hover:bg-hover/60"
    />
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
            size="icon"
            variant="ghost"
            aria-label="Send"
            className="ml-2 h-8 w-8 shrink-0 rounded-full bg-foreground text-background shadow-xs transition-all hover:bg-foreground/90 hover:text-background"
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
  initialBranch = 'main',
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
  const [branch, setBranch] = useState(initialBranch);
  const [workdirMode, setWorkdirMode] = useState<'local' | 'worktree'>('worktree');
  const [model, setModel] = useState(initialModel);
  const [thinking, setThinking] = useState('high');
  const [agent, setAgent] = useState('claude-code');
  const [permission, setPermission] = useState('askPermission');
  const selectedProject =
    contextType === 'local'
      ? `local:${localProject}`
      : contextType === 'github'
        ? `github:${repo}`
        : null;
  const projectOptions: MobileNativeSelectOption[] = [
    ...localProjectOptions.map((option) => ({
      ...option,
      value: `local:${option.value}`,
      group: 'Local',
    })),
    ...githubRepoOptions.map((option) => ({
      ...option,
      value: `github:${option.value}`,
      group: 'GitHub',
    })),
  ];
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
          <MobileNativeSelect
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
        contextTypeNode={
          <MockWorkChatNode
            chat={contextType === 'chat'}
            onChange={(chat) => setContextType(chat ? 'chat' : 'local')}
          />
        }
        perTypeNode={
          contextType === 'chat' ? null : (
            <MobileNativeSelect
              value={selectedProject}
              onChange={(value) => {
                if (value.startsWith('local:')) {
                  setLocalProject(value.slice('local:'.length));
                  setContextType('local');
                } else if (value.startsWith('github:')) {
                  setRepo(value.slice('github:'.length));
                  setContextType('github');
                }
              }}
              options={projectOptions}
              ariaLabel="Project"
              showIndicator={false}
              className="w-fit max-w-full"
              triggerContent={
                <>
                  {contextType === 'github' ? (
                    <Github className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  )}
                  <span className="truncate">
                    {contextType === 'github' ? repo : (localProject.split(':')[1] ?? 'lody')}
                  </span>
                </>
              }
            />
          )
        }
        branchNode={
          contextType === 'github' || (contextType === 'local' && workdirMode === 'worktree') ? (
            <MobileNativeSelect
              value={branch}
              onChange={setBranch}
              options={branchOptions}
              ariaLabel="Branch"
              className="w-fit max-w-full"
              triggerContent={
                <>
                  <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{branch}</span>
                </>
              }
            />
          ) : null
        }
        secondaryPerTypeNode={
          contextType === 'local' ? (
            <MockWorkdirModeNode
              contextType={contextType}
              value={workdirMode}
              onChange={setWorkdirMode}
            />
          ) : null
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

export const LongBranch: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    machineNode: null,
    contextTypeNode: null,
    composer: null,
  },
  render: () => (
    <StoryHarness initialContextType="local" initialBranch="feat/audit-mobile-coupling" />
  ),
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
