import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useMemo, useState } from 'react';
import { fn, userEvent, within } from 'storybook/test';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  AGENT_ROLE_VERSION,
  getAgentConfigRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import {
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import { resolvePermissionModeFace } from '@/lib/permission-mode-face';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import {
  doesAgentRolePinPermissionMode,
  isComposerAgentRoleApplied,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';

/**
 * The desktop composer's run-config dropdown with its second tab.
 *
 * **Detailed** is the knob-by-knob menu. **Roles** lists the Agent Roles bound
 * to the machine this chat will start on — one packaged answer to the same
 * questions — beside a pane stating what the highlighted Role actually runs,
 * because picking one authorizes exactly that. The footer names a Role only
 * while every value it pins is still what will run.
 */
const machineId = 'machine-storybook' as MachineId;
const codexId = 'agent-codex' as AgentConfigId;
const claudeId = 'agent-claude' as AgentConfigId;

const codex: AgentConfigMeta = {
  id: codexId,
  machineId,
  name: 'Codex Primary',
  description: 'Codex on zx-macbook',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};

const claude: AgentConfigMeta = {
  id: claudeId,
  machineId,
  name: 'Claude (Opus)',
  description: 'Claude Code',
  cliType: 'builtin',
  agentType: 'claude',
  env: {},
};

const agents: AgentConfigMeta[] = [codex, claude];

const modelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: '5.5', description: 'Latest frontier Codex model' },
  { value: 'gpt-5.4', label: '5.4', description: 'Frontier Codex model' },
  { value: 'gpt-5.4-mini', label: '5.4-mini', description: 'Smaller, faster Codex model' },
];

/* What a provider with a large catalog publishes — the case the Model submenu's
   fuzzy search exists for. */
const manyModelOptions: AcpSessionSelectOption[] = [
  { value: 'gpt-5.5', label: '5.5', description: 'Latest frontier Codex model' },
  { value: 'gpt-5.5-codex', label: '5.5-codex', description: 'Tuned for coding' },
  { value: 'gpt-5.4', label: '5.4', description: 'Frontier Codex model' },
  { value: 'gpt-5.4-mini', label: '5.4-mini', description: 'Smaller, faster Codex model' },
  { value: 'gpt-5.3', label: '5.3', description: 'Previous frontier model' },
  { value: 'gpt-5.3-mini', label: '5.3-mini', description: 'Previous small model' },
  { value: 'o5-preview', label: 'o5-preview', description: 'Reasoning preview' },
  { value: 'o5-mini', label: 'o5-mini', description: 'Small reasoning model' },
  { value: 'o4', label: 'o4', description: 'Older reasoning model' },
  { value: 'gpt-4.1', label: '4.1', description: 'Legacy general model' },
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
    description: 'Can edit files outside this workspace and run commands with network access.',
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
];

const makeRole = (overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  ownerUserId: 'user-storybook',
  visibility: 'private',
  machineId,
  agentConfigId: codexId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const roleItems: ComposerAgentRoleItem[] = [
  {
    role: makeRole({
      id: 'role-reviewer' as AgentRoleId,
      name: 'Code Reviewer',
      emoji: '🔍',
      promptPrefix:
        'Review the diff for correctness before style. Name the concrete failure scenario for every issue you raise.',
      runConfig: {
        modelId: 'gpt-5.5',
        modeId: 'read-only',
        configOptionValues: { reasoning_effort: 'high' },
      },
    }),
    availability: { kind: 'available' },
    agentConfig: codex,
  },
  {
    role: makeRole({
      id: 'role-docs' as AgentRoleId,
      name: 'Docs Writer',
      emoji: '📝',
      visibility: 'workspace',
      agentConfigId: claudeId,
      promptPrefix: 'Write for someone who has never seen this codebase.',
      runConfig: { modelId: 'gpt-5.4', configOptionValues: { reasoning_effort: 'medium' } },
    }),
    availability: { kind: 'available' },
    agentConfig: claude,
  },
  {
    role: makeRole({
      id: 'role-triage' as AgentRoleId,
      name: 'Bug Triage',
      emoji: '🐛',
      runConfig: {
        modelId: 'gpt-5.4-mini',
        configOptionValues: { reasoning_effort: 'low', collaboration_mode: 'plan' },
      },
    }),
    availability: { kind: 'available' },
    agentConfig: codex,
  },
  {
    role: makeRole({
      id: 'role-gone' as AgentRoleId,
      name: 'Retired Reviewer',
      emoji: '🗑️',
      agentConfigId: 'agent-removed' as AgentConfigId,
      runConfig: { modelId: 'gpt-5.1-codex' },
    }),
    // Listed, disabled, and stating its reason: a Role never re-points at
    // whichever agent config happens to be available.
    availability: { kind: 'unavailable', reason: 'agent_config_missing' },
  },
];

/* The menu calls `useOnlineMachines`, so it needs a platform in context. A
   local provider keeps the story offline; the agent pool is passed explicitly
   through `availableAgentConfigs` so it does not depend on machine presence. */
const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'user-storybook-roles', name: 'Zixuan' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      { id: 'workspace-storybook', name: 'Storybook Workspace', slug: null, role: 'owner' },
    ],
    activeWorkspaceId: 'workspace-storybook',
  }),
});

/**
 * Mirrors the landing composer: picking a Role sets the agent and every value
 * it pins, and the Role stays named only while that is still what will run.
 */
function StoryShell({
  items,
  initialRoleId = null,
  models = modelOptions,
  canSendInstruction = false,
}: {
  items: ReadonlyArray<ComposerAgentRoleItem>;
  initialRoleId?: AgentRoleId | null;
  /** Overridden by the long-list story: what an agent provider may publish. */
  models?: AcpSessionSelectOption[];
  /** Existing Sessions can send a Role's instruction without applying it. */
  canSendInstruction?: boolean;
}) {
  const store = useMemo(() => {
    const s = createStore();
    s.set(
      agentConfigMetaCacheAtom,
      Object.fromEntries(agents.map((agent) => [getAgentConfigRoomId(agent.id), agent]))
    );
    return s;
  }, []);

  const initialRole = items.find((item) => item.role.id === initialRoleId)?.role;
  const [agentSelection, setAgentSelection] = useState(() =>
    initialRole
      ? { agentId: initialRole.agentConfigId, machineId: initialRole.machineId }
      : { agentId: codexId, machineId }
  );
  const [model, setModel] = useState<string | null>(
    initialRole?.runConfig.modelId ?? models[0]?.value ?? null
  );
  const [mode, setMode] = useState<string | null>(
    initialRole?.runConfig.modeId ?? modeOptions[1]?.value ?? null
  );
  const [values, setValues] = useState<Record<string, AcpConfigOptionValue>>(() => ({
    ...Object.fromEntries(selectors.map((selector) => [selector.configId, selector.currentValue])),
    ...(initialRole?.runConfig.configOptionValues ?? {}),
  }));

  /* Mirrors production: leaving a Role clears the NAME, not the configuration,
     so a cleared Role stays cleared until something actually changes. */
  const [clearedRoleId, setClearedRoleId] = useState<AgentRoleId | null>(null);
  const matchedRole =
    items.find((item) =>
      isComposerAgentRoleApplied(item.role, {
        agentSelection,
        modeId: mode,
        modelId: model,
        configOptionValues: values,
      })
    )?.role ?? null;
  const selectedRole = matchedRole && matchedRole.id !== clearedRoleId ? matchedRole : null;
  const permissionPinnedByRole =
    selectedRole != null &&
    doesAgentRolePinPermissionMode(
      selectedRole,
      resolvePermissionModeFace({
        modeOptions,
        selectedModeId: mode,
        configOptionSelectors: selectors,
        configOptionValues: values,
      }).source
    );

  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <div className="flex min-h-dvh items-end bg-background p-8">
          {/* Mimic the composer footer row the button lives in. */}
          <div className="mb-6 flex w-full max-w-3xl items-center gap-2 rounded-xl bg-input/90 px-4 py-3">
            <DesktopRunConfigMenu
              agentSelection={agentSelection}
              availableAgentConfigs={agents}
              showAgentNameInTrigger
              onAgentConfigChange={setAgentSelection}
              modelOptions={models}
              selectedModelId={model}
              onModelChange={setModel}
              configOptionSelectors={selectors}
              configOptionValues={values}
              onConfigOptionChange={(configId, value) =>
                setValues((prev) => ({ ...prev, [configId]: value }))
              }
              modeOptions={modeOptions}
              selectedModeId={mode}
              agentRoles={{
                items,
                selectedRoleId: selectedRole?.id ?? null,
                onSelect: (roleId) => {
                  if (roleId === null) {
                    setClearedRoleId(matchedRole?.id ?? null);
                    return;
                  }
                  setClearedRoleId(null);
                  const role = items.find((item) => item.role.id === roleId)?.role;
                  if (!role) return;
                  setAgentSelection({
                    agentId: role.agentConfigId,
                    machineId: role.machineId,
                  });
                  setModel(role.runConfig.modelId ?? null);
                  setMode(role.runConfig.modeId ?? null);
                  setValues((prev) => ({ ...prev, ...(role.runConfig.configOptionValues ?? {}) }));
                },
                onCreate: fn(),
                onEdit: fn(),
                onSendInstruction: canSendInstruction ? async () => true : undefined,
              }}
            />
            {/* Mirrors the composer footer: behind a Role that pins permission,
                this button is gone and the Role's face states the value. */}
            {permissionPinnedByRole ? null : (
              <DesktopPermissionModeButton
                modeOptions={modeOptions}
                selectedModeId={mode}
                onModeChange={setMode}
                configOptionSelectors={selectors}
                configOptionValues={values}
                onConfigOptionChange={(configId, value) =>
                  setValues((prev) => ({ ...prev, [configId]: value }))
                }
              />
            )}
          </div>
        </div>
      </Provider>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Sessions/ComposerRunConfigMenu',
  component: StoryShell,
  args: { items: roleItems },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

const openMenu = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Run configuration' }));
};

const openRoleSubmenu = async (canvasElement: HTMLElement) => {
  await openMenu(canvasElement);
  await userEvent.hover(await within(document.body).findByText('Role'));
};

/** The footer button while the composer is configured knob by knob. */
export const Closed: Story = {};

/** The Role row leads the menu, because a Role answers every row under it. */
export const Menu: Story = {
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
  },
};

/** The Role submenu: recognise the Role on the left, read what it runs on the right. */
export const RoleSubmenu: Story = {
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/** An existing Session can send the highlighted Role's instruction without applying it. */
export const RoleInstructionShortcut: Story = {
  args: { canSendInstruction: true },
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/**
 * A Role the composer currently IS: the footer names it and states its values
 * beside the button, and the permission button is gone because the Role pins it.
 */
export const RoleSelected: Story = {
  args: { initialRoleId: 'role-reviewer' as AgentRoleId },
  play: async ({ canvasElement }) => {
    await openRoleSubmenu(canvasElement);
  },
};

/**
 * A Role that pins full access keeps the amber shield in the face. The rest of
 * the face is quiet because the Role decided it, but this is the one value that
 * no longer has a button of its own carrying the warning.
 */
export const RoleWithWarningPermission: Story = {
  args: {
    items: [
      {
        ...roleItems[0]!,
        role: {
          ...roleItems[0]!.role,
          name: 'Autofix',
          emoji: '\u{1F6E0}\u{FE0F}',
          runConfig: { ...roleItems[0]!.role.runConfig, modeId: 'agent-full-access' },
        },
      },
      ...roleItems.slice(1),
    ],
    initialRoleId: 'role-reviewer' as AgentRoleId,
  },
};

/**
 * A provider with a long model list: the Model submenu gains a fuzzy search row
 * that stays put while the options scroll under it. Type `54m` to see it narrow
 * to `5.4-mini` — a scroll is not a way to find one model among dozens.
 */
export const ModelSearch: Story = {
  args: { models: manyModelOptions },
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
    await userEvent.hover(await within(document.body).findByText('Model'));
  },
};

/**
 * No Roles on this machine yet: the row's value IS the way to make one, seeded
 * with whatever the rows under it are set to right now.
 */
export const NoRolesYet: Story = {
  args: { items: [] },
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
  },
};
