import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useMemo, useState } from 'react';
import { fn } from 'storybook/test';
import {
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  getAgentConfigRoomId,
} from '@lody/shared';

import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import {
  DesktopMachineMenu,
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

/**
 * The desktop composer's two consolidated footer buttons: the run-config
 * dropdown (agent / model / reasoning submenus + Plan / Fast toggles) and the
 * standalone permission-mode button — both on the standard DropdownMenu
 * surface (distinct background + layered float shadow). The full in-context
 * page is `SessionConversationPage.stories` (`DesktopIdle`).
 */
const machineId = 'machine-storybook' as MachineId;
const codexId = 'agent-codex' as AgentConfigId;

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
    id: 'agent-claude' as AgentConfigId,
    machineId,
    name: 'Claude (Opus)',
    description: 'Claude Code',
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  },
];

const modelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: '5.5', description: 'Latest frontier Codex model' },
  { value: 'gpt-5.4', label: '5.4', description: 'Frontier Codex model' },
  { value: 'gpt-5.4-mini', label: '5.4-mini', description: 'Smaller, faster Codex model' },
];

const modeOptions: AcpSessionSelectOption[] = [
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'Requires approval to edit files and run commands.',
  },
  { value: 'agent', label: 'Agent', description: 'Read and edit files, and run commands.' },
  {
    value: 'agent-full-access',
    label: 'Full access',
    description:
      'Codex can edit files outside this workspace and run commands with network access.',
  },
];

const selectors: AcpConfigOptionSelector[] = [
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
      { value: 'max', label: 'Max' },
      { value: 'ultra', label: 'Ultra' },
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
    currentValue: 'on',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
];

function StoryShell({ isEmptyConversation }: { isEmptyConversation: boolean }) {
  const store = useMemo(() => {
    const s = createStore();
    s.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(agents.map((a) => [getAgentConfigRoomId(a.id), a]))
    );
    return s;
  }, []);

  const [model, setModel] = useState<string | null>(modelOptions[0]?.value ?? null);
  const [mode, setMode] = useState<string | null>(modeOptions[0]?.value ?? null);
  const [values, setValues] = useState<Record<string, AcpConfigOptionValue>>(() =>
    Object.fromEntries(selectors.map((sel) => [sel.configId, sel.currentValue]))
  );

  return (
    <Provider store={store}>
      <div className="flex min-h-dvh items-end bg-background p-8">
        {/* Mimic the composer footer row the buttons live in. */}
        <div className="mb-6 flex w-full max-w-3xl items-center gap-2 rounded-xl bg-input/90 px-4 py-3">
          <DesktopRunConfigMenu
            agentSelection={{ agentId: codexId, machineId }}
            allowedMachineIds={[machineId]}
            agentLocked={!isEmptyConversation}
            onAgentConfigChange={fn()}
            modelOptions={modelOptions}
            selectedModelId={model}
            onModelChange={setModel}
            configOptionSelectors={selectors}
            configOptionValues={values}
            onConfigOptionChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
          />
          <DesktopPermissionModeButton
            modeOptions={modeOptions}
            selectedModeId={mode}
            onModeChange={setMode}
            configOptionSelectors={selectors}
            configOptionValues={values}
            onConfigOptionChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
          />
        </div>
      </div>
    </Provider>
  );
}

function MachineScopeShell() {
  const secondMachineId = 'machine-remote' as MachineId;
  const [selectedMachineId, setSelectedMachineId] = useState(machineId);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-8">
      <div className="flex items-center gap-2">
        <DesktopMachineMenu
          value={selectedMachineId}
          options={[
            { value: machineId, label: 'zx-macbook' },
            { value: secondMachineId, label: 'build-machine' },
          ]}
          onChange={setSelectedMachineId}
          onAddMachine={fn()}
        />
        <div className="flex h-6 items-center rounded-md bg-foreground/[0.06] px-2 text-xs font-normal text-foreground/80">
          lody
        </div>
      </div>
    </div>
  );
}

function EmptyMachineScopeShell() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-8">
      <DesktopMachineMenu value={null} options={[]} onChange={fn()} onAddMachine={fn()} />
    </div>
  );
}

const meta = {
  title: 'Sessions/DesktopRunConfigMenu',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LockedAgent: Story = { args: { isEmptyConversation: false } };
export const EmptyConversationAgentPickable: Story = { args: { isEmptyConversation: true } };
export const MachineScope: Story = {
  args: { isEmptyConversation: true },
  render: () => <MachineScopeShell />,
};
export const MachineScopeEmpty: Story = {
  args: { isEmptyConversation: true },
  render: () => <EmptyMachineScopeShell />,
};
