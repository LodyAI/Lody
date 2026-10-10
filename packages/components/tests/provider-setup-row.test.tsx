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

describe('ProviderSetupRow installation recovery', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    mocks.openExternalUrl.mockClear();
    mocks.writeClipboard.mockReset();
    mocks.writeClipboard.mockResolvedValue(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderSetup = async (failureCode: ProviderSetupFailureCode, agentType = 'bub') => {
    const setup = createFailedBubSetup(failureCode);
    setup.config = { ...setup.config, agentType, name: agentType };
    await act(async () => {
      root.render(
        <ProviderSetupRow
          setup={setup}
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

  it.each([true, false])('shows Dimcode copy feedback only on success: %s', async (success) => {
    mocks.writeClipboard.mockResolvedValue(success);
    await renderSetup('runtime-unavailable', 'dimcode');

    expect(container.querySelector('code')?.textContent).toBe('npm install -g dimcode');
    expect(container.textContent).toContain(
      'dimcode not detected. Install it with npm install -g dimcode'
    );
    expect(container.textContent).not.toContain('Open install guide');
    expect(container.textContent).not.toContain('This runtime is not available');
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]');
    expect(copy).not.toBeNull();
    await act(async () => {
      copy?.click();
    });
    expect(mocks.writeClipboard).toHaveBeenCalledWith('npm install -g dimcode');
    expect(container.querySelector('button[aria-label="Copied"]') !== null).toBe(success);
    expect(container.querySelector('button[aria-label="Copy"]') !== null).toBe(!success);
  });

  it('keeps unrelated Dimcode verification failures visible without an installation command', async () => {
    await renderSetup('verification-failed', 'dimcode');
    expect(container.textContent).toContain('Provider verification failed. Try again.');
    expect(container.querySelector('code')).toBeNull();
  });
});
