// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  MachineId,
  MachineViewMeta,
  ProviderSetupFailureCode,
  ProviderSetupTask,
} from '@lody/shared';

import { ProviderSetupRow } from '../src/components/settings/provider-setup-row';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => {}),
  writeClipboard: vi.fn(async () => true),
}));

vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: (text: string) => mocks.writeClipboard(text),
}));

vi.mock('../src/lib/native-browser', () => ({
  openExternalUrl: (url: string) => mocks.openExternalUrl(url),
}));

const machineId = 'machine-bub-setup' as MachineId;
const machine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.76.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
  protocolCapabilities: { providerSetup: 1 },
};
const installCommand = 'curl -fsSL https://bub.build/install.sh | bash -- --preset acp';

function createFailedBubSetup(failureCode: ProviderSetupFailureCode): ProviderSetupTask {
  const id = 'provider-setup-bub' as AgentConfigId;
  return {
    v: 1,
    id,
    machineId,
    config: {
      id,
      machineId,
      name: 'Bub',
      cliType: 'builtin',
      agentType: 'bub',
      env: {},
    },
    status: 'failed',
    failureCode,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('ProviderSetupRow Bub recovery', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    mocks.openExternalUrl.mockClear();
    mocks.writeClipboard.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderSetup = async (failureCode: ProviderSetupFailureCode) => {
    await act(async () => {
      root.render(
        <ProviderSetupRow
          setup={createFailedBubSetup(failureCode)}
          machine={machine}
          onRetry={async () => {}}
          onDelete={async () => {}}
        />
      );
    });
  };

  it('offers and copies the one-step installer when Bub is unavailable', async () => {
    await renderSetup('runtime-unavailable');

    expect(container.textContent).toContain(installCommand);
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]');
    await act(async () => {
      copy?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.writeClipboard).toHaveBeenCalledWith(installCommand);
    expect(container.querySelector('button[aria-label="Copied"]')).not.toBeNull();

    const installGuide = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Open install guide'
    );
    await act(async () => {
      installGuide?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      'https://bub.build/docs/tutorials/acp-server/?utm_source=lody'
    );
  });

  it('does not suggest reinstalling Bub for an unrelated verification failure', async () => {
    await renderSetup('verification-failed');

    expect(container.textContent).not.toContain(installCommand);
  });
});
