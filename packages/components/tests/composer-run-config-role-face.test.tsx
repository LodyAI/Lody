// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

// The menu resolves its default agent pool from machine presence; this surface
// passes `availableAgentConfigs` instead, so the pool is not what is under test.
vi.mock('../src/hooks/use-online-machines', () => ({ useOnlineMachines: () => [] }));

import { DesktopRunConfigMenu } from '../src/components/sessions/desktop-run-config-menu';
import type { ComposerAgentRoleItem } from '../src/lib/composer-agent-roles';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const agentConfig: AgentConfigMeta = {
  id: 'config-1' as AgentConfigId,
  machineId,
  name: 'Codex Primary',
  description: undefined,
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};

const role: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId,
  agentConfigId: agentConfig.id,
  runConfig: { modelId: 'gpt-5.5', modeId: 'read-only' },
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const roleItem: ComposerAgentRoleItem = {
  role,
  availability: { kind: 'available' },
  agentConfig,
};

type MenuProps = ComponentProps<typeof DesktopRunConfigMenu>;

const baseProps: MenuProps = {
  agentSelection: { agentId: agentConfig.id, machineId },
  availableAgentConfigs: [agentConfig],
  showAgentNameInTrigger: true,
  modelOptions: [{ value: 'gpt-5.5', label: '5.5' }],
  selectedModelId: 'gpt-5.5',
  modeOptions: [
    { value: 'read-only', label: 'Read-only' },
    { value: 'agent', label: 'Agent' },
  ],
  selectedModeId: 'read-only',
  onAgentConfigChange: () => undefined,
  onModelChange: () => undefined,
  configOptionSelectors: [],
  configOptionValues: {},
  onConfigOptionChange: () => undefined,
};

describe('DesktopRunConfigMenu role face', () => {
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

  const render = async (props: Partial<MenuProps> = {}): Promise<HTMLDivElement> => {
    await act(async () => {
      root?.render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(DesktopRunConfigMenu, { ...baseProps, ...props })
        )
      );
    });
    return container as HTMLDivElement;
  };

  it('names the agent and its values together when no Role is selected', async () => {
    const view = await render();
    const trigger = view.querySelector('button[aria-label="Run configuration"]');
    expect(trigger?.textContent).toContain('Codex Primary');
    expect(trigger?.textContent).toContain('5.5');
  });

  it('keeps the menu closed and explains when a machine must be selected first', async () => {
    const disabledReason = 'Select a machine first';
    const view = await render({ disabledReason });
    const trigger = view.querySelector<HTMLButtonElement>('button[aria-label="Run configuration"]');
    expect(trigger?.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await act(async () => {
      trigger?.focus();
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(disabledReason);
    });
  });

  it('gives the button to the Role alone and leaves its values inert beside it', async () => {
    const view = await render({
      agentRoles: { items: [roleItem], selectedRoleId: role.id, onSelect: () => undefined },
    });
    const trigger = view.querySelector('button[aria-label="Run configuration"]');
    // The Role IS the whole run configuration, so it is the only thing to click.
    expect(trigger?.textContent).toContain('Code Reviewer');
    expect(trigger?.textContent).not.toContain('Codex Primary');
    expect(trigger?.textContent).not.toContain('5.5');

    // Its values are still stated — outside the button, and outside every other
    // control: changing one by hand is what stops the configuration being that
    // Role, so it must not be a knob sitting next to the Role's own name.
    expect(view.textContent).toContain('5.5');
    const valueFace = [...view.querySelectorAll('span')].find(
      (node) => node.textContent === '5.5' || node.textContent?.startsWith('5.5')
    );
    expect(valueFace?.closest('button')).toBeNull();
  });

  it('states the permission the Role pins, since it is part of what was picked', async () => {
    const view = await render({
      agentRoles: { items: [roleItem], selectedRoleId: role.id, onSelect: () => undefined },
    });
    const trigger = view.querySelector('button[aria-label="Run configuration"]');
    expect(trigger?.textContent).not.toContain('Read-only');
    // Beside the button, with the rest of the values the Role decided — the
    // composer drops its own permission button while a Role pins it.
    expect(view.textContent).toContain('Read-only');
  });

  it('leaves permission out of the face when the Role does not pin it', async () => {
    const view = await render({
      agentRoles: {
        items: [{ ...roleItem, role: { ...role, runConfig: { modelId: 'gpt-5.5' } } }],
        selectedRoleId: role.id,
        onSelect: () => undefined,
      },
    });
    expect(view.textContent).not.toContain('Read-only');
  });

  const openMenu = async (view: HTMLElement) => {
    // Radix opens the menu on pointerdown, not click.
    await act(async () => {
      view
        .querySelector('button[aria-label="Run configuration"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    return document.querySelector('[role="menu"]') as HTMLElement;
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
    const content = await openMenu(view);
    const status = content.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Reasoning levels not confirmed');
    expect(status?.textContent).toContain('Saved selection: high');
    expect(status?.textContent).toContain('Settings');
    expect(status?.querySelector('button')).toBeNull();
  });

  it('leads the menu with the Role row, above the rows a Role answers', async () => {
    const view = await render({
      agentRoles: { items: [roleItem], selectedRoleId: role.id, onSelect: () => undefined },
    });
    const menu = await openMenu(view);
    const rows = [...menu.querySelectorAll('[role="menuitem"]')].map((node) =>
      node.textContent?.trim()
    );
    const roleRow = rows.findIndex((text) => text?.startsWith('Role'));
    const agentRow = rows.findIndex((text) => text?.startsWith('Agent'));
    expect(roleRow).toBeGreaterThanOrEqual(0);
    expect(agentRow).toBeGreaterThan(roleRow);
    // The row states which Role, so the menu never opens denying its own face.
    expect(rows[roleRow]).toContain('Code Reviewer');
  });

  it('turns the Role row value into the way to make one when there are none', async () => {
    const onCreate = vi.fn();
    const view = await render({
      agentRoles: { items: [], selectedRoleId: null, onSelect: () => undefined, onCreate },
    });
    const menu = await openMenu(view);
    const roleRow = [...menu.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.trim().startsWith('Role')
    );
    expect(roleRow?.textContent).toContain('New role');
    await act(async () => {
      (roleRow as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalled();
  });

  it('drops the Role face as soon as the selection is no longer that Role', async () => {
    const view = await render({
      agentRoles: { items: [roleItem], selectedRoleId: null, onSelect: () => undefined },
    });
    const trigger = view.querySelector('button[aria-label="Run configuration"]');
    expect(trigger?.textContent).toContain('Codex Primary');
    expect(trigger?.textContent).not.toContain('Code Reviewer');
  });
});
