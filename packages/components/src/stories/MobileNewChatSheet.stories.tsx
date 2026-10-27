import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import {
  ArrowUp,
  ChevronsUpDown,
  Folders,
  FolderOpen,
  CircleSlash2,
  GitBranch,
  Monitor,
} from 'lucide-react';

import {
  ChatComposer,
  type ChatComposerFileItem,
  type ChatComposerImageItem,
} from '@/components/chat/chat-composer';
import { GitHubOwnerAvatarIcon } from '@/components/chat/unified-project-selector';
import { MOBILE_NEW_CHAT_PROMPT_ID } from '@/components/chat/submission/use-composer-navigation-focus';
import {
  AGENT_ROLE_VERSION,
  getAgentConfigRoomId,
  type AgentConfigMeta,
  type AcpCommandSummary,
  type AgentConfigId,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
} from '@lody/shared';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import type {
  FileWorkspaceProvider,
  FileWorkspaceProviderEntry,
} from '@/lib/file-workspace-provider';
import type { MobileNativeSelectOption } from '@/components/mobile/mobile-native-select';
import { MobileSessionRunConfig } from '@/components/mobile/mobile-session-run-config';
import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import type { AgentSelection } from '@/components/shared/agent-selector';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import {
  MobileInlinePicker,
  MobileInlinePickerCoordinator,
} from '@/components/mobile/mobile-inline-picker';
import { getMobileProjectOptions } from '@/components/mobile/mobile-new-chat-project-options';
import { MobileNewChatSheet } from '@/components/mobile/mobile-new-chat-sheet';
import type {
  MobileProjectFolder,
  MobileProjectGroup,
  MobileProjectMachine,
  MobileProjectRepo,
} from '@/components/mobile/mobile-new-chat-project-sheet';
import { WorktreeCheckboxPill } from '@/components/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { SettingsStoryProviders } from './settings-story-shell';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';

const meta = {
  title: 'Mobile/MobileNewChatSheet',
  component: MobileNewChatSheet,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ForceMobileLayoutProvider force>
        <SettingsStoryProviders>
          <Story />
        </SettingsStoryProviders>
      </ForceMobileLayoutProvider>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof MobileNewChatSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

const projectMachines: MobileProjectMachine[] = [
  { id: 'spikes' as MachineId, name: 'spikes-PowerBook.local', online: true },
  { id: 'zx' as MachineId, name: 'zx-macbook', online: true },
  { id: 'lab' as MachineId, name: 'lab-m2', online: false, disabledReason: 'Offline' },
];

const projectFolders: MobileProjectFolder[] = [
  {
    machineId: 'spikes' as MachineId,
    localProjectId: 'blog' as LocalProjectId,
    name: 'blog',
    rootPath: '~/code/blog',
    lastUsedAt: 5,
  },
  {
    machineId: 'spikes' as MachineId,
    localProjectId: 'lody' as LocalProjectId,
    name: 'lody',
    rootPath: '~/code/lody',
    lastUsedAt: 3,
  },
  {
    machineId: 'spikes' as MachineId,
    localProjectId: 'docs' as LocalProjectId,
    name: 'docs',
    rootPath: '~/code/docs',
    lastUsedAt: 1,
  },
  {
    machineId: 'zx' as MachineId,
    localProjectId: 'loro' as LocalProjectId,
    name: 'loro',
    rootPath: '~/code/loro',
    lastUsedAt: 4,
  },
];

const projectGroups: MobileProjectGroup[] = [
  { projectId: 'loro-stack', name: 'Loro stack', memberCount: 3, lastUsedAt: 4 },
];

const projectRepos: MobileProjectRepo[] = [
  {
    fullName: 'loro-dev/lody',
    description: 'AI-native local-first coding companion',
    lastUsedAt: 5,
  },
  { fullName: 'loro-dev/loro', description: 'High-performance CRDT framework', lastUsedAt: 2 },
  { fullName: 'loro-dev/lody-web', description: 'Web shell for Lody', lastUsedAt: 1 },
];

const branchOptions: MobileNativeSelectOption[] = [
  { value: 'main', label: 'main' },
  { value: 'feat/audit-mobile-coupling', label: 'feat/audit-mobile-coupling' },
];

const imagePreviewDataUri = (label: string, color: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="${color}"/><text x="80" y="86" font-family="sans-serif" font-size="20" fill="white" text-anchor="middle">${label}</text></svg>`
  )}`;

const sampleImageItems: ChatComposerImageItem[] = [
  {
    id: 'img-1',
    name: 'compose-chat.png',
    previewUrl: imagePreviewDataUri('PNG', '#2563eb'),
    status: 'uploaded',
    progress: 100,
  },
  {
    id: 'img-2',
    name: 'compose-local.png',
    previewUrl: imagePreviewDataUri('PNG', '#7c3aed'),
    status: 'uploading',
    progress: 45,
  },
];

const sampleFileItems: ChatComposerFileItem[] = [
  {
    id: 'file-1',
    name: 'new-chat-notes.pdf',
    sizeLabel: '1.2 MB',
    status: 'uploaded',
    progress: 100,
  },
];

const demoFileEntries: FileWorkspaceProviderEntry[] = [
  { path: 'src/components/chat/chat-landing.tsx', kind: 'text', sourceState: 'live-readonly' },
  {
    path: 'src/components/mobile/mobile-new-chat-sheet.tsx',
    kind: 'text',
    sourceState: 'live-readonly',
  },
  { path: 'src/lib/feature-flags.ts', kind: 'text', sourceState: 'live-readonly' },
  { path: 'README.md', kind: 'text', sourceState: 'live-readonly' },
];

const demoProvider: FileWorkspaceProvider = {
  kind: 'none',
  getState: () => ({ kind: 'none', ready: true, sourceState: 'live-readonly' }),
  listFiles: async () => demoFileEntries,
  searchFiles: async (query) =>
    demoFileEntries.filter((entry) => entry.path.toLowerCase().includes(query.toLowerCase())),
  getFile: async (path) => demoFileEntries.find((entry) => entry.path === path) ?? null,
  openFile: async (path) => {
    const entry = demoFileEntries.find((candidate) => candidate.path === path);
    return entry
      ? { status: 'ready', entry, snapshot: { kind: 'text', text: '// demo' } }
      : { status: 'unavailable', reason: 'deleted' };
  },
  saveText: async (path, text) => {
    const entry = demoFileEntries.find((candidate) => candidate.path === path);
    return entry
      ? { status: 'ready', entry, snapshot: { kind: 'text', text } }
      : { status: 'unavailable', reason: 'deleted' };
  },
};

const demoMentionSource: MentionProjectSource = { kind: 'provider', provider: demoProvider };
const demoCommands: AcpCommandSummary[] = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'review', description: 'Review the current changes' },
  { name: 'compact', description: 'Compact the context' },
];

export const ChatContext: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="none" />,
};

export const LocalContext: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="blog" />,
};

export const GitHubContext: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview />,
};

export const LongModelName: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => (
    <InlinePageReview initialProject="blog" initialModel="MiniMax-M3 · 1M context window" />
  ),
};

export const WithAttachments: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="blog" withAttachments />,
};

export const Closed: Story = {
  args: { open: false, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => (
    <MobileNewChatSheet open={false} onOpenChange={() => {}} targetNode={null} composer={null} />
  ),
};

export const WithMenus: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="blog" />,
};

/** Review of the requested page layout using the production composer and pickers.
 * Selection state is synthetic; this story is not the production landing wiring. */
const expandedConfigSelectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'reasoning_effort',
    category: 'thought_level',
    label: 'Reasoning effort',
    currentValue: 'medium',
    options: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value })),
  },
  {
    type: 'select',
    configId: 'interaction_mode',
    category: 'interaction',
    label: 'Interaction mode',
    currentValue: 'agent',
    options: [
      { value: 'agent', label: 'Agent' },
      { value: 'plan', label: 'Plan' },
      { value: 'ask', label: 'Ask' },
    ],
  },
  {
    type: 'select',
    configId: 'agent_preset',
    category: 'other',
    label: 'Profile',
    currentValue: 'default',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'review', label: 'Code review' },
      { value: 'docs', label: 'Documentation' },
    ],
  },
];
const expandedAgentConfigs: AgentConfigMeta[] = [
  {
    id: 'agent-codex' as AgentConfigId,
    machineId: 'spikes' as MachineId,
    name: 'Codex Primary',
    description: 'Synthetic Codex configuration',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  {
    id: 'agent-claude' as AgentConfigId,
    machineId: 'spikes' as MachineId,
    name: 'Claude Code',
    description: 'Synthetic Claude configuration',
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  },
];
function ExpandedConfigStory() {
  const store = useMemo(() => {
    const value = createStore();
    value.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(
        expandedAgentConfigs.map((agent) => [getAgentConfigRoomId(agent.id), agent])
      )
    );
    return value;
  }, []);
  return (
    <Provider store={store}>
      <InlinePageReview fullRunConfig />
    </Provider>
  );
}

export function InlinePageReview({
  longNames = false,
  initialLocalWorktree = false,
  initialProject = 'loro-dev/loro',
  initialText = '',
  initialModel = 'Opus 4.8 1M',
  onSend,
  submissionPending = false,
  withAttachments = false,
  initialRole = false,
  fullRunConfig = false,
  manyBranches = false,
}: {
  longNames?: boolean;
  initialLocalWorktree?: boolean;
  initialProject?: string;
  initialText?: string;
  initialModel?: string;
  onSend?: (text: string, model: string, preserveFocus: boolean) => void;
  submissionPending?: boolean;
  withAttachments?: boolean;
  initialRole?: boolean;
  fullRunConfig?: boolean;
  manyBranches?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [machineId, setMachineId] = useState<MachineId>('spikes' as MachineId);
  const [project, setProject] = useState(initialLocalWorktree ? 'blog' : initialProject);
  const [worktree, setWorktree] = useState(initialLocalWorktree);
  const [branch, setBranch] = useState('main');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [roleId, setRoleId] = useState<AgentRoleId | null>(
    initialRole ? ('reviewer' as AgentRoleId) : null
  );
  const [model, setModel] = useState(initialModel);
  const [mode, setMode] = useState('auto');
  const [agent, setAgent] = useState<AgentSelection>({
    agentId: 'agent-codex' as AgentConfigId,
    machineId: 'spikes' as MachineId,
  });
  const [configValues, setConfigValues] = useState<Record<string, AcpConfigOptionValue>>(
    Object.fromEntries(
      expandedConfigSelectors.map((selector) => [selector.configId, selector.currentValue])
    )
  );
  const selectors = fullRunConfig ? expandedConfigSelectors : [];
  const models = [
    { value: initialModel, label: initialModel },
    { value: 'GPT 5.6-Luna', label: 'GPT 5.6-Luna' },
    ...(fullRunConfig
      ? Array.from({ length: 14 }, (_, index) => ({
          value: `example-model-${index + 1}`,
          label: `Example model ${index + 1}`,
        }))
      : []),
  ];
  const branches = manyBranches
    ? [
        ...branchOptions,
        ...Array.from({ length: 30 }, (_, index) => ({
          value: `feature/mobile-layout-${index + 1}`,
          label: `feature/mobile-layout-${index + 1}`,
        })),
      ]
    : branchOptions;
  const [prompt, setPrompt] = useState(initialText);
  const [images, setImages] = useState(withAttachments ? sampleImageItems : []);
  const [files, setFiles] = useState(withAttachments ? sampleFileItems : []);
  const roleKey = 'reviewer' as AgentRoleId;
  const role = {
    v: AGENT_ROLE_VERSION as 1,
    id: roleKey,
    name: 'Code Reviewer',
    emoji: '🔍',
    ownerUserId: 'user-1',
    visibility: 'private' as const,
    machineId: 'spikes' as MachineId,
    agentConfigId: 'agent-codex' as AgentConfigId,
    runConfig: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const valueFace = (icon: ReactNode, value: string) => (
    <span className="flex min-w-0 w-full items-center gap-2 text-start">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] text-sm text-foreground">
        {value}
      </span>
      <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
    </span>
  );
  const trigger = 'min-h-11 rounded-xl bg-foreground/[0.04] px-3 py-2';
  const panel = 'shadow-none bg-muted/45 border-border/30';
  const localProject = projectFolders.find((entry) => entry.localProjectId === project);
  const isLocal = !!localProject;
  const projectGroup = projectGroups.find((entry) => `group:${entry.projectId}` === project);
  const isGroup = !!projectGroup;
  const isGitLocal = isLocal && project !== 'docs';
  const hasBranch = isGitLocal || (!isLocal && !isGroup && project !== 'none');
  return (
    <MobileNewChatSheet
      open={open}
      onOpenChange={setOpen}
      labels={{ title: 'New chat' }}
      targetNode="New chat"
      coordinator={MobileInlinePickerCoordinator}
      summary={
        <div className="flex flex-col gap-2 py-3">
          <MobileInlinePicker
            id="preview-machine"
            value={machineId}
            onChange={(next) => {
              setMachineId(next as MachineId);
              if (next !== 'spikes') {
                setRoleId(null);
                if (isLocal) setProject('none');
              }
            }}
            ariaLabel="Machine"
            triggerClassName={trigger}
            expansionPanelClassName={panel}
            triggerContent={valueFace(
              <Monitor className="size-4" />,
              longNames
                ? 'MacBook-Pro-for-long-running-development-and-review.local'
                : (projectMachines.find((x) => x.id === machineId)?.name ?? 'Machine')
            )}
            options={projectMachines.map((x) => ({
              value: x.id,
              label: x.name,
              disabled: !x.online,
              description:
                x.disabledReason ??
                (roleId && x.id !== machineId
                  ? 'Changing machine clears the selected Role'
                  : undefined),
            }))}
          />
          <MobileInlinePicker
            id="preview-project"
            value={project}
            onChange={(next) => {
              setProject(next);
              setBranch('main');
              setWorktree(false);
            }}
            ariaLabel="Project"
            searchable
            searchPlaceholder="Search projects"
            triggerClassName={trigger}
            expansionPanelClassName={panel}
            triggerContent={valueFace(
              isGroup ? (
                <Folders className="size-4" />
              ) : project === 'none' ? (
                <CircleSlash2 className="size-4" />
              ) : isLocal ? (
                <FolderOpen className="size-4" />
              ) : (
                <GitHubOwnerAvatarIcon repoFullName={project} />
              ),
              longNames
                ? 'organization/very-long-repository-name-for-mobile-layout-validation'
                : project === 'none'
                  ? 'No project selected'
                  : (projectGroup?.name ?? project)
            )}
            preserveOptionOrder
            options={[
              {
                value: 'none',
                label: 'No project selected',
                icon: <CircleSlash2 className="size-4" />,
              },
              ...getMobileProjectOptions({
                folders: projectFolders,
                repositories: projectRepos,
                groups: projectGroups,
                machineId,
                query: '',
              }).map((option) => ({
                ...option,
                value:
                  option.selection.kind === 'local'
                    ? option.selection.localProjectId
                    : option.selection.kind === 'github'
                      ? option.selection.repoFullName
                      : option.value,
                icon:
                  option.selection.kind === 'group' ? (
                    <Folders className="size-4" />
                  ) : option.selection.kind === 'local' ? (
                    <FolderOpen className="size-4" />
                  ) : (
                    <GitHubOwnerAvatarIcon repoFullName={option.selection.repoFullName} />
                  ),
              })),
            ]}
          />
          {hasBranch ? (
            <div className="flex min-w-0 items-start gap-2 px-1">
              {isGitLocal ? (
                <div className="pt-1">
                  <WorktreeCheckboxPill checked={worktree} onCheckedChange={setWorktree} />
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <MobileInlinePicker
                  id="preview-branch"
                  value={branch}
                  onChange={setBranch}
                  disabled={isGitLocal && !worktree}
                  options={branches}
                  ariaLabel="Branch"
                  searchable
                  triggerClassName="h-8 rounded-lg bg-transparent px-2 hover:bg-transparent"
                  expansionPanelClassName={panel}
                  triggerContent={
                    <>
                      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{branch}</span>
                      <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
                    </>
                  }
                />
              </div>
            </div>
          ) : null}
        </div>
      }
      composer={
        <ChatComposer
          variant="session"
          promptRef={promptRef}
          promptId={MOBILE_NEW_CHAT_PROMPT_ID}
          promptValue={submissionPending ? '' : prompt}
          promptDisabled={submissionPending}
          preservePromptFocus
          onPromptChange={setPrompt}
          promptPlaceholder="Message, @files, /commands"
          promptRows={2}
          maxRows={11}
          autoResize
          onAttachmentAddClick={() => {}}
          imageItems={images}
          onImageRemove={(id) => setImages((items) => items.filter((item) => item.id !== id))}
          fileItems={files}
          onFileRemove={(id) => setFiles((items) => items.filter((item) => item.id !== id))}
          mentionSource={demoMentionSource}
          availableCommands={demoCommands}
          footerSelector={
            <MobileSessionRunConfig
              disabled={submissionPending}
              agentSelection={fullRunConfig ? agent : null}
              allowedMachineIds={['spikes' as MachineId]}
              onAgentConfigChange={setAgent}
              configOptionSelectors={selectors}
              configOptionValues={configValues}
              onConfigOptionChange={(id, value) =>
                setConfigValues((previous) => ({ ...previous, [id]: value }))
              }
              modelOptions={models}
              selectedModelId={model}
              onModelChange={setModel}
              modeOptions={[
                { value: 'auto', label: 'Auto' },
                { value: 'full', label: 'Full access' },
              ]}
              selectedModeId={mode}
              onModeChange={setMode}
              fallbackAgent={{ cliType: 'builtin', agentType: 'codex' }}
              agentRoles={{
                items:
                  machineId === 'spikes'
                    ? [
                        { role, availability: { kind: 'available' } },
                        {
                          role: {
                            ...role,
                            id: 'retired-role' as AgentRoleId,
                            name: 'Retired Reviewer',
                            emoji: '🗃️',
                          },
                          availability: {
                            kind: 'unavailable',
                            reason: 'agent_config_missing',
                          },
                        },
                      ]
                    : [],
                selectedRoleId: roleId,
                onSelect: setRoleId,
              }}
            />
          }

          primaryAction={
            <Button
              type="button"
              icon
              variant="ghost"
              size="medium"
              shape="pill"
              aria-label="Send"
              onClick={() => {
                onSend?.(prompt, model, promptRef.current === document.activeElement);
              }}
              onMouseDown={(event) => event.preventDefault()}
              disabled={
                submissionPending ||
                !prompt.trim() ||
                images.some((item) => item.status !== 'uploaded') ||
                files.some((item) => item.status !== 'uploaded')
              }
              className="shadow-xs transition-all bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]"
            >
              {submissionPending ? <Spinner size="medium" /> : <ArrowUp className="h-5 w-5" />}
            </Button>
          }
        />
      }
    />
  );
}

export const InlinePageReviewStory: Story = {
  name: 'Inline page review',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview />,
};

export const InlinePageLongNames: Story = {
  name: 'Inline page long names',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview longNames />,
};

export const InlinePageLocalWorktree: Story = {
  name: 'Inline page local Git worktree',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialLocalWorktree />,
};

export const InlinePageNoProject: Story = {
  name: 'Inline page no project',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="none" />,
};
export const InlinePageLocalDirect: Story = {
  name: 'Inline page local Git direct',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="blog" />,
};
export const InlinePagePlainFolder: Story = {
  name: 'Inline page plain folder',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="docs" />,
};
export const InlinePageAttachments: Story = {
  name: 'Inline page attachments',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => (
    <InlinePageReview
      initialLocalWorktree
      withAttachments
      initialText="Please review the attached screenshot and notes."
    />
  ),
};
export const InlinePageLongDraft: Story = {
  name: 'Inline page long draft',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => (
    <InlinePageReview
      initialProject="none"
      initialText={
        'Please review this change.\n\nCheck the mobile message composer on a short screen.\nKeep the draft and attachments when switching projects.\nVerify that the keyboard does not cover Send.\n\nPay attention to long machine and repository names.\nTry both light and dark themes.\nOpen every picker and return to the draft.\nCheck the worktree and branch controls.\n\nWrite down any remaining device-only limitations.'
      }
    />
  ),
};
export const InlinePageSelectedRole: Story = {
  name: 'Inline page selected Role',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="none" initialRole />,
};

export const InlinePageProjectGroup: Story = {
  name: 'Inline page project group',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialProject="group:loro-stack" />,
};

export const InlinePageExpandedConfig: Story = {
  name: 'Inline page full run configuration',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <ExpandedConfigStory />,
};
export const InlinePageManyBranches: Story = {
  name: 'Inline page many local branches',
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <InlinePageReview initialLocalWorktree manyBranches />,
};
