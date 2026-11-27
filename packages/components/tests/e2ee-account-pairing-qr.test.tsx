// @vitest-environment jsdom
import {
  postHogPrivacy,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
} from '../src/lib/posthog-privacy';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  E2eeAccountPairingPreview,
  E2eeAccountPairingRequestState,
  E2eeWorkspaceRuntime,
} from '@lody/platform';
import {
  E2eeAccountPairingApprove,
  E2eeAccountPairingRequest,
} from '../src/components/pages/e2ee-account-pairing';
import { withAccountPairingCode } from '../src/lib/e2ee-account-pairing-ipc';
import {
  CODE,
  TYPO,
  NOW,
  preview,
  requesterHost,
  approverHost,
} from './e2ee-account-pairing-test-helpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
// The QR drawing and camera are presentation; the payload is asserted directly.
const qr = vi.hoisted(() => ({
  payloads: [] as string[],
  /** The open camera's decode callback; tests deliver a scanned text through it. */
  scan: null as ((text: string) => void) | null,
}));
vi.mock('../src/components/pages/e2ee-ledger-verification', () => ({
  LedgerQrCode: (props: { payload: string }) => {
    qr.payloads.push(props.payload);
    return null;
  },
  useQrCamera: (active: boolean, onCode: (text: string) => void) => {
    if (active) qr.scan = onCode;
    return { video: { current: null }, state: active ? 'scanning' : 'idle' };
  },
}));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  qr.payloads = [];
  qr.scan = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  try {
    await act(async () => root.unmount());
    container.remove();
  } finally {
    vi.useRealTimers();
  }
});
const text = () => container.textContent ?? '';
const button = (label: string) => {
  const found = [...container.querySelectorAll('button')].find((value) =>
    (value.textContent ?? '').startsWith(label)
  );
  if (!found) throw new Error(`missing ${label}`);
  return found;
};
const click = async (label: string) => act(async () => button(label).click());
const type = async (value: string) => {
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const tick = async (ms = 3000) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });

it('in-app recovery requires consent and never starts pairing; only a completed workspace resumes content', async () => {
  const host = requesterHost();
  const opened: string[] = [];
  let joined = false;
  const runtime = {
    ...host.runtime,
    openBrowserRecovery: async (id: string) => {
      opened.push(id);
      return true;
    },
  };
  await act(async () =>
    root.render(
      <E2eeAccountPairingRequest
        runtime={runtime}
        autoStart={false}
        workspaceId="workspace-A"
        onJoined={() => {
          joined = true;
        }}
      />
    )
  );
  expect((button('e2ee.browserUnlock.open') as HTMLButtonElement).disabled).toBe(true);
  expect(host.state).toBeNull();
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  await click('e2ee.browserUnlock.open');
  expect(opened).toEqual(['workspace-A']);
  expect(joined).toBe(true);
  expect(host.state).toBeNull();
  expect(container.querySelector('[data-testid="e2ee-account-pairing-string"]')).toBeNull();
});

it('cancelled recovery keeps the device approval choice usable without creating a request', async () => {
  const host = requesterHost();
  let joined = false;
  await act(async () =>
    root.render(
      <E2eeAccountPairingRequest
        runtime={{ ...host.runtime, openBrowserRecovery: async () => false }}
        autoStart={false}
        workspaceId="workspace-A"
        onJoined={() => {
          joined = true;
        }}
      />
    )
  );
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  await click('e2ee.browserUnlock.open');
  expect(joined).toBe(false);
  expect(host.state).toBeNull();
  expect((button('e2ee.accountPair.request.start') as HTMLButtonElement).disabled).toBe(false);
});

it('browser device requests retain personal-computer consent while automatic opening is unavailable', async () => {
  const host = requesterHost();
  await act(async () =>
    root.render(
      <E2eeAccountPairingRequest
        runtime={{ ...host.runtime, requirePersonalComputer: true }}
        autoStart={false}
        onJoined={() => {}}
      />
    )
  );
  expect((button('e2ee.accountPair.request.start') as HTMLButtonElement).disabled).toBe(true);
  expect(host.state).toBeNull();
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  await click('e2ee.accountPair.request.start');
  expect(container.querySelector('[data-testid="e2ee-account-pairing-string"]')?.textContent).toBe(
    CODE
  );
});

it('automatic-capable browsers choose recovery without pairing, or consent before the existing six-digit approval flow', async () => {
  const { E2eeAutomaticPairingPage } =
    await import('../src/components/pages/e2ee-automatic-pairing');
  const host = requesterHost();
  let requested = false;
  let opened = false;
  const runtime = {
    ...host.runtime,
    requirePersonalComputer: true,
    openBrowserRecovery: async () => {
      opened = true;
      return false;
    },
    automaticPairingState: async () => null,
    startAutomaticPairing: async () => {
      requested = true;
      return {
        id: 'a1'.repeat(16),
        phase: 'waiting',
        workspaceId: 'workspace-A',
        workspaceName: 'Alpha',
        deviceName: 'Web',
        comparisonCode: '123456',
        expiresAt: NOW + 600_000,
      };
    },
  } as unknown as E2eeWorkspaceRuntime;
  await act(async () =>
    root.render(
      <E2eeAutomaticPairingPage
        runtime={runtime}
        workspaceId="workspace-A"
        onJoined={() => {}}
        onBack={() => {}}
      />
    )
  );
  expect(requested).toBe(false);
  expect((button('e2ee.browserUnlock.open') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  await click('e2ee.browserUnlock.open');
  expect(opened).toBe(true);
  expect(requested).toBe(false);
  expect(host.state).toBeNull();
  await click('e2ee.accountPair.request.start');
  expect(requested).toBe(true);
  expect(container.textContent).toContain('123 456');
  expect(host.state).toBeNull();
});

describe('instant QR join and form-factor pairing', () => {
  const flush = async () => {
    for (let turn = 0; turn < 6; turn++) await act(async () => {});
  };
  const withCamera = () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({}) },
    });
    return () => {
      if (original) Object.defineProperty(navigator, 'mediaDevices', original);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    };
  };
  const preview: E2eeAccountPairingPreview = {
    requestId: 'request-1',
    deviceName: 'Synthetic phone',
    approximateLocation: null,
    requestedAt: NOW,
    expiresAt: NOW + 600_000,
    workspaces: [
      { workspaceId: 'w1', name: 'Alpha' },
      { workspaceId: 'w2', name: 'Beta' },
    ],
    unavailable: [],
  };
  const review = {
    id: 'request',
    requestId: 'native-request',
    workspaceId: 'w1',
    workspaceName: 'Synthetic team',
    deviceName: 'Phone',
    expiresAt: NOW + 600_000,
    phase: 'waiting' as const,
  };

  it('presents a request in a visible but unfocused window, and at once when a hidden window is shown again', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    let visibility: DocumentVisibilityState = 'hidden';
    const visible = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility);
    const runtime = {
      pendingAutomaticPairing: async () => [review],
      approveAutomaticPairing: async () => {},
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    const codeInput = () => document.querySelector('[data-testid="e2ee-approval-code"]');
    try {
      await act(async () => root.render(<E2eeAutomaticPairingInbox runtime={runtime} />));
      await flush();
      expect(codeInput()).toBeNull();
      visibility = 'visible';
      // No poll interval elapses: the visibility change alone presents the request.
      await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      await flush();
      expect(codeInput()).not.toBeNull();
    } finally {
      focus.mockRestore();
      visible.mockRestore();
    }
  });

  it('on a computer asks only for the new device code, with no QR code of its own', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceDesktopLayoutProvider } = await import('../src/hooks/use-mobile');
    let offers = 0;
    const entered: [string, string, readonly string[] | undefined][] = [];
    const runtime = {
      pendingAutomaticPairing: async () => (entered.length ? [] : [review]),
      approveAutomaticPairing: async (id: string, code: string, ids?: readonly string[]) => {
        entered.push([id, code, ids]);
      },
      declineAutomaticPairing: async () => {},
      // The Add device card keeps this offer; the approval window never starts one.
      accountPairingCode: async () => {
        offers += 1;
        return { pairingString: CODE, expiresAt: NOW + 600_000 };
      },
      inspectAccountPairing: async () => null,
      approveAccountPairing: async () => ({ workspaces: [] }),
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () =>
      root.render(
        <ForceDesktopLayoutProvider>
          <E2eeAutomaticPairingInbox runtime={runtime} />
        </ForceDesktopLayoutProvider>
      )
    );
    await flush();
    expect(offers).toBe(0);
    expect(document.querySelector('[data-testid="e2ee-instant-qr"]')).toBeNull();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('[data-testid="e2ee-approval-scan-start"]')).toBeNull();
    expect(document.body.textContent).toContain('e2ee.auto.scopeListedOne');
    const input = document.querySelector('[data-testid="e2ee-approval-code"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '654321'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      (
        document.querySelector('[data-testid="e2ee-approval-authorize"]') as HTMLButtonElement
      ).click()
    );
    await flush();
    expect(entered).toEqual([['request', '654321', ['w1']]]);
    expect(offers).toBe(0);
  });

  it('approves every listed workspace by default and passes exactly the ticked ones', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceDesktopLayoutProvider } = await import('../src/hooks/use-mobile');
    const approved: [string, string, readonly string[] | undefined][] = [];
    let rows = [
      {
        ...review,
        workspaces: [
          { workspaceId: 'w1', name: 'Synthetic team' },
          { workspaceId: 'w2', name: 'Beta' },
          { workspaceId: 'w3', name: 'Gamma' },
        ],
      },
    ];
    const runtime = {
      pendingAutomaticPairing: async () => rows,
      approveAutomaticPairing: async (id: string, code: string, ids?: readonly string[]) => {
        approved.push([id, code, ids]);
        rows = [];
      },
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    const box = (id: string) => document.querySelector<HTMLElement>(`[data-workspace-id="${id}"]`)!;
    const authorize = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="e2ee-approval-authorize"]')!;
    await act(async () =>
      root.render(
        <ForceDesktopLayoutProvider>
          <E2eeAutomaticPairingInbox runtime={runtime} />
        </ForceDesktopLayoutProvider>
      )
    );
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-workspaces"]')).not.toBeNull();
    for (const id of ['w2', 'w3']) expect(box(id).getAttribute('aria-checked')).toBe('true');
    // The workspace the new device opened is a fixed row, not a checkbox that cannot change.
    expect(document.querySelector('[data-workspace-id="w1"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="e2ee-approval-workspaces"]')?.textContent
    ).toContain('e2ee.auto.requestedHere');
    expect(authorize().textContent).toBe('e2ee.auto.authorizeSelected {"count":3}');
    expect(document.body.textContent).toContain('e2ee.auto.scopeListed');
    expect(document.body.textContent).not.toContain('e2ee.auto.scopeListedOne');
    await act(async () => box('w2').click());
    expect(box('w2').getAttribute('aria-checked')).toBe('false');
    expect(authorize().textContent).toBe('e2ee.auto.authorizeSelected {"count":2}');
    const input = document.querySelector('[data-testid="e2ee-approval-code"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '123456'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => authorize().click());
    await flush();
    expect(approved).toEqual([['request', '123456', ['w1', 'w3']]]);
  });

  it('names a single workspace without checkboxes and approves exactly that one', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const approved: (readonly string[] | undefined)[] = [];
    const runtime = {
      pendingAutomaticPairing: async () => [
        { ...review, workspaces: [{ workspaceId: 'w1', name: 'Synthetic team' }] },
      ],
      approveAutomaticPairing: async (_id: string, _code: string, ids?: readonly string[]) => {
        approved.push(ids);
      },
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () => root.render(<E2eeAutomaticPairingInbox runtime={runtime} />));
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-workspaces"]')).toBeNull();
    expect(document.body.textContent).toContain('Synthetic team');
    const authorize = document.querySelector<HTMLButtonElement>(
      '[data-testid="e2ee-approval-authorize"]'
    )!;
    expect(authorize.textContent).toBe('e2ee.auto.authorize');
    const input = document.querySelector('[data-testid="e2ee-approval-code"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '123456'
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => authorize.click());
    await flush();
    expect(approved).toEqual([['w1']]);
  });

  it.each([
    [{ electron: true, nativeShell: false, ios: false }, 'Lody desktop'],
    [{ electron: false, nativeShell: true, ios: true }, 'Lody iOS'],
    [{ electron: false, nativeShell: true, ios: false }, 'Lody Android'],
    [{ electron: false, nativeShell: false, ios: false }, 'Lody Web'],
  ] as const)('names a requester on %o as %s', async (environment, name) => {
    const { pairingDeviceName } = await import('../src/providers/e2ee-pairing-device');
    expect(pairingDeviceName(environment)).toBe(name);
  });

  it('on a phone submits a scanned code from another device at once instead of filling the field', async () => {
    const restoreCamera = withCamera();
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const host = requesterHost();
    try {
      await act(async () =>
        root.render(
          <ForceMobileLayoutProvider force>
            <E2eeAccountPairingRequest runtime={host.runtime} autoStart onJoined={() => {}} />
          </ForceMobileLayoutProvider>
        )
      );
      await flush();
      await click('e2ee.accountPair.request.haveCode');
      await click('e2ee.accountPair.request.scan');
      // The other role's code is named, and nothing is sent.
      await act(async () => qr.scan!('lody://auto-pair?id=request&code=123456'));
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'e2ee.instantQr.wrongRole'
      );
      expect(host.started).toEqual([{}]);
      await click('e2ee.accountPair.request.scan');
      await act(async () => qr.scan!(`lody://pair/${CODE.replace(/-/g, '')}`));
      await flush();
      expect(host.started).toEqual([
        {},
        { pairingString: `lody://pair/${CODE.replace(/-/g, '')}` },
      ]);
      expect(container.querySelector('textarea')).toBeNull();
    } finally {
      restoreCamera();
    }
  });
  it('guides to the six-digit flow and opens the offline code panel inside the Add device card', async () => {
    const { E2eeAddDeviceCard } = await import('../src/components/pages/e2ee-instant-qr');
    const runtime = {
      accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
      inspectAccountPairing: async () => null,
      approveAccountPairing: async () => ({ workspaces: [] }),
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () => root.render(<E2eeAddDeviceCard runtime={runtime} />));
    await act(async () =>
      (
        document.querySelector('[data-testid="e2ee-add-device-manual"]') as HTMLButtonElement
      ).click()
    );
    await flush();
    const card = document.querySelector('[data-testid="e2ee-add-device"]')!;
    const panel = document.querySelector('[data-testid="e2ee-account-pairing-approve"]');
    expect(panel && card.contains(panel)).toBe(true);
    expect(card.contains(document.querySelector('[data-testid="e2ee-add-device-manual"]'))).toBe(
      true
    );
    // The card's own heading names the task; the panel adds none of its own.
    expect(text()).not.toContain('e2ee.accountPair.approve.title');
    // The card points at the six-digit flow and offers no QR code of its own.
    expect(text()).toContain('e2ee.addDevice.lead');
    expect(document.querySelector('[data-testid="e2ee-add-device-show-qr"]')).toBeNull();
    expect(qr.payloads).toEqual([]);
    // A host that can approve neither way shows no card.
    await act(async () => root.render(<E2eeAddDeviceCard runtime={{}} />));
    expect(document.querySelector('[data-testid="e2ee-add-device"]')).toBeNull();
  });

  it('on a phone approves by scanning the new screen, ignoring another request without using an attempt', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const entered: [string, string][] = [];
    const runtime = {
      pendingAutomaticPairing: async () => (entered.length ? [] : [review]),
      approveAutomaticPairing: async (id: string, code: string) => {
        entered.push([id, code]);
      },
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    const scanStart = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="e2ee-approval-scan-start"]');
    try {
      await act(async () =>
        root.render(
          <ForceMobileLayoutProvider force>
            <E2eeAutomaticPairingInbox runtime={runtime} />
          </ForceMobileLayoutProvider>
        )
      );
      await flush();
      // Typing is the one action; scanning the new screen is a shortcut beside it.
      expect(document.querySelector('[data-testid="e2ee-approval-code"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="e2ee-instant-qr"]')).toBeNull();
      await act(async () => scanStart()!.click());
      await act(async () => qr.scan!('lody://auto-pair?id=someone-else&code=123456'));
      await flush();
      expect(entered).toEqual([]);
      expect(document.body.textContent).toContain('e2ee.auto.scan.otherRequest');
      await act(async () => scanStart()!.click());
      await act(async () => qr.scan!('lody://auto-pair?id=request&code=654321'));
      await flush();
      // Scanning is entering the shown code: the host still compares it before signing.
      expect(entered).toEqual([['request', '654321']]);
    } finally {
      focus.mockRestore();
      restoreCamera();
    }
  });

  it('on a new phone shows its six-digit code at once, with no scan or QR code', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    let phase: 'preparing' | 'waiting' = 'preparing';
    const requested: unknown[] = [];
    const runtime = {
      automaticPairingState: async () => ({
        id: 'request',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Phone',
        comparisonCode: phase === 'waiting' ? '123456' : null,
        expiresAt: NOW + 300_000,
        phase,
      }),
      requestAccountPairing: async (input: unknown) => {
        requested.push(input);
        return {};
      },
      accountPairingRequest: async () => null,
    } as unknown as E2eeWorkspaceRuntime;
    try {
      await act(async () =>
        root.render(
          <ForceMobileLayoutProvider force>
            <E2eeAutomaticPairingPage
              runtime={runtime}
              workspaceId="w1"
              onJoined={() => {}}
              onBack={() => {}}
            />
          </ForceMobileLayoutProvider>
        )
      );
      await flush();
      expect(text()).toContain('e2ee.auto.awaiting.title');
      phase = 'waiting';
      await tick(2000);
      await flush();
      // The code is the page's one instruction; nothing offers to scan another device.
      expect(text()).toContain('123 456');
      expect(text()).toContain('e2ee.auto.showCode');
      expect(text()).not.toContain('e2ee.auto.scanJoin');
      expect(container.querySelector('[data-testid="e2ee-qr-viewfinder"]')).toBeNull();
      expect(container.querySelector('[data-testid="e2ee-auto-pair-qr"]')).toBeNull();
      expect(qr.payloads).toEqual([]);
      expect(requested).toEqual([]);
    } finally {
      restoreCamera();
    }
  });

  it('on a new computer shows a QR code for a phone beside the typed code, and no camera', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceDesktopLayoutProvider } = await import('../src/hooks/use-mobile');
    const runtime = {
      automaticPairingState: async () => ({
        id: 'request',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Desk',
        comparisonCode: '123456',
        expiresAt: NOW + 300_000,
        phase: 'waiting',
      }),
      requestAccountPairing: async () => ({}),
      accountPairingRequest: async () => null,
    } as unknown as E2eeWorkspaceRuntime;
    try {
      await act(async () =>
        root.render(
          <ForceDesktopLayoutProvider>
            <E2eeAutomaticPairingPage
              runtime={runtime}
              workspaceId="w1"
              onJoined={() => {}}
              onBack={() => {}}
            />
          </ForceDesktopLayoutProvider>
        )
      );
      await flush();
      expect(qr.payloads.at(-1)).toBe('lody://auto-pair?id=request&code=123456');
      expect(text()).toContain('123 456');
      expect(text()).toContain('e2ee.auto.showCode');
      expect(text()).not.toContain('e2ee.auto.scanJoin');
      expect(container.querySelector('[data-testid="e2ee-qr-viewfinder"]')).toBeNull();
    } finally {
      restoreCamera();
    }
  });

  it('names a refused request instead of reporting a connection problem', async () => {
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    let failure: unknown = Object.assign(new Error('rejected'), {
      data: { code: 'e2ee_invalid-input' },
    });
    const runtime = {
      automaticPairingState: async () => {
        throw failure;
      },
      startAutomaticPairing: async () => {
        throw failure;
      },
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingPage
          runtime={runtime}
          workspaceId="w1"
          onJoined={() => {}}
          onBack={() => {}}
        />
      )
    );
    await flush();
    expect(text()).toContain('e2ee.accountPair.error.failed');
    expect(text()).not.toContain('e2ee.auto.connectionRetry');
    failure = new TypeError('Failed to fetch');
    await tick(2000);
    await flush();
    expect(text()).toContain('e2ee.auto.connectionRetry');
  });
});

describe('pairing hardening', () => {
  const flush = async () => {
    for (let turn = 0; turn < 6; turn++) await act(async () => {});
  };
  const review = {
    id: 'request',
    requestId: 'native-request',
    workspaceId: 'w1',
    workspaceName: 'Synthetic team',
    deviceName: 'Phone',
    expiresAt: NOW + 600_000,
    phase: 'waiting' as const,
  };
  const withCamera = () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({}) },
    });
    return () => delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  };

  it('shows the code an external auto-pair link carried and waits for explicit approval', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const other = { ...review, id: 'other-request', deviceName: 'Other laptop' };
    let rows: (typeof review)[] = [];
    const entered: [string, string][] = [];
    const joined: { pairingString: string; preserveExisting?: boolean }[] = [];
    const runtime = {
      pendingAutomaticPairing: async () => rows,
      approveAutomaticPairing: async (id: string, code: string) => {
        entered.push([id, code]);
      },
      declineAutomaticPairing: async () => {},
      requestAccountPairing: async (input: {
        pairingString: string;
        preserveExisting?: boolean;
      }) => {
        joined.push(input);
        return {
          lookupId: 'a'.repeat(32),
          direction: 'approver-shows',
          pairingString: null,
          expiresAt: NOW + 600_000,
          status: 'joined',
          workspaces: [{ workspaceId: 'w1', name: 'Alpha', state: 'joined', approval: 'approved' }],
        };
      },
      accountPairingRequest: async () => null,
      cancelAccountPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    // The app was woken by the link before the request reached this device; even if another
    // waiting row arrives ahead of it, the link claims its own row rather than the first row.
    (window as { __LODY_PENDING_E2EE_PAIR_URL__?: string }).__LODY_PENDING_E2EE_PAIR_URL__ =
      'lody://auto-pair?id=request&code=246810';
    await act(async () => root.render(<E2eeAutomaticPairingInbox runtime={runtime} />));
    await flush();
    expect(entered).toEqual([]);
    rows = [other, review];
    await tick(2000);
    await flush();
    // External BROWSABLE links are untrusted: show the carried code to compare instead of a
    // field to fill, and never sign without a click.
    expect(entered).toEqual([]);
    expect(document.body.textContent).toContain('Phone');
    const linked = () =>
      document.querySelector('[data-testid="e2ee-approval-linked"]')?.textContent ?? '';
    expect(linked()).toContain('246 810');
    expect(document.querySelector('[data-testid="e2ee-approval-code"]')).toBeNull();
    // While an approval surface is already open, neither an auto-pair link for another waiting
    // request nor a stray pair link can swap the target or start a background join.
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('lody:e2ee-pair-url', {
          detail: { url: 'lody://auto-pair?id=other-request&code=135790' },
        })
      )
    );
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('lody:e2ee-pair-url', {
          detail: { url: `lody://pair/${CODE.replace(/-/g, '')}` },
        })
      )
    );
    await flush();
    expect(joined).toEqual([]);
    expect(document.body.textContent).toContain('Phone');
    expect(linked()).toContain('246 810');
    await act(async () =>
      (
        document.querySelector('[data-testid="e2ee-approval-authorize"]') as HTMLButtonElement
      ).click()
    );
    await flush();
    expect(entered).toEqual([['request', '246810']]);
    rows = [review];
    // A link for a request this device does not have opens and sends nothing.
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('lody:e2ee-pair-url', {
          detail: { url: 'lody://auto-pair?id=someone-else&code=135790' },
        })
      )
    );
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-code"]')).toBeNull();
    expect(entered).toEqual([['request', '246810']]);
  });

  it('returns a linked code that does not match to ordinary entry, using the attempt', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const entered: string[] = [];
    const runtime = {
      pendingAutomaticPairing: async () => [review],
      approveAutomaticPairing: async (_id: string, code: string) => {
        entered.push(code);
        throw Object.assign(new Error('e2ee_pairing-code-mismatch'), {
          code: 'pairing-code-mismatch',
          attemptsLeft: 2,
        });
      },
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    (window as { __LODY_PENDING_E2EE_PAIR_URL__?: string }).__LODY_PENDING_E2EE_PAIR_URL__ =
      'lody://auto-pair?id=request&code=246810';
    await act(async () => root.render(<E2eeAutomaticPairingInbox runtime={runtime} />));
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-linked"]')).not.toBeNull();
    await act(async () =>
      (
        document.querySelector('[data-testid="e2ee-approval-authorize"]') as HTMLButtonElement
      ).click()
    );
    await flush();
    expect(entered).toEqual(['246810']);
    expect(document.querySelector('[data-testid="e2ee-approval-linked"]')).toBeNull();
    const field = document.querySelector('[data-testid="e2ee-approval-code"]') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(document.body.textContent).toContain('e2ee.auto.codeMismatch');
  });

  it('never joins from a system-camera pair link on the new-device page', async () => {
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const requested: unknown[] = [];
    const runtime = {
      automaticPairingState: async () => ({
        id: 'request',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Phone',
        comparisonCode: '123456',
        expiresAt: NOW + 300_000,
        phase: 'waiting',
      }),
      requestAccountPairing: async (input: unknown) => {
        requested.push(input);
        return {};
      },
      accountPairingRequest: async () => null,
    } as unknown as E2eeWorkspaceRuntime;
    (window as { __LODY_PENDING_E2EE_PAIR_URL__?: string }).__LODY_PENDING_E2EE_PAIR_URL__ =
      `lody://pair/${CODE.replace(/-/g, '')}`;
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingPage
          runtime={runtime}
          workspaceId="w1"
          onJoined={() => {}}
          onBack={() => {}}
        />
      )
    );
    await flush();
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('lody:e2ee-pair-url', {
          detail: { url: `lody://pair/${CODE.replace(/-/g, '')}` },
        })
      )
    );
    await flush();
    // The page keeps showing its own code; it never submits another device's.
    expect(requested).toEqual([]);
    expect(text()).toContain('123 456');
    delete (window as { __LODY_PENDING_E2EE_PAIR_URL__?: string }).__LODY_PENDING_E2EE_PAIR_URL__;
  });

  it('leaves for code pairing at once even when the relay cannot confirm the cancellation', async () => {
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceDesktopLayoutProvider } = await import('../src/hooks/use-mobile');
    let manual = 0;
    const runtime = {
      automaticPairingState: async () => ({
        id: 'request',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Desk',
        comparisonCode: null,
        expiresAt: NOW + 300_000,
        phase: 'preparing',
      }),
      // Offline: the relay mutation never settles.
      cancelAutomaticPairing: () => new Promise(() => {}),
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () =>
      root.render(
        <ForceDesktopLayoutProvider>
          <E2eeAutomaticPairingPage
            runtime={runtime}
            workspaceId="w1"
            onJoined={() => {}}
            onBack={() => {}}
            onManual={() => (manual += 1)}
          />
        </ForceDesktopLayoutProvider>
      )
    );
    await flush();
    await click('e2ee.auto.manual');
    expect(manual).toBe(1);
  });

  it('presents a waiting review and coalesces in-flight subscription wakeups', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let listener: (() => void) | undefined;
    let calls = 0;
    let firstGate!: (rows: typeof waitingRows) => void;
    const waitingRows = [
      {
        id: 'request-live',
        requestId: 'native-live',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Phone',
        expiresAt: NOW + 600_000,
        phase: 'waiting' as const,
      },
    ];
    const runtime = {
      accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
      inspectAccountPairing: async () => null,
      approveAccountPairing: async () => ({ workspaces: [] }),
      subscribeAutomaticPairing: (cb: () => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      pendingAutomaticPairing: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<typeof waitingRows>((resolve) => {
            firstGate = resolve;
          });
        }
        return Promise.resolve(waitingRows);
      },
      approveAutomaticPairing: async () => {},
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    try {
      await act(async () =>
        root.render(
          <E2eeAutomaticPairingInbox runtime={runtime}>
            <div />
          </E2eeAutomaticPairingInbox>
        )
      );
      expect(calls).toBe(1);
      // A WebSocket wakeup arrives while the initial read is still in flight.
      listener!();
      await act(async () => firstGate([]));
      await flush();
      // Coalesced immediately without waiting for the 2s interval.
      expect(calls).toBe(2);
      expect(document.querySelector('[data-testid="e2ee-approval-code"]')).not.toBeNull();
      await act(async () => listener!());
      await flush();
      expect(calls).toBe(3);
      expect(document.querySelector('[data-testid="e2ee-instant-qr"]')).toBeNull();
    } finally {
      focus.mockRestore();
    }
  });

  it('lets the approver cancel the camera viewfinder in E2eeAccountPairingApprove', async () => {
    const restoreCamera = withCamera();
    try {
      const runtime = {
        inspectAccountPairing: async () => preview,
        approveAccountPairing: async () => ({ workspaces: [] }),
      };
      await act(async () => root.render(<E2eeAccountPairingApprove runtime={runtime} />));
      const scanButton = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('e2ee.accountPair.approve.scan')
      );
      expect(scanButton).toBeDefined();
      await act(async () => scanButton!.click());
      expect(container.querySelector('video')).not.toBeNull();
      const cancelButton = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('common.cancel')
      );
      expect(cancelButton).toBeDefined();
      await act(async () => cancelButton!.click());
      expect(container.querySelector('video')).toBeNull();
    } finally {
      restoreCamera();
    }
  });

  it('surfaces Retry sync and Cancel after 15s when syncing stalls without keyFailure', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(NOW);
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    let retried = 0;
    let backed = 0;
    const runtime = {
      automaticPairingState: async () => ({
        id: 'sync-stall',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Phone',
        comparisonCode: '123456',
        phase: 'syncing' as const,
        expiresAt: NOW + 600_000,
      }),
      startAutomaticPairing: async () => {
        throw new Error('unexpected');
      },
      cancelAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingPage
          runtime={runtime}
          workspaceId="w1"
          onJoined={() => {}}
          onBack={() => {
            backed += 1;
          }}
          onRetryKeys={() => {
            retried += 1;
          }}
        />
      )
    );
    await flush();
    expect(container.querySelector('[data-testid="e2ee-sync-timeout"]')).toBeNull();
    await tick(15_000);
    await flush();
    const timeoutBox = container.querySelector('[data-testid="e2ee-sync-timeout"]');
    expect(timeoutBox).not.toBeNull();
    const retryBtn = Array.from(timeoutBox!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('e2ee.auto.syncing.retry')
    );
    const cancelBtn = Array.from(timeoutBox!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('common.cancel')
    );
    await act(async () => retryBtn!.click());
    expect(retried).toBe(1);
    expect(container.querySelector('[data-testid="e2ee-sync-timeout"]')).toBeNull();
    await tick(15_000);
    await flush();
    const cancelAfterRetry = Array.from(
      container.querySelector('[data-testid="e2ee-sync-timeout"]')!.querySelectorAll('button')
    ).find((b) => b.textContent?.includes('common.cancel'));
    await act(async () => cancelAfterRetry!.click());
    expect(backed).toBe(1);
  });

  it('shows the 5s keep-open guidance before the 15s sync timeout in E2eeAutomaticPairingPage', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(NOW);
    try {
      const { E2eeAutomaticPairingPage } =
        await import('../src/components/pages/e2ee-automatic-pairing');
      const runtime = {
        automaticPairingState: async () => ({
          id: 'sync-step',
          workspaceId: 'w1',
          workspaceName: 'Alpha',
          deviceName: 'Phone',
          comparisonCode: '123456',
          phase: 'syncing' as const,
          expiresAt: NOW + 600_000,
        }),
        startAutomaticPairing: async () => {
          throw new Error('unexpected');
        },
        cancelAutomaticPairing: async () => {},
      } as unknown as E2eeWorkspaceRuntime;
      await act(async () =>
        root.render(
          <E2eeAutomaticPairingPage
            runtime={runtime}
            workspaceId="w1"
            onJoined={() => {}}
            onBack={() => {}}
          />
        )
      );
      await flush();
      expect(container.textContent).toContain('e2ee.auto.syncing.help');
      await tick(5_000);
      await flush();
      expect(container.textContent).toContain('e2ee.auto.syncing.keepOpen');
      expect(container.querySelector('[data-testid="e2ee-sync-timeout"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('approver discovers a post-reveal accountPairing submission even when subscribeAutomaticPairing stays quiet', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    let submitted = false;
    let unsubscribed = false;
    const runtime = {
      subscribeAutomaticPairing: () => () => {
        unsubscribed = true;
      },
      pendingAutomaticPairing: async () => (submitted ? [review] : []),
      approveAutomaticPairing: async () => ({ outcome: 'approved' as const }),
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingInbox runtime={runtime}>
          <div>host</div>
        </E2eeAutomaticPairingInbox>
      )
    );
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-code"]')).toBeNull();
    submitted = true;
    await tick(2_000);
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-code"]')).not.toBeNull();
    await act(async () => root.unmount());
    expect(unsubscribed).toBe(true);
    root = createRoot(container);
  });
});
