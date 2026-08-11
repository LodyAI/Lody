// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, AgentConfigMeta, MachineId, MachineViewMeta } from '@lody/shared';

import { ProviderRow } from '../src/components/settings/provider-row';
import { initI18n } from '../src/i18n';

vi.mock('../src/components/settings/acp-authentication-panel', () => ({
  AcpAuthenticationPanel: ({ reauthentication }: { reauthentication?: boolean }) => (
    <button type="button" data-reauthentication={String(reauthentication)}>
      Sign in again
    </button>
  ),
}));

const machineId = 'machine-test' as MachineId;
const machine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.76.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
};

const makeConfig = (
  overrides: Pick<AgentConfigMeta, 'cliType' | 'agentType'>
): AgentConfigMeta => ({
  id: `config-${overrides.agentType}` as AgentConfigId,
  machineId,
  name: overrides.agentType,
  env: {},
  ...overrides,
});

describe('ProviderRow reauthentication', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const renderConfig = async (config: AgentConfigMeta) => {
    await act(async () => {
      root.render(
        <ProviderRow config={config} machine={machine} onEdit={vi.fn()} onRefresh={vi.fn()} />
      );
    });
  };

  it.each(['claude', 'codex', 'kimi'] as const)(
    'offers Sign in again for the built-in %s provider',
    async (agentType) => {
      await renderConfig(makeConfig({ cliType: 'builtin', agentType }));

      const button = container.querySelector<HTMLButtonElement>(
        'button[data-reauthentication="true"]'
      );
      expect(button?.textContent).toContain('Sign in again');
    }
  );

  it('does not offer provider-owned login for registry agents', async () => {
    await renderConfig(makeConfig({ cliType: 'registry', agentType: 'auggie' }));

    expect(container.querySelector('button[data-reauthentication]')).toBeNull();
  });
});
