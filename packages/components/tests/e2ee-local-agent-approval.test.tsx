// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { E2eeLocalAgentApproval } from '../src/components/e2ee-local-agent-approval';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('local encrypted agent approval', () => {
  let root: Root;
  let container: HTMLDivElement;
  let prepared = false;
  let admitted = false;
  let ready = true;
  let admissionFails = false;
  let session: string;
  let hasCredential: boolean;
  let protection: 'file' | 'os-keystore' = 'file';
  let runtime: Pick<
    E2eeWorkspaceRuntime,
    'prepareLocalAgent' | 'admitLocalAgent' | 'status' | 'resetLocalAgent' | 'resetIdentity'
  >;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    prepared = admitted = admissionFails = false;
    ready = true;
    protection = 'file';
    session = 'synthetic-session';
    hasCredential = true;
    runtime = {
      status: async () => ({ hasDeviceCredential: hasCredential }) as never,
      prepareLocalAgent: async () => {
        prepared = true;
        return { pairingSessionId: session, protection, admitted };
      },
      admitLocalAgent: async (_workspace: string, approvedSession: string) => {
        if (approvedSession !== session) throw new Error('wrong session');
        if (admissionFails) throw new Error('temporary unavailable');
        admitted = true;
        return { admitted: true, ready };
      },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (enabled = true) =>
    act(async () =>
      root.render(
        <E2eeLocalAgentApproval workspaceId="workspace" runtime={runtime} enabled={enabled} />
      )
    );
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.textContent === label
    );
    if (!button) throw new Error(`missing button ${label}`);
    await act(async () => button.click());
  };
  it('offers explicit machine reset after corrupt preparation, then requires new approval', async () => {
    const prepareOriginal = runtime.prepareLocalAgent;
    let broken = true;
    runtime.prepareLocalAgent = async (...args) => {
      if (broken)
        throw new Error(
          "Error invoking remote method 'e2ee:prepareLocalAgent': Error: e2ee_machine_corrupt"
        );
      if (!prepareOriginal) throw new Error('missing fixture preparation');
      return prepareOriginal(...args);
    };
    runtime.resetLocalAgent = async (input) => {
      expect(input.workspaceId).toBe('workspace');
      expect(input.confirm).toBe(true);
      expect(input.resetId).toBeTruthy();
      broken = false;
      session = 'replacement-session';
    };
    await render();
    await click('e2ee.localAgent.enable');
    await click('e2ee.identity.resetMachine');
    expect(broken).toBe(true);
    await click('e2ee.identity.confirm');
    expect(broken).toBe(false);
    expect(admitted).toBe(false);
    await click('e2ee.localAgent.enable');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'e2ee.localAgent.confirm'
    );
    expect(admitted).toBe(false);
    await click('e2ee.localAgent.allow');
    expect(admitted).toBe(true);
  });

  it('a desktop status failure offers the desktop identity reset, not machine reset', async () => {
    let desktopReset = false;
    runtime.status = async () => {
      throw new Error("Error invoking remote method 'e2ee:status': Error: e2ee_corrupt");
    };
    runtime.resetIdentity = async () => {
      desktopReset = true;
      return { archive: '/synthetic/archive' };
    };
    runtime.resetLocalAgent = async () => {
      throw new Error('wrong recovery scope');
    };
    await render();
    expect(container.textContent).toContain('e2ee.identity.resetWorkspace');
    expect(container.textContent).not.toContain('e2ee.identity.resetMachine');
    await click('e2ee.identity.resetWorkspace');
    await click('e2ee.identity.confirm');
    expect(desktopReset).toBe(true);
    expect(admitted).toBe(false);
  });

  it.each([
    ['local-history-recovery-required', 'historyTitle'],
    ['trusted-pin-unavailable', 'pinTitle'],
    ['restart-required', 'restartTitle'],
  ])('maps native %s to its permitted recovery', async (code, title) => {
    let archived = false;
    runtime.status = async () => {
      throw new Error(`Error invoking remote method 'e2ee:status': Error: e2ee_${code}`);
    };
    runtime.resetIdentity = async () => {
      archived = true;
      return { archive: '/synthetic/archive' };
    };
    await render();
    expect(container.textContent).toContain(`e2ee.identity.${title}`);
    expect(archived).toBe(false);
    if (code === 'restart-required') {
      expect(container.textContent).toContain('e2ee.identity.restartHelp');
      expect(container.textContent).not.toContain('e2ee.identity.resetWorkspace');
      expect(container.textContent).not.toContain('e2ee.identity.resetAccount');
    } else {
      await click('e2ee.identity.resetWorkspace');
      expect(archived).toBe(false);
      await click('e2ee.identity.confirm');
      expect(archived).toBe(true);
    }
    expect(admitted).toBe(false);
  });

  it('permission repair offers retry without an identity reset', async () => {
    runtime.prepareLocalAgent = async () => {
      throw new Error('e2ee_machine_permissions');
    };
    await render();
    await click('e2ee.localAgent.enable');
    expect(container.textContent).toContain('e2ee.identity.permissionsHelp');
    expect(container.textContent).not.toContain('e2ee.identity.resetMachine');
  });

  it('does nothing on the ordinary workspace path', async () => {
    await render(false);
    expect(container.textContent).toBe('');
    expect(prepared).toBe(false);
    expect(admitted).toBe(false);
  });
  it('hides approval for an old workspace with no local credential', async () => {
    hasCredential = false;
    await render();
    expect(container.textContent).toBe('');
    expect(prepared).toBe(false);
    expect(admitted).toBe(false);
  });
  it('recovers a temporary local status failure on retry', async () => {
    const original = runtime.status;
    runtime.status = async () => {
      throw new Error('temporary');
    };
    await render();
    expect(container.textContent).toContain('e2ee.localAgent.retryHelp');
    runtime.status = original;
    await click('common.tryAgain');
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  });
  it('keeps a timed-out preparation pending and retries without granting approval', async () => {
    const prepare = runtime.prepareLocalAgent!;
    runtime.prepareLocalAgent = async () => {
      // Electron prefixes the stable main-process error on invoke rejection.
      throw new Error('Error invoking remote method: Error: e2ee_local_agent_pending');
    };
    await render();
    await click('e2ee.localAgent.enable');
    expect(container.textContent).toContain('e2ee.localAgent.preparationPending');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(admitted).toBe(false);
    runtime.prepareLocalAgent = prepare;
    await render();
    await click('common.tryAgain');
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(admitted).toBe(false);
    await click('e2ee.localAgent.allow');
    expect(admitted).toBe(true);
    expect(container.textContent).toBe('');
  });
  it('asks again when a lost CLI identity starts a new session after approval', async () => {
    ready = false;
    await render();
    await click('e2ee.localAgent.enable');
    await click('e2ee.localAgent.allow');
    session = 'replacement-session';
    admitted = false;
    await click('common.tryAgain');
    expect(admitted).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'e2ee.localAgent.fileProtection'
    );
    ready = true;
    await click('e2ee.localAgent.allow');
    expect(admitted).toBe(true);
    expect(container.textContent).toBe('');
  });
  it('requires explicit approval and discloses file protection before admitting', async () => {
    await render();
    expect(prepared).toBe(false);
    await click('e2ee.localAgent.enable');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'e2ee.localAgent.fileProtection'
    );
    expect(admitted).toBe(false);
    await click('e2ee.localAgent.allow');
    expect(admitted).toBe(true);
    expect(container.textContent).toBe('');
  });
  it('cancels before approval without admitting', async () => {
    await render();
    await click('e2ee.localAgent.enable');
    await click('common.cancel');
    expect(admitted).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it('does not claim file protection for an OS protected machine', async () => {
    protection = 'os-keystore';
    await render();
    await click('e2ee.localAgent.enable');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).not.toContain(
      'e2ee.localAgent.fileProtection'
    );
  });
  it('retains a successful admission while waiting and retries activation without asking again', async () => {
    ready = false;
    await render();
    await click('e2ee.localAgent.enable');
    await click('e2ee.localAgent.allow');
    expect(admitted).toBe(true);
    expect(container.textContent).toContain('e2ee.localAgent.waiting');
    admissionFails = true;
    await click('common.tryAgain');
    expect(container.textContent).toContain('e2ee.localAgent.admittedRetry');
    expect(admitted).toBe(true);
    admissionFails = false;
    ready = true;
    await click('common.tryAgain');
    expect(container.textContent).toBe('');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it('retries a temporary failure after confirmation without losing the approval session', async () => {
    admissionFails = true;
    await render();
    await click('e2ee.localAgent.enable');
    await click('e2ee.localAgent.allow');
    expect(container.textContent).toContain('e2ee.localAgent.approvedRetry');
    expect(admitted).toBe(false);
    admissionFails = false;
    await click('common.tryAgain');
    expect(admitted).toBe(true);
    expect(container.textContent).toBe('');
  });
  it('retries temporary preparation failure before asking for approval', async () => {
    const prepare = runtime.prepareLocalAgent!;
    runtime.prepareLocalAgent = async () => {
      throw new Error('unavailable');
    };
    await render();
    await click('e2ee.localAgent.enable');
    expect(container.textContent).toContain('e2ee.localAgent.retryHelp');
    expect(admitted).toBe(false);
    runtime.prepareLocalAgent = prepare;
    await render();
    await click('common.tryAgain');
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(admitted).toBe(false);
  });
  it('requires explicit consent for a new session even when the machine was admitted by another frontend', async () => {
    admitted = true;
    await render();
    let activationRequested = false;
    runtime.admitLocalAgent = async () => {
      activationRequested = true;
      return { admitted: true, ready: true };
    };
    await click('e2ee.localAgent.enable');
    expect(activationRequested).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click('e2ee.localAgent.allow');
    expect(activationRequested).toBe(true);
    expect(container.textContent).toBe('');
  });
});

describe('remote encrypted machine approval', () => {
  it('tells the user to regenerate a revoked machine identity instead of a generic failure', async () => {
    const { E2eeRemoteMachinePairing } =
      await import('../src/components/pages/e2ee-remote-machine-pairing');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const pairing = {
      pairingSessionId: '11'.repeat(16),
      summary: null,
      material: null,
      status: 'pending' as const,
      expiresAt: 2_000_000,
      location: null,
    };
    const runtime = {
      beginRemoteMachinePairing: async () => ({
        ...pairing,
        command: 'lody machine pair --offer synthetic-command',
      }),
      inspectRemoteMachinePairing: async () => {
        throw new Error(
          "Error invoking remote method 'e2ee.inspectRemoteMachinePairing': Error: e2ee_pairing_key_revoked"
        );
      },
      approveRemoteMachinePairing: async () => ({ admitted: false, ready: false }),
      cancelRemoteMachinePairing: async () => ({ ...pairing, status: 'cancelled' as const }),
    };
    const click = async (key: string) => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (item) => item.textContent === key
      );
      if (!button) throw new Error(`missing ${key}`);
      await act(async () => button.click());
    };
    try {
      await act(async () =>
        root.render(<E2eeRemoteMachinePairing workspaceId="workspace" runtime={runtime} />)
      );
      await click('e2ee.remoteMachine.create');
      await click('e2ee.remoteMachine.check');
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'e2ee.remoteMachine.keyRevoked'
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('shows the exact summary and file protection before separate approval, then preserves pending installation', async () => {
    const { E2eeRemoteMachinePairing } =
      await import('../src/components/pages/e2ee-remote-machine-pairing');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const pairingSessionId = '11'.repeat(16),
      summary = Array(8).fill('12345678').join(' ');
    let state: 'claimed' | 'admitted' = 'claimed';
    const material = {
      ok: true as const,
      type: 'prepare' as const,
      machineId: 'synthetic-machine',
      pairingSessionId,
      signingPublicKey: '22'.repeat(32),
      encryptionPublicKey: '33'.repeat(32),
      possessionSignature: '44'.repeat(64),
      credentialHash: '55'.repeat(32),
      bindingSignature: '66'.repeat(64),
      protection: 'file' as const,
    };
    const view = () => ({
      pairingSessionId,
      summary,
      material,
      status: state,
      expiresAt: 2_000_000,
      location: { country: 'CN', city: 'Shanghai' },
    });
    const runtime = {
      beginRemoteMachinePairing: async () => ({
        ...view(),
        command: 'lody machine pair --offer synthetic-command',
      }),
      inspectRemoteMachinePairing: async () => view(),
      approveRemoteMachinePairing: async (_workspace: string, session: string, shown: string) => {
        if (session !== pairingSessionId || shown !== summary) throw new Error('evidence changed');
        state = 'admitted';
        return { admitted: true, ready: false };
      },
      cancelRemoteMachinePairing: async () => ({ ...view(), status: 'cancelled' as const }),
    };
    const click = async (key: string) => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (item) => item.textContent === key
      );
      if (!button) throw new Error(`missing ${key}`);
      await act(async () => button.click());
    };
    try {
      await act(async () =>
        root.render(<E2eeRemoteMachinePairing workspaceId="workspace" runtime={runtime} />)
      );
      await click('e2ee.remoteMachine.create');
      expect(container.querySelector('textarea')?.value).toContain('synthetic-command');
      expect(container.textContent).not.toContain(summary);
      await click('e2ee.remoteMachine.check');
      expect(state).toBe('claimed');
      expect(container.querySelector('[data-testid="e2ee-remote-machine-summary"]')?.textContent).toBe(summary);
      expect(container.textContent).toContain(summary);
      expect(container.textContent).toContain('e2ee.localAgent.fileProtection');
      await click('e2ee.remoteMachine.allow');
      expect(state).toBe('admitted');
      expect(container.textContent).toContain('e2ee.remoteMachine.status.admitted');
      expect(container.textContent).toContain('e2ee.remoteMachine.resume');
      expect(container.textContent).not.toContain('e2ee.remoteMachine.status.ready');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
