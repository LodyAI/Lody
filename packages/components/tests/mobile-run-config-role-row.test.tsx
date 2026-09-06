// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  AGENT_ROLE_VERSION,
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

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// The picker's virtualizer scrolls the active row into view; jsdom has no
// layout and therefore no `scrollIntoView`.
Element.prototype.scrollIntoView = () => undefined;

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

describe('MobileRunConfigSheet agent-role row', () => {
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

  it('shows missing model metadata without offering invented reasoning levels', async () => {
    const view = await render({
      selectedModelId: 'gpt-6-astra',
      configOptionSelectors: [
        {
          configId: 'reasoning_effort',
          label: 'Reasoning',
          category: 'thought_level',
          type: 'select',
          options: [],
          currentValue: '',
          perModel: true,
          hasDefault: false,
          availability: 'unknown',
        },
      ],
      configOptionValues: { reasoning_effort: 'high' },
    });
    const content = view;
    const status = content.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Reasoning levels not confirmed');
    expect(status?.textContent).toContain('Saved selection: high');
    expect(status?.textContent).toContain('Settings');
    expect(status?.querySelector('button')).toBeNull();
  });

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

  it('reports null for None — it clears the name, not the configuration', async () => {
    const onSelect = vi.fn();
    const view = await render({
      agentRoles: { items: [reviewer], selectedRoleId: reviewer.role.id, onSelect },
    });
    await openRolePicker(view);
    const noneOption = [...view.querySelectorAll('[role="dialog"] button')].find(
      (node) => node.textContent?.trim() === 'None'
    );
    await act(async () => {
      (noneOption as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('picks a Role by its stable id', async () => {
    const onSelect = vi.fn();
    const view = await render({
      agentRoles: { items: [reviewer], selectedRoleId: null, onSelect },
    });
    await openRolePicker(view);
    const option = [...view.querySelectorAll('[role="dialog"] button')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    await act(async () => {
      (option as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith('role-1');
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
});
