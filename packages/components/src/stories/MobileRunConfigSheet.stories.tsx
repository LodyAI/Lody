import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useMemo, useState } from 'react';
import { fn } from 'storybook/test';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  getAgentConfigRoomId,
} from '@lody/shared';

import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import { MobileRunConfigSheet } from '@/components/mobile/mobile-run-config-sheet';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import type { ComposerAgentRoleItem } from '@/lib/composer-agent-roles';

/**
 * The mobile composer's consolidated run-config bottom sheet, opened by
 * `MobileRunConfigButton`. Rendered here with the agent-config cache seeded
 * so the AGENT row resolves a real config + brand icon (production reads the
 * same atom). The collapsed button lives in `MobileRunConfigButton.stories`;
 * the full in-context flow (button → sheet) is in
 * `SessionConversationPage.stories` (`MobileIdle`).
 */
const machineId = 'machine-storybook' as MachineId;
const codexSessionId = 'session-codex' as SessionId;
const claudeSessionId = 'session-claude' as SessionId;
const codexId = 'agent-codex' as AgentConfigId;
const claudeId = 'agent-claude' as AgentConfigId;
const deepseekId = 'agent-deepseek' as AgentConfigId;

const agents: AgentConfigMeta[] = [
  {
    id: codexId,
    machineId,
    name: 'Codex Primary',
    description: 'Codex on zx-macbook',
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  {
    id: claudeId,
    machineId,
    name: 'Claude (Opus)',
    description: 'Claude Code',
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  },
  {
    id: deepseekId,
    machineId,
    name: 'DeepSeek Harness',
    description: 'Built-in DeepSeek Harness runtime',
    cliType: 'builtin',
    agentType: 'deepseek',
    env: {},
  },
];

const codexSession: SessionMeta = {
  id: codexSessionId,
  machineId,
  createdAt: '2026-03-27T00:00:00.000Z',
  title: 'Codex session',
  userId: 'user-story',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
  agentConfigId: codexId,
};

const claudeSession: SessionMeta = {
  ...codexSession,
  id: claudeSessionId,
  title: 'Claude session',
  agentType: 'claude',
  agentConfigId: claudeId,
};

const deepseekSession: SessionMeta = {
  ...codexSession,
  id: 'session-deepseek' as SessionId,
  title: 'DeepSeek session',
  agentType: 'deepseek',
  agentConfigId: deepseekId,
};

const codexModelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: 'gpt-5.5' },
  { value: 'gpt-5.4', label: 'gpt-5.4' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
];
const claudeModelOptions: AcpSessionSelectOption[] = [
  { value: 'opus-4.8', label: 'Opus 4.8' },
  { value: 'sonnet-4.5', label: 'Sonnet 4.5' },
];

const codexSelectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'mode',
    category: 'mode',
    label: 'Mode',
    currentValue: 'agent',
    options: [
      { value: 'read-only', label: 'Read-only' },
      { value: 'agent', label: 'Agent' },
      { value: 'agent-full-access', label: 'Full access' },
    ],
  },
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
      { value: 'xhigh', label: 'XHigh' },
    ],
  },
  {
    type: 'select',
    configId: 'collaboration_mode',
    category: 'collaboration_mode',
    label: 'Collaboration mode',
    currentValue: 'default',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'plan', label: 'Plan' },
    ],
  },
  {
    type: 'select',
    configId: 'fast-mode',
    category: 'fast-mode',
    label: 'Fast mode',
    currentValue: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
];

const claudeSelectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'mode',
    category: 'mode',
    label: 'Mode',
    currentValue: 'auto',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'default', label: 'Default' },
      { value: 'acceptEdits', label: 'Accept Edits' },
      { value: 'plan', label: 'Plan Mode' },
      { value: 'dontAsk', label: "Don't Ask" },
    ],
  },
];

function StoryShell({
  session,
  modelOptions,
  selectors,
  agentRoles,
}: {
  session: SessionMeta;
  modelOptions: AcpSessionSelectOption[];
  selectors: AcpConfigOptionSelector[];
  agentRoles?: ComposerAgentRoleItem[];
}) {
  const store = useMemo(() => {
    const s = createStore();
    s.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(agents.map((a) => [getAgentConfigRoomId(a.id), a]))
    );
    return s;
  }, []);

  const [open, setOpen] = useState(true);
  const [model, setModel] = useState<string | null>(modelOptions[0]?.value ?? null);
  const [roleId, setRoleId] = useState<AgentRoleId | null>(null);
  const [values, setValues] = useState<Record<string, AcpConfigOptionValue>>(() =>
    Object.fromEntries(selectors.map((sel) => [sel.configId, sel.currentValue]))
  );

  return (
    <Provider store={store}>
      <div className="flex min-h-dvh flex-col items-center justify-start bg-stone-950 p-6">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground"
        >
          Open run config
        </button>
        <MobileRunConfigSheet
          open={open}
          onOpenChange={setOpen}
          agentSelection={
            session.agentConfigId && session.machineId
              ? { agentId: session.agentConfigId, machineId: session.machineId }
              : null
          }
          allowedMachineIds={session.machineId ? [session.machineId] : []}
          agentLocked
          onAgentConfigChange={fn()}
          modelOptions={modelOptions}
          selectedModelId={model}
          onModelChange={setModel}
          modeOptions={[]}
          selectedModeId={null}
          onModeChange={fn()}
          configOptionSelectors={selectors}
          configOptionValues={values}
          onConfigOptionChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
          agentRoles={
            agentRoles
              ? {
                  items: agentRoles,
                  selectedRoleId: roleId,
                  onSelect: setRoleId,
                  onCreate: fn(),
                  onSendInstruction: async () => true,
                }
              : undefined
          }
        />
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Mobile/MobileRunConfigSheet',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Codex: Story = {
  args: { session: codexSession, modelOptions: codexModelOptions, selectors: codexSelectors },
};

export const Claude: Story = {
  args: { session: claudeSession, modelOptions: claudeModelOptions, selectors: claudeSelectors },
};

export const DeepSeekDelegationWarning: Story = {
  args: {
    session: deepseekSession,
    modelOptions: [
      {
        value: 'deepseek-v4-flash',
        label: 'DeepSeek-V4-Flash',
        description: 'Faster DeepSeek Harness coding model.',
      },
      {
        value: 'deepseek-v4-pro',
        label: 'DeepSeek-V4-Pro',
        description: 'More capable DeepSeek Harness coding model.',
      },
    ],
    selectors: codexSelectors,
  },
};

/**
 * A provider with a long model catalog: the Model row's picker gains a fuzzy
 * search field (`shouldOfferOptionSearch`, the same rule the desktop menu uses).
 * Type `54m` to see it narrow to `gpt-5.4-mini` — a substring filter would not.
 */
export const ManyModels: Story = {
  args: {
    session: codexSession,
    modelOptions: [
      { value: 'gpt-5.5', label: 'gpt-5.5' },
      { value: 'gpt-5.5-codex', label: 'gpt-5.5-codex' },
      { value: 'gpt-5.4', label: 'gpt-5.4' },
      { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { value: 'gpt-5.3', label: 'gpt-5.3' },
      { value: 'gpt-5.3-mini', label: 'gpt-5.3-mini' },
      { value: 'o5-preview', label: 'o5-preview' },
      { value: 'o5-mini', label: 'o5-mini' },
      { value: 'o4', label: 'o4' },
      { value: 'gpt-4.1', label: 'gpt-4.1' },
    ],
    selectors: codexSelectors,
  },
};

const makeRole = (overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  ownerUserId: 'user-1',
  visibility: 'private',
  machineId,
  agentConfigId: 'agent-codex' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

/**
 * The machine has no Roles yet. The row still renders and reads `None`; its
 * list is the way to make the first one, the same as the desktop row. Hiding it
 * made the control look absent.
 */
export const NoAgentRolesYet: Story = {
  args: {
    session: codexSession,
    modelOptions: codexModelOptions,
    selectors: codexSelectors,
    agentRoles: [],
  },
};

/**
 * The Role row sits above Agent, because a Role answers every row under it.
 * Mobile is the picker only: no detail pane. `None` leads the list, and an
 * unavailable Role stays listed and disabled with its reason. Long-press a Role
 * to see the existing-Session Apply / Send Instruction actions.
 */
export const WithAgentRoles: Story = {
  args: {
    session: codexSession,
    modelOptions: codexModelOptions,
    selectors: codexSelectors,
    agentRoles: [
      {
        role: makeRole({
          id: 'role-reviewer' as AgentRoleId,
          name: 'Code Reviewer',
          emoji: '🔍',
          promptPrefix: 'Review the current change for correctness before style.',
        }),
        availability: { kind: 'available' },
      },
      {
        role: makeRole({
          id: 'role-docs' as AgentRoleId,
          name: 'Docs Writer',
          emoji: '📝',
          promptPrefix: 'Update the documentation for the current change.',
        }),
        availability: { kind: 'available' },
      },
      {
        role: makeRole({
          id: 'role-gone' as AgentRoleId,
          name: 'Retired Reviewer',
          emoji: '🗑️',
          promptPrefix: 'Review the current change without applying this retired Role.',
        }),
        availability: { kind: 'unavailable', reason: 'agent_config_missing' },
      },
    ],
  },
};
