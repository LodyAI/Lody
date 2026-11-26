import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type {
  AgentConfigId,
  AgentConfigMeta,
  LocalProjectId,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import { ChatLandingView, type ChatLandingHintType } from '@/components/chat/chat-landing-view';
import { BranchSelector } from '@/components/chat/chat-landing-selectors';
import {
  UnifiedProjectSelectorView,
  type UnifiedLocalProjectOption,
  type UnifiedProjectSelection,
} from '@/components/chat/unified-project-selector';
import {
  DesktopMachineMenu,
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import type { AgentSelection } from '@/components/shared/agent-selector';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { composerSurface } from '@/components/shared/composer-surface';
import { WorktreeCheckboxPill } from '@/components/shared/workdir-mode-selector';
import {
  TODAY_CONVERT_DIALOG_WIDTH,
  TodayConvertDialogHeader,
} from '@/components/today/today-convert-dialog-header';
import { useChatLandingKeyboardNav } from '@/hooks/use-chat-landing-keyboard-nav';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { useTheme } from '@/theme-provider';
import type { ComposerInputElement } from '@/ui/mention/composer-input';
import { Dialog } from '@/ui/dialog';

/**
 * Today's "Convert to task" dialog for Storybook: the product's own header,
 * dialog layout of `ChatLandingView` and desktop selectors (machine, project,
 * worktree/branch, run config, permission) over synthetic machines, projects
 * and agents. The product dialog wraps the stateful `ChatLanding`, which needs
 * a workspace runtime; everything it renders is here.
 */

const STORY_WORKSPACE_ID = 'workspace-storybook-convert' as WorkspaceId;
const MAC_STUDIO = 'machine-demo' as MachineId;
const MACBOOK = 'machine-remote' as MachineId;
const CODEX = 'agent-storybook-codex' as AgentConfigId;
const CLAUDE = 'agent-storybook-claude' as AgentConfigId;
const PERSONAL_TOOLS = 'project-personal-tools' as LocalProjectId;
const DESIGN_LAB = 'project-local-git' as LocalProjectId;

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'local:storybook-convert-user', name: 'Storybook user' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [{ id: STORY_WORKSPACE_ID, name: 'Loro', slug: 'loro', role: 'owner' }],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

const machines = [
  { value: MAC_STUDIO, label: 'Mac Studio' },
  { value: MACBOOK, label: 'MacBook Pro' },
] as const;

const localProjects: UnifiedLocalProjectOption[] = [
  {
    key: `${MAC_STUDIO}:${PERSONAL_TOOLS}`,
    machineId: MAC_STUDIO,
    localProjectId: PERSONAL_TOOLS,
    name: 'personal-tools',
    rootPath: '/Users/developer/Projects/personal-tools',
  },
  {
    key: `${MAC_STUDIO}:${DESIGN_LAB}`,
    machineId: MAC_STUDIO,
    localProjectId: DESIGN_LAB,
    name: 'design-system-lab',
    rootPath: '/Users/developer/Projects/design-system-lab',
  },
  {
    key: `${MACBOOK}:project-remote-notes`,
    machineId: MACBOOK,
    localProjectId: 'project-remote-notes' as LocalProjectId,
    name: 'research-notes',
    rootPath: '/Users/developer/Notes/research-notes',
  },
];

const agents: AgentConfigMeta[] = [
  {
    id: CODEX,
    machineId: MAC_STUDIO,
    name: 'Codex · Mac Studio',
    description: 'Local Codex agent',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  {
    id: CLAUDE,
    machineId: MAC_STUDIO,
    name: 'Claude · Mac Studio',
    description: 'Local Claude agent',
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  },
  {
    id: 'agent-storybook-remote' as AgentConfigId,
    machineId: MACBOOK,
    name: 'Codex · MacBook Pro',
    description: 'Remote machine agent',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
];

const codexModels: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier coding model.' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Smaller, faster coding model.' },
];
const claudeModels: AcpSessionSelectOption[] = [
  { value: 'sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'Balanced for everyday coding.' },
  { value: 'opus-4.6', label: 'Claude Opus 4.6', description: 'For complex engineering work.' },
];
const permissionModes: AcpSessionSelectOption[] = [
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'Ask before editing or running commands.',
  },
  { value: 'agent', label: 'Agent', description: 'Read and edit files in the project.' },
  {
    value: 'agent-full-access',
    label: 'Full access',
    description: 'Allow edits outside the project and network access.',
  },
];
const runConfigSelectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'reasoning_effort',
    category: 'thought_level',
    label: 'Reasoning effort',
    currentValue: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
  { type: 'boolean', configId: 'plan_mode', label: 'Plan', currentValue: false, options: [] },
];
const branches: AcpSessionSelectOption[] = [
  { value: 'main', label: 'main' },
  { value: 'today/outline', label: 'today/outline' },
];

export type ConvertDialogPreviewProps = {
  open: boolean;
  /** Seeds the prompt each time the dialog opens, as the node's text does. */
  prompt: string;
  onOpenChange: (open: boolean) => void;
  /** "Start task", with the prompt as sent. */
  onStart: (prompt: string) => void;
  hintType?: ChatLandingHintType;
};

export function ConvertDialogPreview({
  open,
  prompt,
  onOpenChange,
  onStart,
  hintType = null,
}: ConvertDialogPreviewProps) {
  const { t } = useTranslation();
  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
        <Dialog.Content
          width={TODAY_CONVERT_DIALOG_WIDTH}
          closeLabel={t('common.close', 'Close')}
          data-testid="today-convert-dialog"
        >
          <TodayConvertDialogHeader
            parent={t('today.nav', 'Today')}
            title={t('today.convertTitle', 'Convert to task')}
          />
          {open ? (
            <ConvertDialogBody
              initialPrompt={prompt}
              hintType={hintType}
              onCancel={() => onOpenChange(false)}
              onStart={onStart}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
    </PlatformContext.Provider>
  );
}

function ConvertDialogBody({
  initialPrompt,
  hintType,
  onCancel,
  onStart,
}: {
  initialPrompt: string;
  hintType: ChatLandingHintType;
  onCancel: () => void;
  onStart: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const navRef = useRef<HTMLDivElement>(null);
  useChatLandingKeyboardNav(navRef, { enabled: true });
  const [prompt, setPrompt] = useState(initialPrompt);
  const [machineId, setMachineId] = useState<MachineId>(MAC_STUDIO);
  const [projectId, setProjectId] = useState<LocalProjectId | null>(DESIGN_LAB);
  const [worktree, setWorktree] = useState(true);
  const [branch, setBranch] = useState<string | null>('main');
  const [agentSelection, setAgentSelection] = useState<AgentSelection>({
    machineId: MAC_STUDIO,
    agentId: CODEX,
  });
  const [modelId, setModelId] = useState<string | null>('gpt-5.5');
  const [modeId, setModeId] = useState<string | null>('agent');
  const [configValues, setConfigValues] = useState<Record<string, AcpConfigOptionValue>>({
    reasoning_effort: 'medium',
    plan_mode: false,
  });
  const setConfig = (configId: string, value: AcpConfigOptionValue) =>
    setConfigValues((previous) => ({ ...previous, [configId]: value }));

  const machineProjects = localProjects.filter((project) => project.machineId === machineId);
  const project = machineProjects.find((option) => option.localProjectId === projectId);
  const isGit = project?.localProjectId === DESIGN_LAB;
  const selection = useMemo<UnifiedProjectSelection>(
    () =>
      project
        ? { kind: 'local', machineId: project.machineId, localProjectId: project.localProjectId }
        : { kind: 'none' },
    [project]
  );
  const agent = agents.find((config) => config.id === agentSelection.agentId);
  const modelOptions = agent?.agentType === 'claude' ? claudeModels : codexModels;
  const send = () => {
    if (prompt.trim()) onStart(prompt);
  };

  const topSelector = (
    <div {...stylex.props(previewStyles.layout)}>
      <DesktopMachineMenu
        value={machineId}
        visibleLocalMachineId={MAC_STUDIO}
        selectedLabel={machines.find((option) => option.value === machineId)?.label}
        options={machines}
        onChange={(next) => {
          setMachineId(next);
          setProjectId(
            localProjects.find((option) => option.machineId === next)?.localProjectId ?? null
          );
          const nextAgent = agents.find((config) => config.machineId === next);
          if (nextAgent) setAgentSelection({ machineId: next, agentId: nextAgent.id });
        }}
        onAddMachine={() => {}}
      />
      <div {...stylex.props(themeStyles.row)}>
        <UnifiedProjectSelectorView
          value={selection}
          onChange={(next) => {
            if (next.kind === 'none') setProjectId(null);
            else if (next.kind === 'local') {
              setMachineId(next.machineId);
              setProjectId(next.localProjectId);
            }
          }}
          localProjects={machineProjects}
          repositories={[]}
          onAddLocalProject={() => {}}
          onConnectGitRepo={() => {}}
          renderLimit={20}
        />
      </div>
      {project ? (
        <div {...stylex.props(composerSurface.contextPill, composerSurface.contextPillFixed)}>
          {isGit && worktree ? (
            <>
              <BranchSelector
                value={branch}
                onChange={setBranch}
                options={branches}
                placeholder="Branch"
                searchPlaceholder="Search branches"
                emptyText="No branches found"
              />
              <span aria-hidden="true" {...stylex.props(composerSurface.contextPillDivider)} />
            </>
          ) : null}
          <WorktreeCheckboxPill
            checked={isGit && worktree}
            onCheckedChange={setWorktree}
            disabled={!isGit}
            surface="context"
          />
        </div>
      ) : null}
    </div>
  );

  const footerSelector = (
    <div {...stylex.props(previewStyles.layout)}>
      <DesktopRunConfigMenu
        agentSelection={agentSelection}
        allowedMachineIds={[machineId]}
        availableAgentConfigs={agents}
        onAgentConfigChange={setAgentSelection}
        modelOptions={modelOptions}
        selectedModelId={
          modelOptions.some((m) => m.value === modelId) ? modelId : modelOptions[0]!.value
        }
        onModelChange={setModelId}
        modeOptions={permissionModes}
        selectedModeId={modeId}
        configOptionSelectors={runConfigSelectors}
        configOptionValues={configValues}
        onConfigOptionChange={setConfig}
        menuSide="top"
      />
      <DesktopPermissionModeButton
        modeOptions={permissionModes}
        selectedModeId={modeId}
        onModeChange={setModeId}
        configOptionSelectors={runConfigSelectors}
        configOptionValues={configValues}
        onConfigOptionChange={setConfig}
        menuSide="top"
      />
    </div>
  );

  return (
    <ChatLandingView
      tone={resolvedTheme === 'dark' ? 'dark' : 'light'}
      layout="dialog"
      promptId="today-convert-prompt"
      navRootRef={navRef}
      title=""
      promptValue={prompt}
      onPromptChange={setPrompt}
      // The product landing's keydown: Enter sends unless an IME is composing.
      onPromptKeyDown={(event: KeyboardEvent<ComposerInputElement>) => {
        if (event.key !== 'Enter' || event.shiftKey || isImeComposingKeyboardEvent(event)) return;
        event.preventDefault();
        send();
      }}
      onAttachmentAddClick={() => {}}
      topSelector={topSelector}
      footerSelector={footerSelector}
      submitDisabled={!prompt.trim()}
      onSubmit={send}
      submitLabel={t('today.convertSubmit', 'Start task')}
      onCancel={onCancel}
      cancelLabel={t('common.cancel', 'Cancel')}
      hintType={hintType}
    />
  );
}

const themeStyles = stylex.create({
  row: { display: 'flex', minWidth: '4.5rem', flexShrink: 1 },
});

const previewStyles = stylex.create({
  layout: { display: 'contents' },
});
