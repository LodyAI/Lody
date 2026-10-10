// @vitest-environment jsdom

import { act, createElement, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  AGENT_ROLE_VERSION,
  ACP_CAPABILITY_CACHE_VERSION,
  type AcpConfigOptionSummary,
  getAgentConfigRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import { agentConfigMetaCacheAtom } from '../src/atoms/doc-meta';
import { MobileRunConfigSheet } from '../src/components/mobile/mobile-run-config-sheet';
import type { ComposerAgentRoleItem } from '../src/lib/composer-agent-roles';
import { initI18n } from '../src/i18n';
import { MobileNewChatSheet } from '../src/components/mobile/mobile-new-chat-sheet';
import { MobileSessionRunConfig } from '../src/components/mobile/mobile-session-run-config';
import { buildAcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '../src/hooks/use-acp-session-config-selection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// The picker's virtualizer scrolls the active row into view; jsdom has no
// layout and therefore no `scrollIntoView`.
Element.prototype.scrollIntoView = () => undefined;
// jsdom has no pointer capture or drawer stylesheet/layout.
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;

const machineId = 'machine-1' as MachineId;
const agentConfig: AgentConfigMeta = {
  id: 'config-1' as AgentConfigId,
  machineId,
  name: 'Codex',
  description: undefined,
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};

const makeRole = (overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  ownerUserId: 'user-1',
  visibility: 'private',
  machineId,
  agentConfigId: agentConfig.id,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const reviewer: ComposerAgentRoleItem = {
  role: makeRole({ id: 'role-1' as AgentRoleId, name: 'Code Reviewer', emoji: '🔍' }),
  availability: { kind: 'available' },
  agentConfig,
};
const retired: ComposerAgentRoleItem = {
  role: makeRole({ id: 'role-2' as AgentRoleId, name: 'Retired Reviewer' }),
  availability: { kind: 'unavailable', reason: 'agent_config_missing' },
};

type SheetProps = ComponentProps<typeof MobileRunConfigSheet>;

const baseProps: SheetProps = {
  open: true,
  onOpenChange: () => undefined,
  agentSelection: { agentId: agentConfig.id, machineId },
  allowedMachineIds: [machineId],
  onAgentConfigChange: () => undefined,
  modelOptions: [{ value: 'gpt-5.5', label: '5.5' }],
  selectedModelId: 'gpt-5.5',
  onModelChange: () => undefined,
  modeOptions: [],
  selectedModeId: null,
  onModeChange: () => undefined,
  configOptionSelectors: [],
  configOptionValues: {},
  onConfigOptionChange: () => undefined,
};

describe('MobileRunConfigSheet', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  const render = async (props: Partial<SheetProps> = {}): Promise<HTMLElement> => {
    const store = createStore();
    // Seeded so the Agent row resolves a real config, the way production reads it.
    store.set(agentConfigMetaCacheAtom, { [getAgentConfigRoomId(agentConfig.id)]: agentConfig });
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(MobileRunConfigSheet, { ...baseProps, ...props })
        )
      );
    });
    // The sheet is a Drawer, so its content is portalled out of the container.
    return document.body;
  };

  const openRolePicker = async (view: HTMLElement) => {
    const trigger = [...view.querySelectorAll('button')].find(
      (node) => node.getAttribute('aria-label') === 'Role'
    );
    await act(async () => {
      (trigger as HTMLElement).click();
    });
  };

  it('has no Role row when the caller offers no Roles at all', async () => {
    const view = await render();
    expect(view.querySelector('button[aria-label="Role"]')).toBeNull();
  });

  /* An empty catalog is not "no Role control": the row reads `None`, and its
     list is the way to make the first one — the same as the desktop row. */
  it('still shows the row when the machine has no Roles yet', async () => {
    const onCreate = vi.fn();
    const view = await render({
      agentRoles: { items: [], selectedRoleId: null, onSelect: () => undefined, onCreate },
    });
    expect(view.querySelector('button[aria-label="Role"]')?.textContent).toContain('None');

    await openRolePicker(view);
    const create = [...view.querySelectorAll('[role="dialog"] button:not([aria-label])')].find(
      (node) => node.textContent?.includes('New role')
    );
    await act(async () => {
      (create as HTMLElement).click();
    });
    expect(onCreate).toHaveBeenCalled();
  });

  it('puts Role above Agent, because a Role answers every row under it', async () => {
    const view = await render({
      agentRoles: { items: [reviewer], selectedRoleId: null, onSelect: () => undefined },
    });
    const labels = [...view.querySelectorAll('button[aria-label]')].map((node) =>
      node.getAttribute('aria-label')
    );
    const role = labels.indexOf('Role');
    const agent = labels.indexOf('Agent');
    expect(role).toBeGreaterThanOrEqual(0);
    expect(agent).toBeGreaterThan(role);
  });

  it('reads as None until a Role is picked, and as the Role after', async () => {
    const none = await render({
      agentRoles: { items: [reviewer], selectedRoleId: null, onSelect: () => undefined },
    });
    expect(none.querySelector('button[aria-label="Role"]')?.textContent).toContain('None');

    const picked = await render({
      agentRoles: {
        items: [reviewer],
        selectedRoleId: reviewer.role.id,
        onSelect: () => undefined,
      },
    });
    expect(picked.querySelector('button[aria-label="Role"]')?.textContent).toContain(
      'Code Reviewer'
    );
  });

  /* jsdom has no layout, so alignment is asserted structurally: the picker only
     draws its fixed-size icon box for options that HAVE an icon, so `None`
     reserving one is what puts its label where every Role's label is. The
     TRIGGER deliberately has no such slot — it shows one value, not a column. */
  it('reserves the emoji slot for None in the list, so the labels line up', async () => {
    const view = await render({
      agentRoles: { items: [reviewer], selectedRoleId: null, onSelect: () => undefined },
    });
    await openRolePicker(view);
    // Option rows only: the row's own trigger also carries the label, and it
    // deliberately has no slot.
    const options = ['None', 'Code Reviewer'].map((label) =>
      [...view.querySelectorAll('[role="dialog"] button:not([aria-label])')].find((node) =>
        node.textContent?.includes(label)
      )
    );
    expect(options.every(Boolean)).toBe(true);
    for (const option of options) {
      expect(option?.querySelector('span.h-4.w-4')).not.toBeNull();
    }
    // The trigger shows one value, not a column, so it stays flush.
    expect(view.querySelector('button[aria-label="Role"] span.h-4.w-4')).toBeNull();
  });

  it('selects and clears a Role without changing the permission', async () => {
    function Harness() {
      const [selectedRoleId, onSelect] = useState<AgentRoleId | null>(null);
      return (
        <MobileRunConfigSheet
          {...baseProps}
          modeOptions={[{ value: 'read-only', label: 'Read-only' }]}
          selectedModeId="read-only"
          agentRoles={{ items: [reviewer], selectedRoleId, onSelect }}
        />
      );
    }
    await act(async () =>
      root?.render(
        <Provider>
          <Harness />
        </Provider>
      )
    );
    const view = document.body;
    for (const label of ['Code Reviewer', 'None']) {
      await openRolePicker(view);
      const option = [...view.querySelectorAll<HTMLButtonElement>('[role="option"] button')].find(
        (node) => node.textContent?.includes(label)
      )!;
      await act(async () => option.click());
      expect(view.querySelector('button[aria-label="Role"]')?.textContent).toContain(label);
      expect(view.querySelector('button[aria-label="Permission"]')?.textContent).toContain(
        'Read-only'
      );
    }
  });

  it('keeps an unavailable Role listed, disabled, and says why', async () => {
    const onSelect = vi.fn();
    const view = await render({
      agentRoles: { items: [reviewer, retired], selectedRoleId: null, onSelect },
    });
    await openRolePicker(view);
    const option = [...view.querySelectorAll('[role="dialog"] button')].find((node) =>
      node.textContent?.includes('Retired Reviewer')
    );
    expect(option).toBeDefined();
    expect((option as HTMLButtonElement).disabled).toBe(true);
    expect(option?.textContent).toContain('its agent config no longer exists');
    await act(async () => {
      (option as HTMLElement).click();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  const selectOption = (
    id: string,
    category: string,
    values: string[]
  ): AcpConfigOptionSummary => ({
    id,
    category,
    name: id === 'permission' ? 'Permission' : id,
    type: 'select',
    currentValue: values[0],
    options: values.map((value) => ({ value, name: value })),
  });

  // Synthetic schemas for builtins without a static catalog. Keep runtime IDs,
  // but never copy a user's catalog/model routes into the repository.
  const runtimeOptions: Record<string, AcpConfigOptionSummary[]> = {
    dimcode: [
      selectOption('mode', 'mode', ['agent', 'goal']),
      selectOption('model', 'model', ['model-a', 'model-b']),
      selectOption('permission', 'permission', ['workspace-write', 'read-only', 'full-access']),
      selectOption('thought_level', 'thought_level', ['low', 'high']),
    ],
    devin: [
      selectOption('mode', 'mode', ['accept-edits', 'ask', 'plan', 'bypass']),
      selectOption('model', 'model', ['model-a', 'model-b']),
    ],
    pi: [
      selectOption('model', 'model', ['model-a', 'model-b']),
      selectOption('thinking', 'thought_level', ['off', 'high']),
    ],
  };

  function NewChatHarness({ agentType }: { agentType: string }) {
    const controller = useAcpSessionConfigSelectionState({
      targetKey: agentType,
      preferenceRevision: agentType,
      preferences: {},
    });
    const configOptions = runtimeOptions[agentType];
    const options = buildAcpSelectorOptions({
      cliType: 'builtin',
      agentType,
      configId: agentConfig.id,
      selectedModeId: controller.candidates.modeId,
      selectedModelId: controller.candidates.modelId,
      configOptionValues: controller.candidates.configOptionValues,
      machine: configOptions
        ? {
            acpCapabilities: {
              [agentConfig.id]: {
                cliType: 'builtin',
                agentType,
                cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
                provenance: 'runtime',
                fetchedAt: 1,
                configOptions,
                modes: (configOptions.find((option) => option.id === 'mode')?.options ?? []).map(
                  (option) => ({ id: option.value, name: option.name })
                ),
                models: [],
              },
            },
          }
        : undefined,
    });
    const resolved = useResolvedAcpSessionConfigSelection(controller.selection, options);
    return (
      <>
        <output data-testid="selection">{JSON.stringify(resolved)}</output>
        <MobileNewChatSheet
          open
          onOpenChange={() => undefined}
          composer={
            <MobileSessionRunConfig
              agentSelection={null}
              {...options}
              {...resolved}
              onModelChange={controller.selectModel}
              onModeChange={controller.selectMode}
              onConfigOptionChange={controller.selectConfigOption}
            />
          }
        />
      </>
    );
  }

  const pressOption = async (trigger: HTMLButtonElement, target: HTMLButtonElement) => {
    document.querySelectorAll<HTMLElement>('[data-vaul-drawer]').forEach((drawer) => {
      drawer.style.transform = 'none';
    });
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    // Assert before release: exit animation can otherwise keep a closing option
    // clickable long enough for a click-only test to hide the regression.
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      target.click();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  };

  it.each(['claude', 'codex', 'kimi', 'grok', 'deepseek', 'dimcode', 'devin'])(
    'retains %s permission choices across pointer-down and reopening the new-chat picker',
    async (agentType) => {
      await act(async () =>
        root?.render(
          <Provider>
            <NewChatHarness agentType={agentType} />
          </Provider>
        )
      );
      await act(async () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Run configuration"]')!.click()
      );
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Permission"]')!;
      const before = document.querySelector('[data-testid="selection"]')!.textContent;
      await act(async () => trigger.click());
      const target = [...document.querySelectorAll('[role="option"]')]
        .find((node) => node.getAttribute('aria-selected') === 'false')!
        .querySelector<HTMLButtonElement>('button')!;
      const label = target.textContent!;
      await pressOption(trigger, target);
      expect(label).toContain(trigger.textContent!.trim());
      expect(document.querySelector('[data-testid="selection"]')!.textContent).not.toBe(before);
      if (agentType === 'dimcode') {
        const selection = JSON.parse(
          document.querySelector('[data-testid="selection"]')!.textContent!
        );
        expect(selection.selectedModeId).toBe('agent');
        expect(selection.configOptionValues.permission).toBe('read-only');
      }
      const selectedLabel = trigger.textContent;
      await act(async () => trigger.click());
      const selected = document.querySelector('[role="option"][aria-selected="true"]');
      expect(selected?.textContent).toContain(selectedLabel!.trim());
      expect(document.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(1);
    }
  );

  it('does not invent a permission picker for Pi', async () => {
    await act(async () =>
      root?.render(
        <Provider>
          <NewChatHarness agentType="pi" />
        </Provider>
      )
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Run configuration"]')!.click()
    );
    expect(document.querySelector('button[aria-label="Permission"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Model"]')).not.toBeNull();
  });

  it.each(['permission', 'agent', 'role', 'model', 'interaction', 'reasoning'])(
    'keeps provider config id %s independent of built-in controls',
    async (configId) => {
      function Harness() {
        const [value, setValue] = useState('first');
        return (
          <MobileRunConfigSheet
            {...baseProps}
            agentRoles={{ items: [reviewer], selectedRoleId: null, onSelect: () => undefined }}
            modelOptions={[{ value: 'model', label: 'Model' }]}
            selectedModelId="model"
            modeOptions={[{ value: 'read-only', label: 'Read-only' }]}
            selectedModeId="read-only"
            configOptionSelectors={[
              {
                configId,
                category: 'custom',
                type: 'select',
                label: 'Provider setting',
                currentValue: 'first',
                options: [
                  { value: 'first', label: 'First' },
                  { value: 'second', label: 'Second' },
                ],
              },
              {
                configId: 'interaction_mode',
                category: 'mode',
                type: 'select',
                label: 'Interaction',
                currentValue: 'agent',
                options: [{ value: 'agent', label: 'Agent' }],
              },
              {
                configId: 'thought_level',
                category: 'thought_level',
                type: 'select',
                label: 'Thinking',
                currentValue: 'low',
                options: [{ value: 'low', label: 'Low' }],
              },
            ]}
            configOptionValues={{ [configId]: value }}
            onConfigOptionChange={(_, next) => setValue(String(next))}
          />
        );
      }
      const store = createStore();
      store.set(agentConfigMetaCacheAtom, { [getAgentConfigRoomId(agentConfig.id)]: agentConfig });
      await act(async () =>
        root?.render(
          <Provider store={store}>
            <Harness />
          </Provider>
        )
      );
      const trigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Provider setting"]'
      )!;
      await act(async () => trigger.click());
      expect(document.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(1);
      const target = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="option"] button'),
      ].find((node) => node.textContent === 'Second')!;
      await pressOption(trigger, target);
      expect(trigger.textContent).toBe('Second');
      expect(document.querySelector('button[aria-label="Permission"]')?.textContent).toContain(
        'Read-only'
      );
    }
  );
});
