// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';
import {
  MachineDetailPane,
  MachineProvidersSection,
} from '../src/components/settings/machine-detail-pane';

import { initI18n } from '../src/i18n';
import { Tooltip } from '@lody/ui/tooltip';

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ requestAuthRecovery: vi.fn() }),
}));

const machine: MachineViewMeta = {
  id: 'machine-test' as MachineId,
  name: 'MacBook Pro',
  cliVersion: '0.57.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
  ownerUserId: 'user-1',
};

const findRevokeTrigger = (): HTMLButtonElement => {
  const button = document.body.querySelector<HTMLButtonElement>(
    'button[aria-label="Revoke machine access"]'
  );
  if (!button) throw new Error('Expected the header revoke button');
  return button;
};

const findConfirmDialog = (): HTMLElement => {
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  if (!dialog) throw new Error('Expected the revoke confirm dialog');
  return dialog;
};

const findConfirmButton = (dialog: HTMLElement): HTMLButtonElement => {
  const button = Array.from(dialog.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === 'Revoke machine access'
  );
  if (!button) throw new Error('Expected the revoke confirm button');
  return button;
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('MachineDetailPane revoke machine access', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  const renderPane = async (
    onRevokeCredentials: () => Promise<void>,
    options?: {
      readOnly?: boolean;
      canDelete?: boolean;
      onDelete?: (machine: MachineViewMeta) => Promise<void>;
    }
  ) => {
    await act(async () => {
      root?.render(
        <Tooltip.Provider>
          <MachineDetailPane
            machine={machine}
            readOnly={options?.readOnly}
            configs={[]}
            isOwn
            isLocal
            ownerName={null}
            sharedWithTeam={false}
            canDelete={options?.canDelete ?? false}
            onRename={vi.fn(async () => {})}
            onDelete={options?.onDelete ?? vi.fn(async () => {})}
            onSharedWithTeamChange={vi.fn(async () => {})}
            onAddConfig={vi.fn()}
            onEditConfig={vi.fn()}
            canRevokeCredentials
            onRevokeCredentials={onRevokeCredentials}
          />
        </Tooltip.Provider>
      );
    });
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps the confirm dialog open when revoking fails', async () => {
    const onRevokeCredentials = vi.fn(async () => {
      throw new Error('auth expired');
    });
    await renderPane(onRevokeCredentials);

    await click(findRevokeTrigger());
    const dialog = findConfirmDialog();
    await click(findConfirmButton(dialog));

    await vi.waitFor(() => expect(onRevokeCredentials).toHaveBeenCalledTimes(1));
    // The rejection must not close the dialog — the machine is still not revoked.
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Revoke machine access?');
  });

  it('removes an offline owned machine from the current workspace after confirmation', async () => {
    const onDelete = vi.fn(async () => {});
    await renderPane(
      vi.fn(async () => {}),
      { canDelete: true, onDelete }
    );

    const removeButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove from workspace"]'
    );
    if (!removeButton) throw new Error('Expected the remove-from-workspace button');
    await click(removeButton);

    const dialog = findConfirmDialog();
    expect(dialog.textContent).toContain('Remove machine from workspace?');
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Remove'
    );
    if (!confirmButton) throw new Error('Expected the remove confirmation button');
    await click(confirmButton);

    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith(machine));
  });

  it('does not expose owner mutations on the workspace Machines surface', async () => {
    await renderPane(
      vi.fn(async () => {}),
      { readOnly: true }
    );

    expect(document.body.querySelector('button[aria-label="Edit machine name"]')).toBeNull();
    expect(
      document.body.querySelector('[aria-label="Share MacBook Pro with the team"]')
    ).toBeNull();
    expect(document.body.querySelector('button[aria-label="Revoke machine access"]')).toBeNull();
    expect(document.body.querySelector('button[aria-label="Remove from workspace"]')).toBeNull();
  });
});

describe('advanced daemon identity restore', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await initI18n();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it.each([false, true])(
    'keeps recovery folded, preserves empty selection and scopes the pairing notice (encrypted=%s)',
    async (encryptedWorkspace) => {
      const { MachineIdentityRestore } =
        await import('../src/components/settings/machine-identity-restore');
      await act(async () =>
        root.render(
          <MachineIdentityRestore
            machine={machine}
            encryptedWorkspace={encryptedWorkspace}
            candidates={[]}
            onRestore={async () => {
              throw new Error('must not run');
            }}
          />
        )
      );
      expect(document.body.textContent).not.toContain('Choose old identity');
      const advanced = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Advanced settings')
      );
      if (!advanced) throw new Error('Missing advanced recovery trigger');
      await click(advanced);
      const choose = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Choose old identity'
      );
      if (!choose) throw new Error('Missing recovery action');
      await click(choose);
      const dialog = findConfirmDialog();
      expect(dialog.textContent).toContain('no machine is running with the old identity');
      expect(dialog.textContent).toContain('Current machine name');
      expect(dialog.textContent?.includes('Encrypted workspaces require pairing again.')).toBe(
        encryptedWorkspace
      );
      expect(dialog.textContent).toContain('No other offline machine identities');
      const submit = Array.from(dialog.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('restore and restart')
      );
      expect(submit?.disabled).toBe(true);
    }
  );
});

describe('provider setup rows beside published configs', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const config = (id: string, name: string): AgentConfigMeta => ({
    id: id as AgentConfigId,
    name,
    cliType: 'builtin',
    agentType: 'devin',
    machineId: machine.id,
    env: {},
    prompt: '',
  });
  // A setup publishes its config under the setup's own id.
  const setup: ProviderSetupTask = {
    v: 1,
    id: 'devin-setup' as AgentConfigId,
    machineId: machine.id,
    config: config('devin-setup', 'Devin'),
    status: 'queued',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const setupRowCount = () =>
    (container.textContent ?? '').split('to finish this provider setup.').length - 1;

  it.each(['list', 'card', 'mobile-list'] as const)(
    'removes a setup row that briefly coexisted with its published config (%s)',
    async (view) => {
      const render = (configs: AgentConfigMeta[], setups: ProviderSetupTask[]) =>
        act(async () =>
          root.render(
            <Tooltip.Provider>
              <MachineProvidersSection
                machine={machine}
                configs={configs}
                setups={setups}
                bare={view === 'card'}
                variant={view === 'mobile-list' ? 'mobile-list' : 'default'}
                onAddConfig={vi.fn()}
                onEditConfig={vi.fn()}
              />
            </Tooltip.Provider>
          )
        );
      const published = config('devin-setup', 'Devin');
      await render([config('a', 'A'), published, config('z', 'Zed')], [setup]);
      expect(setupRowCount()).toBe(1);

      await render([config('a', 'A'), published], []);
      expect(setupRowCount()).toBe(0);
      expect(container.querySelectorAll('[data-agent-config-id="devin-setup"]')).toHaveLength(1);
    }
  );
});
