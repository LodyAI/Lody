import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState, type ReactNode } from 'react';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ArrowUp, Folder, GitBranch, Github, Monitor } from 'lucide-react';

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
  initialPrompt = '',
  targetControls,
  configOptionValues: _configOptionValues,
  onConfigOptionChange: _onConfigOptionChange,
  selectedModel,
  setSelectedModel,
  modelPickerOptions = modelOptions,
  selectedThinking,
  setSelectedThinking: _setSelectedThinking,
}: {
  initialPrompt?: string;
  targetControls?: ReactNode;
  configOptionValues: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange: (configId: string, value: AcpConfigOptionValue) => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  modelPickerOptions?: MobileInlinePickerOption[];
  selectedThinking: string;
  setSelectedThinking: (v: string) => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  return (
    <MobileInlinePickerRowSlot>
      <ChatComposer
        fillSheet
        variant="session"
        promptValue={prompt}
        onPromptChange={setPrompt}
        promptPlaceholder="Describe a coding task in lody"
        onAttachmentAddClick={() => {}}
        footerSelector={
          <>
            <div className="flex h-10 w-max max-w-[70vw] shrink-0 items-center rounded-full border border-border/60 bg-muted/50 px-2">
              <MobileInlinePicker
                id="story-model"
                value={selectedModel}
                onChange={setSelectedModel}
                options={modelPickerOptions}
                ariaLabel="Model"
                triggerContent={
                  <span>
                    {selectedModel} · {selectedThinking}
                  </span>
                }
              />
            </div>
            {targetControls}
          </>
        }
        primaryAction={
          <Button
            size="icon"
            aria-label="Send"
            disabled={!prompt.trim()}
            onClick={() => setPrompt('')}
            className="h-10 w-10 shrink-0 rounded-full bg-foreground text-background"
          >
            <ArrowUp className="h-5 w-5" />
          </Button>
        }
      />
    </MobileInlinePickerRowSlot>
  );
}

function StoryHarness({
  keyboardHeight = 0,
  initialPrompt = '',
  initialOpen = true,
  initialContextType = 'github' as 'local' | 'github' | 'chat',
  initialBranch = 'main',
  initialModel = 'claude-3.5-sonnet',
  modelPickerOptions = modelOptions,
}) {
  useEffect(() => {
    const style = document.documentElement.style;
    const previous = style.getPropertyValue('--native-keyboard-height');
    style.setProperty('--native-keyboard-height', `${keyboardHeight}px`);
    return () => {
      if (previous) style.setProperty('--native-keyboard-height', previous);
      else style.removeProperty('--native-keyboard-height');
    };
  }, [keyboardHeight]);
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
  const selectedProject =
    contextType === 'local'
      ? `local:${localProject}`
      : contextType === 'github'
        ? `github:${repo}`
        : 'chat';
  const projectOptions: MobileNativeSelectOption[] = [
    { value: 'chat', label: "Don't work in a project" },
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
        contextTypeNode={null}
        perTypeNode={
          <MobileNativeSelect
            value={selectedProject}
            onChange={(value) => {
              if (value === 'chat') {
                setContextType('chat');
              } else if (value.startsWith('local:')) {
                setLocalProject(value.slice('local:'.length));
                setContextType('local');
              } else if (value.startsWith('github:')) {
                setRepo(value.slice('github:'.length));
                setContextType('github');
              }
            }}
            options={projectOptions}
            ariaLabel="Project"
            className="h-11 w-fit max-w-full text-base font-semibold"
            triggerContent={
              <>
                {contextType === 'github' ? (
                  <Github className="h-3.5 w-3.5 shrink-0 opacity-70" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
                )}
                <span className="truncate">
                  {contextType === 'chat'
                    ? 'Chat'
                    : contextType === 'github'
                      ? repo
                      : (localProject.split(':')[1] ?? 'lody')}
                </span>
              </>
            }
          />
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
        composer={(targetControls) => (
          <MockComposer
            initialPrompt={initialPrompt}
            targetControls={targetControls}
            configOptionValues={configOptionValues}
            onConfigOptionChange={handleConfigOptionChange}
            selectedModel={model}
            setSelectedModel={setModel}
            modelPickerOptions={modelPickerOptions}
            selectedThinking={thinking}
            setSelectedThinking={setThinking}
          />
        )}
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

export const KeyboardOpen: Story = {
  ...LocalContext,
  render: () => <StoryHarness initialContextType="local" keyboardHeight={300} />,
};

export const LongPrompt: Story = {
  ...LocalContext,
  render: () => (
    <StoryHarness
      initialContextType="local"
      keyboardHeight={300}
      initialPrompt={Array.from(
        { length: 40 },
        (_, index) => `${index + 1}. Review the synthetic example and explain the proposed change.`
      ).join('\n')}
    />
  ),
};
