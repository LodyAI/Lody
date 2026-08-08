import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useMemo, useState } from 'react';
import { fn } from 'storybook/test';
import {
  type AgentConfigId,
  type AgentConfigMeta,
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
    configId: 'plan-mode',
    category: 'plan-mode',
    label: 'Plan mode',
    currentValue: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
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
}: {
  session: SessionMeta;
  modelOptions: AcpSessionSelectOption[];
  selectors: AcpConfigOptionSelector[];
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
