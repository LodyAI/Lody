// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
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
type RowTarget = RowProps['targets'][number];

const agentConfig: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env' | 'name'> = {
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  name: 'Codex',
};

const target = (overrides: Partial<RowTarget> = {}): RowTarget => ({
  machineId: 'machine-1' as MachineId,
  label: 'MacBook',
  online: true,
  availability: { kind: 'available' },
  runConfig: role.runConfig,
  agentConfig,
  ...overrides,
});

const linux = target({ machineId: 'machine-2' as MachineId, label: 'Linux box', online: false });

const baseProps: RowProps = {
  role,
  targets: [target()],
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

  it('names a reason about the binding, and leaves the machine to its dot', async () => {
    const missing = await render({
      targets: [
        target({
          availability: { kind: 'unavailable', reason: 'agent_config_missing' },
          agentConfig: undefined,
        }),
      ],
    });
    expect(missing.textContent).toContain('its agent config no longer exists');
    // Still listed and still editable: nothing was substituted for it.
    expect(missing.querySelector('button[aria-label="Edit"]')).not.toBeNull();

    // The machine's dot already carries its status; saying it again is noise.
    const offline = await render({
      targets: [
        target({ online: false, availability: { kind: 'unavailable', reason: 'machine_offline' } }),
      ],
    });
    expect(offline.textContent).not.toContain('Unavailable');
    expect(offline.textContent).toContain('offline');
    expect(offline.querySelector('button[aria-label="Edit"]')).not.toBeNull();
  });

  it('says it is still checking rather than claiming a role is broken', async () => {
    const view = await render({ targets: [target({ availability: { kind: 'unknown' } })] });
    expect(view.textContent).toContain('Checking availability');
    expect(view.textContent).not.toContain('Unavailable');
  });

  it('offers no delete for a role owned by another member', async () => {
    const view = await render({
      role: { ...role, ownerUserId: 'user-2', visibility: 'workspace' },
      canManage: false,
    });
    expect(view.textContent).toContain('Workspace');
    expect(view.querySelector('button[aria-label="Remove"]')).toBeNull();
  });

  it('says the role is configured per machine instead of picking one summary', async () => {
    const view = await render({
      targets: [target(), { ...linux, runConfig: { modelId: 'luna' } }],
    });
    expect(view.textContent).toContain('Configured per machine');
    expect(view.textContent).not.toContain('gpt-5.6-sol');
  });
});
