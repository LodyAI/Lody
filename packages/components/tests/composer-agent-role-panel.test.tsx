// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
  DEFAULT_AGENT_ROLE_EMOJI,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import { ComposerAgentRolePanel } from '../src/components/sessions/composer-agent-role-panel';
import type { ComposerAgentRoleItem } from '../src/lib/composer-agent-roles';
import { DropdownMenu, DropdownMenuContent } from '../src/ui/dropdown-menu';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const makeRole = (overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  ownerUserId: 'user-1',
  visibility: 'private',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const reviewer: ComposerAgentRoleItem = {
  role: makeRole({
    id: 'r-1' as AgentRoleId,
    name: 'Code Reviewer',
    emoji: '🔍',
    promptPrefix: 'Review the diff for correctness before style.',
    runConfig: {
      modelId: 'gpt-5.6-sol',
      modeId: 'plan',
      configOptionValues: { thought_level: 'high', fast_mode: false },
    },
  }),
  availability: { kind: 'available' },
  agentConfig: { name: 'Codex', cliType: 'builtin', agentType: 'codex', env: {} },
};

type PanelProps = ComponentProps<typeof ComposerAgentRolePanel>;

describe('ComposerAgentRolePanel', () => {
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

  /* The panel lives inside the run-config dropdown, and its rows are menu items,
     so it is rendered in an open menu rather than bare. */
  const render = async (props: Partial<PanelProps> = {}): Promise<HTMLElement> => {
    await act(async () => {
      root?.render(
        createElement(
          DropdownMenu,
          { open: true },
          createElement(
            DropdownMenuContent,
            null,
            createElement(ComposerAgentRolePanel, {
              items: [reviewer],
              selectedRoleId: null,
              onSelect: () => undefined,
              ...props,
            })
          )
        )
      );
    });
    return document.body;
  };

  it('states the whole binding a Role would run, not just its name', async () => {
    const view = await render();
    expect(view.textContent).toContain('Code Reviewer');
    expect(view.textContent).toContain('🔍');
    expect(view.textContent).toContain('Codex');
    // Resolved against the bound agent's own capabilities: the Role stores the
    // id, the pane shows the label that agent publishes for it.
    expect(view.textContent).toContain('5.6-Sol');
    expect(view.textContent).toContain('plan');
    expect(view.textContent).toContain('high');
    // Nothing the Role did not pin: this agent publishes a reasoning selector,
    // but a Role that stored no value for it must not show that agent's own.
    expect(view.textContent).not.toContain('Medium');
    // The instruction itself, because what it SAYS is what decides whether this
    // is the Role you meant.
    expect(view.textContent).toContain('Review the diff for correctness before style.');
  });

  it('shows a stored id as it stands when the agent has no label for it', async () => {
    const view = await render({
      items: [
        {
          ...reviewer,
          role: { ...reviewer.role, runConfig: { modelId: 'model-the-agent-dropped' } },
        },
      ],
    });
    expect(view.textContent).toContain('model-the-agent-dropped');
  });

  it('falls back to the shared glyph so every row reads the same', async () => {
    const view = await render({
      items: [{ ...reviewer, role: { ...reviewer.role, emoji: undefined } }],
    });
    expect(view.textContent).toContain(DEFAULT_AGENT_ROLE_EMOJI);
  });

  it('picks a Role by its stable id', async () => {
    const onSelect = vi.fn();
    const view = await render({ onSelect });
    const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    await act(async () => {
      (row as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith('r-1');
  });

  it('offers leaving the Role as its own row', async () => {
    const onSelect = vi.fn();
    const view = await render({ selectedRoleId: 'r-1' as AgentRoleId, onSelect });
    const none = [...view.querySelectorAll('[role="menuitemradio"]')].find(
      (node) => node.textContent === 'None'
    );
    await act(async () => {
      (none as HTMLElement).click();
    });
    // null, not "some other Role": it clears the name, not the configuration.
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  // The Role row turns into a create action instead of opening this submenu
  // when the machine has no Roles, so this list is never empty in production.
  it('renders nothing rather than an empty two-pane shell', async () => {
    const view = await render({ items: [] });
    expect(view.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  it('offers making another Role from the list', async () => {
    const onCreate = vi.fn();
    const view = await render({ onCreate });
    const create = [...view.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('New role')
    );
    await act(async () => {
      (create as HTMLElement).click();
    });
    expect(onCreate).toHaveBeenCalled();
  });

  it('offers editing the Role whose configuration it is showing', async () => {
    const onEdit = vi.fn();
    const view = await render({ onEdit });
    const edit = [...view.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Edit role')
    );
    await act(async () => {
      (edit as HTMLElement).click();
    });
    expect(onEdit).toHaveBeenCalledWith('r-1');
  });

  it('keeps an unavailable Role listed, disabled, and says why', async () => {
    const onSelect = vi.fn();
    const view = await render({
      items: [
        {
          ...reviewer,
          availability: { kind: 'unavailable', reason: 'machine_offline' },
        },
      ],
      onSelect,
    });
    const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    expect(row).not.toBeUndefined();
    expect(row?.getAttribute('data-disabled')).not.toBeNull();
    // Unlike the Settings list there is no machine heading above these rows to
    // carry that status, so the reason has to be stated here.
    expect(view.textContent).toContain('its machine is offline');
    await act(async () => {
      (row as HTMLElement).click();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('says it is still checking rather than claiming a Role is broken', async () => {
    const view = await render({
      items: [{ ...reviewer, availability: { kind: 'unknown' } }],
    });
    const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    expect(view.textContent).toContain('Checking availability');
    expect(view.textContent).not.toContain('Unavailable');
    expect(row?.getAttribute('data-disabled')).not.toBeNull();
  });
});
