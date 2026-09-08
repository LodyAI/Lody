import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useMemo, useState } from 'react';
import { fn } from 'storybook/test';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  getAgentConfigRoomId,
} from '@lody/shared';

import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import { DesktopRunConfigMenu } from '@/components/sessions/desktop-run-config-menu';
import type { RecentRunConfigItem } from '@/components/sessions/recent-run-config-menu-group';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

/**
 * The "Recently used" group at the top of the desktop run-config dropdown.
 *
 * Each row is one whole combination the user actually started a chat with, so
 * a frequent second setup ("Claude on Opus, high reasoning") is one click away
 * instead of three submenus. The caller has already removed the entry matching
 * the current selection and capped the list, so a user who only ever runs one
 * configuration sees no section at all — that is the `NoRecents` story.
 *
 * Open the button in the footer row to see the group.
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
  {
    id: 'agent-grok' as AgentConfigId,
    machineId,
    name: 'Grok',
    description: 'Official Grok runtime',
    cliType: 'builtin',
    agentType: 'grok',
    env: {},
  },
];

const claudeAgent = agents[1]!;
const grokAgent = agents[2]!;

const modelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: '5.5', description: 'Latest frontier Codex model' },
  { value: 'gpt-5.4', label: '5.4', description: 'Frontier Codex model' },
  { value: 'gpt-5.4-mini', label: '5.4-mini', description: 'Smaller, faster Codex model' },
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
    ],
  },
  {
    type: 'boolean',
    configId: 'plan_mode',
    category: 'plan_mode',
    label: 'Collaboration mode',
    currentValue: false,
    options: [],
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

/* The three entries a caller would hand over after filtering: a Role, the same
   agent with a different model, and a plan/fast variant. A Role IS one of these
   combinations, so it belongs in this list — leading with its own mark and
   name, since that is what picking the row does. */
const threeRecents: RecentRunConfigItem[] = [
  {
    id: 'recent-role-reviewer',
    agent: agents[0]!,
    role: { name: 'Code Reviewer', emoji: '\u{1F50D}' },
    modelLabel: '5.5',
    reasoningLabel: 'High',
    planOn: false,
    fastOn: false,
  },
  {
    id: 'recent-claude-opus-high',
    agent: claudeAgent,
    modelLabel: 'Opus 5',
    reasoningLabel: 'High',
    planOn: false,
    fastOn: true,
  },
  {
    id: 'recent-codex-55-xhigh',
    agent: agents[0]!,
    modelLabel: '5.5',
    reasoningLabel: 'XHigh',
    planOn: true,
    fastOn: false,
  },
  {
    id: 'recent-grok-build',
    agent: grokAgent,
    modelLabel: 'Grok Build',
    reasoningLabel: null,
    planOn: false,
    fastOn: false,
  },
];

/* The menu calls `useOnlineMachines`, so it needs a platform in context. A
   local provider keeps the story offline; the agent pool is passed explicitly
   through `availableAgentConfigs` so it does not depend on machine presence. */
const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'user-storybook-recents', name: 'Zixuan' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      {
        id: 'workspace-storybook',
        name: 'Storybook Workspace',
        slug: null,
        role: 'owner',
      },
    ],
    activeWorkspaceId: 'workspace-storybook',
  }),
});

function StoryShell({ recents }: { recents: ReadonlyArray<RecentRunConfigItem> }) {
  const store = useMemo(() => {
    const s = createStore();
    s.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(agents.map((a) => [getAgentConfigRoomId(a.id), a]))
    );
    return s;
  }, []);

  const [model, setModel] = useState<string | null>(modelOptions[0]?.value ?? null);
  const [values, setValues] = useState<Record<string, AcpConfigOptionValue>>(() =>
    Object.fromEntries(selectors.map((sel) => [sel.configId, sel.currentValue]))
  );

  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <div className="flex min-h-dvh items-end bg-background p-8">
          {/* Mimic the composer footer row the button lives in. */}
          <div className="mb-6 flex w-full max-w-3xl items-center gap-2 rounded-xl bg-input/90 px-4 py-3">
            <DesktopRunConfigMenu
              agentSelection={{ agentId: codexId, machineId }}
              availableAgentConfigs={agents}
              showAgentNameInTrigger
              onAgentConfigChange={fn()}
              modelOptions={modelOptions}
              selectedModelId={model}
              onModelChange={setModel}
              configOptionSelectors={selectors}
              configOptionValues={values}
              onConfigOptionChange={(configId, value) =>
                setValues((prev) => ({ ...prev, [configId]: value }))
              }
              recentRunConfigs={recents}
              onRecentRunConfigSelect={fn()}
            />
          </div>
        </div>
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Sessions/RecentRunConfigs',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The full case: three combinations, covering fast, plan, and neither. */
export const ThreeRecents: Story = {
  args: { recents: threeRecents },
};

/** One alternative configuration — the common case for a two-agent user. */
export const SingleRecent: Story = {
  args: { recents: [threeRecents[0]!] },
};

/**
 * A user who only ever runs one configuration. Everything the caller had was
 * identical to the current selection, so no label, rows, or separator render
 * and the menu looks exactly as it does today.
 */
export const NoRecents: Story = {
  args: { recents: [] },
};

/**
 * Long agent and model names. The brand icon already identifies the agent, so
 * the name truncates first and the model/reasoning suffix stays readable.
 */
export const LongLabels: Story = {
  args: {
    recents: [
      {
        id: 'recent-long',
        agent: {
          ...claudeAgent,
          name: 'Claude Code (work account, extended context)',
        },
        modelLabel: 'claude-opus-5-20260514-preview',
        reasoningLabel: 'XHigh',
        planOn: true,
        fastOn: true,
      },
      threeRecents[2]!,
    ],
  },
};
