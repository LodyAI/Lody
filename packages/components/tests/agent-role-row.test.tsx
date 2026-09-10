// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
  DEFAULT_AGENT_ROLE_EMOJI,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import { AgentRoleRow } from '../src/components/settings/agent-roles-setting';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const role: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6-sol', configOptionValues: { thought_level: 'high' } },
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};

type RowProps = ComponentProps<typeof AgentRoleRow>;

const agentConfig: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env' | 'name'> = {
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  name: 'Codex',
};

const baseProps: RowProps = {
  role,
  availability: { kind: 'available' },
  agentConfig,
  canManage: true,
  onEdit: () => undefined,
  onRemove: () => undefined,
};

describe('AgentRoleRow', () => {
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

  const render = async (props: Partial<RowProps> = {}): Promise<HTMLDivElement> => {
    await act(async () => {
      root?.render(createElement(AgentRoleRow, { ...baseProps, ...props }));
    });
    return container as HTMLDivElement;
  };

  it('states what the role will run: model, reasoning, then the rest', async () => {
    const view = await render();
    expect(view.textContent).toContain('Code Reviewer');
    expect(view.textContent).toContain('🔍');
    expect(view.textContent).toContain('Private');
    expect(view.textContent).toContain('gpt-5.6-sol · high');
    // The mention token is derived from this very name, so printing both would
    // say one thing twice; the machine leads the group instead of each row.
    expect(view.textContent).not.toContain('@Code-Reviewer');
  });

  it('shows the default glyph when no emoji was picked', async () => {
    const view = await render({ role: { ...role, emoji: undefined } });
    expect(view.textContent).toContain(DEFAULT_AGENT_ROLE_EMOJI);
  });

  it('names a reason about the binding, and leaves the machine to its pill', async () => {
    const missing = await render({
      availability: { kind: 'unavailable', reason: 'agent_config_missing' },
      agentConfig: undefined,
    });
    expect(missing.textContent).toContain('its agent config no longer exists');
    // Still listed and still editable: nothing was substituted for it.
    expect(missing.querySelector('button[aria-label="Edit"]')).not.toBeNull();

    // The row sits under its machine's pill, which already carries that
    // machine's status; saying it again on every row in the group is noise.
    const offline = await render({
      availability: { kind: 'unavailable', reason: 'machine_offline' },
    });
    expect(offline.textContent).not.toContain('Unavailable');
    expect(offline.querySelector('button[aria-label="Edit"]')).not.toBeNull();
  });

  it('says it is still checking rather than claiming a role is broken', async () => {
    const view = await render({ availability: { kind: 'unknown' } });
    expect(view.textContent).toContain('Checking availability');
    expect(view.textContent).not.toContain('Unavailable');
  });

  it('names the agent config when a role pins no run config of its own', async () => {
    const view = await render({ role: { ...role, runConfig: {} } });
    expect(view.textContent).toContain('Codex');
  });

  it('offers no delete for a role owned by another member', async () => {
    const view = await render({
      role: { ...role, ownerUserId: 'user-2', visibility: 'workspace' },
      canManage: false,
    });
    expect(view.textContent).toContain('Workspace');
    expect(view.querySelector('button[aria-label="Remove"]')).toBeNull();
  });
});
