import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Brain,
  ChevronsUpDown,
  Folder,
  GitBranch,
  Github,
  MessageCircle,
  Monitor,
} from 'lucide-react';

import {
  ChatComposer,
  type ChatComposerFileItem,
  type ChatComposerImageItem,
} from '@/components/chat/chat-composer';
import type { AcpCommandSummary, LocalProjectId, MachineId } from '@lody/shared';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import type {
  FileWorkspaceProvider,
  FileWorkspaceProviderEntry,
} from '@/lib/file-workspace-provider';
import {
  MobileNativeSelect,
  type MobileNativeSelectOption,
} from '@/components/mobile/mobile-native-select';
import { MobileFooterRail } from '@/components/mobile/mobile-footer-rail';
import { MobileNewChatSheet } from '@/components/mobile/mobile-new-chat-sheet';
import {
  MobileNewChatProjectSheet,
  type MobileProjectFolder,
  type MobileProjectGroup,
  type MobileProjectMachine,
  type MobileProjectRepo,
} from '@/components/mobile/mobile-new-chat-project-sheet';
import { WorktreeCheckboxPill } from '@/components/shared';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import { SettingsStoryProviders } from './settings-story-shell';

const meta = {
  title: 'Mobile/MobileNewChatSheet',
  component: MobileNewChatSheet,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof MobileNewChatSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

type ContextType = 'local' | 'github' | 'chat';

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

function FooterChip({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-8 max-w-[70vw] min-w-0 shrink-0 items-center rounded-full border border-border/60 bg-muted/50 px-2 dark:bg-input/80">
      {children}
    </div>
  );
}

function StoryHarness({
  initialOpen = true,
  initialContextType = 'chat' as ContextType,
  initialModel = 'GPT 5.6-Luna',
  withAttachments = false,
  withMenus = false,
}: {
  initialOpen?: boolean;
  initialContextType?: ContextType;
  initialModel?: string;
  withAttachments?: boolean;
  withMenus?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [contextType, setContextType] = useState<ContextType>(initialContextType);
  const [machineId, setMachineId] = useState<MachineId>('spikes' as MachineId);
  const [repo, setRepo] = useState('loro-dev/lody');
  const [localProject, setLocalProject] = useState('blog');
  const [branch, setBranch] = useState('main');
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [workdirMode, setWorkdirMode] = useState<'local' | 'worktree'>('worktree');
  const [prompt, setPrompt] = useState('');

  const machineName =
    projectMachines.find((machine) => machine.id === machineId)?.name ?? 'Machine';
  const targetLabel =
    contextType === 'local'
      ? (projectFolders.find((folder) => folder.localProjectId === localProject)?.name ??
        localProject)
      : contextType === 'github'
        ? repo
        : 'Chat';
  const targetIcon =
    contextType === 'chat' ? (
      <MessageCircle className="h-4 w-4 shrink-0 opacity-70" />
    ) : contextType === 'github' ? (
      <Github className="h-3.5 w-3.5 shrink-0 opacity-70" />
    ) : (
      <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
    );

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
        labels={{ title: 'New chat', backAriaLabel: 'Back' }}
        targetNode={
          <button
            type="button"
            onClick={() => setProjectSheetOpen(true)}
            aria-label="Select a project"
            className={cn(
              'flex h-11 min-w-0 max-w-full items-center gap-2 rounded-full px-3 text-xl font-semibold',
              'text-foreground transition-colors hover:bg-muted/60 active:bg-muted'
            )}
          >
            {targetIcon}
            <span className="truncate">{targetLabel}</span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        }
        composer={
          <ChatComposer
            variant="sheet"
            className="min-h-0 flex-1"
            promptValue={prompt}
            onPromptChange={setPrompt}
            promptRows={1}
            promptAutoFocus
            focusOnContainerClick
            promptPlaceholder="Press '/' for commands, '@' for mentions, '$' for skills."
            mentionSource={withMenus ? demoMentionSource : undefined}
            availableCommands={withMenus ? demoCommands : undefined}
            onAttachmentAddClick={() => {}}
            imageItems={withAttachments ? sampleImageItems : []}
            onImageRemove={() => {}}
            fileItems={withAttachments ? sampleFileItems : []}
            onFileRemove={() => {}}
            footerSelector={
              <MobileFooterRail>
                <div className="flex h-8 min-w-0 max-w-[70vw] shrink-0 items-center overflow-hidden rounded-full bg-muted/55 pl-0.5 pr-2 dark:bg-input/80">
                  <span className="flex min-w-0 items-baseline gap-1.5 px-2">
                    <Brain className="h-3.5 w-3.5 shrink-0 self-center opacity-70" />
                    <span className="truncate text-sm leading-none">{initialModel}</span>
                    <span className="shrink-0 text-[11px] leading-none text-muted-foreground">
                      Auto
                    </span>
                    <span className="shrink-0 text-[11px] leading-none tabular-nums text-muted-foreground">
                      73%
                    </span>
                  </span>
                </div>
                <FooterChip>
                  <button
                    type="button"
                    onClick={() => setProjectSheetOpen(true)}
                    aria-label="Machine"
                    className="flex h-8 min-w-0 items-center gap-1.5 px-1 text-sm text-foreground/85"
                  >
                    <Monitor className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{machineName}</span>
                    <ChevronsUpDown
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </button>
                </FooterChip>
                {contextType === 'local' ? (
                  <FooterChip>
                    <WorktreeCheckboxPill
                      checked={workdirMode === 'worktree'}
                      onCheckedChange={(checked) => setWorkdirMode(checked ? 'worktree' : 'local')}
                      className="h-7 bg-transparent px-1.5 hover:bg-hover/60"
                    />
                  </FooterChip>
                ) : null}
                {contextType === 'chat' ? null : (
                  <FooterChip>
                    <MobileNativeSelect
                      value={branch}
                      onChange={setBranch}
                      options={branchOptions}
                      ariaLabel="Branch"
                      className="h-8 w-fit max-w-full"
                      triggerContent={
                        <>
                          <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
                          <span className="truncate">{branch}</span>
                        </>
                      }
                    />
                  </FooterChip>
                )}
              </MobileFooterRail>
            }
            primaryAction={
              <Button
                type="button"
                icon
                variant="ghost"
                aria-label="Send"
                disabled={!prompt.trim()}
                className={cn(
                  'h-9 w-9 rounded-full bg-foreground text-background hover:bg-foreground/90',
                  !prompt.trim() && 'opacity-40'
                )}
              >
                <ArrowUp className="h-5 w-5" />
              </Button>
            }
          />
        }
      />
      <MobileNewChatProjectSheet
        open={projectSheetOpen}
        onOpenChange={setProjectSheetOpen}
        machines={projectMachines}
        selectedMachineId={machineId}
        onMachineChange={(nextMachineId) => {
          setMachineId(nextMachineId);
          if (
            contextType === 'local' &&
            !projectFolders.some(
              (folder) =>
                folder.machineId === nextMachineId && folder.localProjectId === localProject
            )
          ) {
            setContextType('chat');
          }
        }}
        localProjects={projectFolders}
        repositories={projectRepos}
        groups={projectGroups}
        selection={
          contextType === 'local'
            ? {
                kind: 'local',
                machineId,
                localProjectId: localProject as LocalProjectId,
              }
            : contextType === 'github'
              ? { kind: 'github', repoFullName: repo }
              : { kind: 'none' }
        }
        onSelect={(next) => {
          if (next.kind === 'none') {
            setContextType('chat');
          } else if (next.kind === 'local') {
            setMachineId(next.machineId);
            setLocalProject(next.localProjectId);
            setContextType('local');
          } else if (next.kind === 'github') {
            setRepo(next.repoFullName);
            setContextType('github');
          } else {
            setContextType('chat');
          }
        }}
        onAddLocalProject={() => setProjectSheetOpen(false)}
        onConnectGitHub={() => setProjectSheetOpen(false)}
      />
    </div>
  );
}

export const ChatContext: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <StoryHarness initialContextType="chat" />,
};

export const LocalContext: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <StoryHarness initialContextType="local" />,
};

export const GitHubContext: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <StoryHarness initialContextType="github" />,
};

export const LongModelName: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => (
    <StoryHarness initialContextType="local" initialModel="MiniMax-M3 · 1M context window" />
  ),
};

export const WithAttachments: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <StoryHarness initialContextType="local" withAttachments />,
};

export const Closed: Story = {
  args: { open: false, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <StoryHarness initialOpen={false} />,
};

export const WithMenus: Story = {
  args: { open: true, onOpenChange: () => {}, targetNode: null, composer: null },
  render: () => <StoryHarness initialContextType="local" withMenus />,
};
