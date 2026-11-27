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

  it('signs every listed workspace once, with no confirmation, as soon as a scanned request verifies', async () => {
    const { E2eeInstantQrApprove } = await import('../src/components/pages/e2ee-instant-qr');
    const removeTelemetryScope = installWorkspaceTelemetryScope(() => 'ordinary-under-approval');
    setTelemetryRouteTarget('ordinary-under-approval', true);
    const replay = () =>
      postHogPrivacy.beforeSend({
        event: '$snapshot',
        properties: { $snapshot_data: ['synthetic private surface'] },
      });
    let submitted = false;
    const approvals: unknown[] = [];
    let settle: (() => void) | undefined;
    const runtime = {
      accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
      // `null` until the phone submits its request under this code.
      inspectAccountPairing: async (code: string) => {
        expect(code).toBe(CODE);
        return submitted ? preview : null;
      },
      approveAccountPairing: (input: unknown) => {
        approvals.push(input);
        return new Promise((resolve) => {
          settle = () =>
            resolve({
              workspaces: [
                { workspaceId: 'w1', outcome: 'admitted' },
                { workspaceId: 'w2', outcome: 'admitted' },
              ],
            });
        });
      },
    } as unknown as E2eeWorkspaceRuntime;
    const joined: string[] = [];
    try {
      await act(async () =>
        root.render(<E2eeInstantQrApprove runtime={runtime} onJoined={(d) => joined.push(d)} />)
      );
      await flush();
      expect(qr.payloads.at(-1)).toBe(`lody://pair/${CODE.replace(/-/g, '')}`);
      expect(replay()).toBeNull();
      await tick(900);
      expect(approvals).toEqual([]);
      submitted = true;
      await tick(900);
      await flush();
      // Polls keep finding the request while the host signs: still exactly one approval.
      await tick(900);
      await tick(900);
      expect(approvals).toEqual([
        { pairingString: CODE, requestId: 'request-1', workspaceIds: ['w1', 'w2'] },
      ]);
      expect(text()).toContain('e2ee.instantQr.joining {"device":"Synthetic phone"}');
      expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
        'common.cancel',
      ]);
      await act(async () => settle!());
      await flush();
      expect(text()).toContain('e2ee.instantQr.joined {"device":"Synthetic phone"}');
      expect(joined).toEqual(['Synthetic phone']);
      await act(async () => root.render(<></>));
      await flush();
      expect(replay()).toBeNull();
    } finally {
      removeTelemetryScope();
    }
  });

  it('keeps resuming the same approval until it is delivered, through transient failures', async () => {
    const { E2eeInstantQrApprove } = await import('../src/components/pages/e2ee-instant-qr');
    const outcomes: ('awaiting-delivery' | 'admitted' | Error)[] = [
      'awaiting-delivery',
      new Error('synthetic network blip'),
      'admitted',
    ];
    const approvals: unknown[] = [];
    let offers = 0;
    const runtime = {
      accountPairingCode: async () => {
        offers += 1;
        return { pairingString: CODE, expiresAt: NOW + 600_000 };
      },
      inspectAccountPairing: async () => preview,
      approveAccountPairing: async (input: unknown) => {
        approvals.push(input);
        const next = outcomes.shift()!;
        if (next instanceof Error) throw next;
        return {
          workspaces: [
            { workspaceId: 'w1', outcome: next },
            { workspaceId: 'w2', outcome: next },
          ],
        };
      },
    } as unknown as E2eeWorkspaceRuntime;
    const joined: string[] = [];
    await act(async () =>
      root.render(<E2eeInstantQrApprove runtime={runtime} onJoined={(d) => joined.push(d)} />)
    );
    await flush();
    for (const _ of [1, 2]) {
      await tick(900);
      await flush();
      // Signed but undelivered, then a blip: still joining, never reported joined.
      expect(text()).toContain('e2ee.instantQr.joining');
      expect(joined).toEqual([]);
    }
    await tick(900);
    await flush();
    expect(text()).toContain('e2ee.instantQr.joined');
    expect(joined).toEqual(['Synthetic phone']);
    // The same code and request every time; no new code replaced the scanned one.
    expect(offers).toBe(1);
    expect(new Set(approvals.map((input) => JSON.stringify(input))).size).toBe(1);
    expect(approvals).toHaveLength(3);
  });

  it('surfaces transient retry status during joining and never overwrites awaiting-delivery as expired', async () => {
    const { E2eeInstantQrApprove } = await import('../src/components/pages/e2ee-instant-qr');
    const outcomes: ('awaiting-delivery' | 'admitted' | Error)[] = [
      'awaiting-delivery',
      new Error('503 Service Unavailable'),
      'admitted',
    ];
    const runtime = {
      accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 1_500 }),
      inspectAccountPairing: async () => preview,
      approveAccountPairing: async () => {
        const next = outcomes.shift()!;
        if (next instanceof Error) throw next;
        return {
          workspaces: [
            { workspaceId: 'w1', outcome: next },
            { workspaceId: 'w2', outcome: next },
          ],
        };
      },
    } as unknown as E2eeWorkspaceRuntime;
    const joined: string[] = [];
    await act(async () =>
      root.render(<E2eeInstantQrApprove runtime={runtime} onJoined={(d) => joined.push(d)} />)
    );
    await flush();
    await tick(900);
    await flush();
    expect(text()).toContain('e2ee.instantQr.joining');
    expect(container.querySelector('[data-testid="e2ee-instant-qr-retrying"]')).toBeNull();
    // Advance past offer.expiresAt: awaiting-delivery must keep retrying instead of flipping to expired.
    await tick(900);
    await flush();
    expect(text()).not.toContain('e2ee.instantQr.expired');
    expect(container.querySelector('[data-testid="e2ee-instant-qr-retrying"]')?.textContent).toBe(
      'e2ee.instantQr.retrying'
    );
    await tick(900);
    await flush();
    expect(text()).toContain('e2ee.instantQr.joined');
    expect(joined).toEqual(['Synthetic phone']);
  });

  it('offers a fresh code once the shown one expires, without signing', async () => {
    const { E2eeInstantQrApprove } = await import('../src/components/pages/e2ee-instant-qr');
    let offers = 0;
    const approve = vi.fn();
    const runtime = {
      accountPairingCode: async () => {
        offers += 1;
        return { pairingString: CODE, expiresAt: NOW + 1_000 };
      },
      inspectAccountPairing: async () => null,
      approveAccountPairing: approve,
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () => root.render(<E2eeInstantQrApprove runtime={runtime} />));
    await flush();
    await tick(900);
    await tick(900);
    expect(text()).toContain('e2ee.instantQr.expired');
    await click('e2ee.instantQr.refresh');
    await flush();
    expect(offers).toBe(2);
    expect(approve).not.toHaveBeenCalled();
  });

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

  it('on a computer shows the QR code with the request at once, keeps it through the request leaving, and approves the scanning phone', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceDesktopLayoutProvider } = await import('../src/hooks/use-mobile');
    let rows = [review];
    let offers = 0,
      submitted = false;
    const approvals: unknown[] = [];
    const runtime = {
      pendingAutomaticPairing: async () => rows,
      approveAutomaticPairing: async () => {},
      declineAutomaticPairing: async () => {},
      accountPairingCode: async () => {
        offers += 1;
        return { pairingString: CODE, expiresAt: NOW + 600_000 };
      },
      inspectAccountPairing: async () => (submitted ? preview : null),
      approveAccountPairing: async (input: unknown) => {
        approvals.push(input);
        return { workspaces: [{ workspaceId: 'w1', outcome: 'admitted' }] };
      },
    } as unknown as E2eeWorkspaceRuntime;
    // Settings is open: the request still presents over it.
    const settings = document.createElement('div');
    settings.setAttribute('role', 'dialog');
    document.body.append(settings);
    await act(async () =>
      root.render(
        <ForceDesktopLayoutProvider>
          <E2eeAutomaticPairingInbox runtime={runtime} />
        </ForceDesktopLayoutProvider>
      )
    );
    await flush();
    // No click reveals the code (owner decision); the typed-code path stays below it, and
    // the scope says what each path grants.
    expect(offers).toBe(1);
    expect(document.querySelector('[data-testid="e2ee-approval-show-qr"]')).toBeNull();
    expect(document.querySelector('[data-testid="e2ee-approval-code"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="e2ee-approval-scan-start"]')).toBeNull();
    expect(document.body.textContent).toContain('e2ee.auto.scopeWithQr');
    expect(document.body.textContent).not.toContain('e2ee.auto.currentWorkspaceOnly');
    settings.remove();
    rows = [];
    await tick(2000);
    await flush();
    expect(document.querySelector('[data-testid="e2ee-instant-qr"]')).not.toBeNull();
    submitted = true;
    await tick(900);
    await flush();
    expect(offers).toBe(1);
    expect(approvals).toEqual([
      { pairingString: CODE, requestId: 'request-1', workspaceIds: ['w1', 'w2'] },
    ]);
    expect(document.body.textContent).toContain('e2ee.instantQr.joined');
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

  it('on a phone shows one approval method and reaches the others by link', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let offers = 0;
    const runtime = {
      pendingAutomaticPairing: async () => [review],
      approveAutomaticPairing: async () => {},
      declineAutomaticPairing: async () => {},
      accountPairingCode: async () => {
        offers += 1;
        return { pairingString: CODE, expiresAt: NOW + 600_000 };
      },
      inspectAccountPairing: async () => null,
      approveAccountPairing: async () => ({ workspaces: [] }),
    } as unknown as E2eeWorkspaceRuntime;
    const shown = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return Boolean(element && !element.closest('[hidden]'));
    };
    const link = (testId: string) =>
      document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
    try {
      await act(async () =>
        root.render(
          <ForceMobileLayoutProvider force>
            <E2eeAutomaticPairingInbox runtime={runtime} />
          </ForceMobileLayoutProvider>
        )
      );
      await flush();
      // Scanning the new screen leads; typing and this phone's own code are links.
      expect(shown('e2ee-approval-scan-start')).toBe(true);
      expect(shown('e2ee-approval-code')).toBe(false);
      expect(shown('e2ee-instant-qr')).toBe(false);
      expect(offers).toBe(0);
      await act(async () => link('e2ee-approval-method-code').click());
      expect(shown('e2ee-approval-code')).toBe(true);
      expect(shown('e2ee-approval-scan-start')).toBe(false);
      await act(async () => link('e2ee-approval-show-qr').click());
      await flush();
      expect(shown('e2ee-instant-qr')).toBe(true);
      expect(shown('e2ee-approval-code')).toBe(false);
      expect(offers).toBe(1);
      // Leaving the shown code ends that offer.
      await act(async () => link('e2ee-approval-method-scan').click());
      expect(document.querySelector('[data-testid="e2ee-instant-qr"]')).toBeNull();
      expect(shown('e2ee-approval-scan-start')).toBe(true);
    } finally {
      focus.mockRestore();
      restoreCamera();
    }
  });

  it('on a new phone explains the wait, then joins by scanning without ending discovery early', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const calls: string[] = [];
    let status: E2eeAccountPairingRequestState['status'] = 'waiting';
    const request = (): E2eeAccountPairingRequestState => ({
      expiresAt: NOW + 600_000,
      status,
      workspaces: [
        { workspaceId: 'w1', name: 'Alpha', state: status === 'joined' ? 'joined' : 'pending' },
      ],
    });
    const runtime = {
      automaticPairingState: async () => {
        calls.push('state');
        return {
          id: 'request',
          workspaceId: 'w1',
          workspaceName: 'Alpha',
          deviceName: 'Phone',
          comparisonCode: null,
          expiresAt: NOW + 300_000,
          phase: 'preparing',
        };
      },
      cancelAutomaticPairing: async () => {
        calls.push('cancel');
      },
      requestAccountPairing: async (input: { pairingString?: string }) => {
        calls.push(`request:${input.pairingString}`);
        return request();
      },
      accountPairingRequest: async () => request(),
    } as unknown as E2eeWorkspaceRuntime;
    let joined = 0;
    try {
      await act(async () =>
        root.render(
          <ForceMobileLayoutProvider force>
            <E2eeAutomaticPairingPage
              runtime={runtime}
              workspaceId="w1"
              onJoined={() => (joined += 1)}
              onBack={() => {}}
            />
          </ForceMobileLayoutProvider>
        )
      );
      await flush();
      expect(text()).toContain('e2ee.auto.awaiting.title');
      expect(text()).not.toContain('···');
      await click('e2ee.auto.scanJoin');
      await act(async () => qr.scan!(`lody://pair/${CODE.replace(/-/g, '')}`));
      await flush();
      expect(calls).toContain(`request:lody://pair/${CODE.replace(/-/g, '')}`);
      expect(text()).toContain('e2ee.instantQr.scannedJoining');
      const polled = calls.filter((call) => call === 'state').length;
      await tick(2000);
      // Automatic discovery waits, and stays open, while the scanned join settles.
      expect(calls.filter((call) => call === 'state').length).toBe(polled);
      expect(calls).not.toContain('cancel');
      expect(joined).toBe(0);
      status = 'joined';
      await tick(800);
      await flush();
      expect(joined).toBe(1);
      expect(calls.at(-1)).toBe('cancel');
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
      expect(text()).toContain('e2ee.auto.showCode.desktop');
      expect(text()).not.toContain('e2ee.auto.scanPrompt');
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
  it('on a computer leads with one method and switches to the other with a link, never page tabs', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceDesktopLayoutProvider } = await import('../src/hooks/use-mobile');
    let rows: (typeof review & { requesterDeviceKind?: 'desktop' })[] = [review];
    const runtime = {
      pendingAutomaticPairing: async () => rows,
      approveAutomaticPairing: async () => {},
      declineAutomaticPairing: async () => {},
      accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
      inspectAccountPairing: async () => null,
      approveAccountPairing: async () => ({ workspaces: [] }),
    } as unknown as E2eeWorkspaceRuntime;
    const visible = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      return Boolean(element && !element.closest('[hidden]'));
    };
    const switchMethod = () =>
      document.querySelector('[data-testid="e2ee-approval-switch"]') as HTMLButtonElement;
    await act(async () =>
      root.render(
        <ForceDesktopLayoutProvider>
          <E2eeAutomaticPairingInbox runtime={runtime} />
        </ForceDesktopLayoutProvider>
      )
    );
    await flush();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    // Without a requester hint a phone is the likely scanner: the QR code leads.
    expect(visible('e2ee-instant-qr')).toBe(true);
    expect(visible('e2ee-approval-code')).toBe(false);
    expect(switchMethod().textContent).toBe('e2ee.auto.switchToCode');
    await act(async () => switchMethod().click());
    expect(visible('e2ee-approval-code')).toBe(true);
    expect(visible('e2ee-instant-qr')).toBe(false);
    expect(switchMethod().textContent).toBe('e2ee.auto.switchToQr');
    await act(async () => root.render(<div />));

    // A requester that reports a computer leads with the typed code; the QR stays one link away.
    rows = [{ ...review, id: 'desk-request', requesterDeviceKind: 'desktop' }];
    await act(async () =>
      root.render(
        <ForceDesktopLayoutProvider>
          <E2eeAutomaticPairingInbox runtime={runtime} />
        </ForceDesktopLayoutProvider>
      )
    );
    await flush();
    expect(visible('e2ee-approval-code')).toBe(true);
    expect(visible('e2ee-instant-qr')).toBe(false);
    expect(switchMethod().textContent).toBe('e2ee.auto.switchToQr');
  });

  it('on a phone browser asks for consent and scanning on one view, then joins with the scanned code', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const host = requesterHost();
    let started = 0;
    const runtime = {
      ...host.runtime,
      requirePersonalComputer: true,
      automaticPairingState: async () => null,
      startAutomaticPairing: async () => {
        started += 1;
        return { ...review, comparisonCode: '123456' };
      },
      cancelAutomaticPairing: async () => {},
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
      // Scanning waits for the consent, like the request it replaces.
      expect((button('e2ee.auto.scanJoin') as HTMLButtonElement).disabled).toBe(true);
      await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
      await click('e2ee.auto.scanJoin');
      await flush();
      expect(container.querySelector('[data-testid="e2ee-qr-viewfinder"]')).not.toBeNull();
      await act(async () => qr.scan!(`lody://pair/${CODE.replace(/-/g, '')}`));
      await flush();
      expect(host.started).toEqual([{ pairingString: `lody://pair/${CODE.replace(/-/g, '')}` }]);
      expect(started).toBe(0);
      expect(container.querySelector('[data-testid="e2ee-qr-joining"]')).not.toBeNull();
    } finally {
      restoreCamera();
    }
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
    // External BROWSABLE links are untrusted: show the carried code to compare instead of an
    // input to fill, and never sign without a click.
    expect(entered).toEqual([]);
    expect(document.body.textContent).toContain('Phone');
    expect(document.querySelector('[data-testid="e2ee-approval-linked"]')?.textContent).toContain(
      '246 810'
    );
    const field = document.querySelector('[data-testid="e2ee-approval-code"]') as HTMLInputElement;
    expect(field.value).toBe('246810');
    expect(field.closest('[hidden]')).not.toBeNull();
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
    expect(
      (document.querySelector('[data-testid="e2ee-approval-code"]') as HTMLInputElement | null)
        ?.value
    ).toBe('246810');
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
    expect(field.closest('[hidden]')).toBeNull();
    expect(document.body.textContent).toContain('e2ee.auto.codeMismatch');
  });

  it('keeps cold-parked pair links across inbox remounts and joins from the join page at once', async () => {
    const {
      derivePairingKeys,
      disposePairingKeys,
      encodePairingSecret,
      formatPairingString,
      parsePairingString,
    } = await import('@lody/e2ee-core/protocol');
    const { Result } = await import('effect');
    const { E2eeAutomaticPairingInbox, E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const secondCode = Result.getOrThrow(encodePairingSecret(new Uint8Array(16).fill(7)));
    const pairUrl = `lody://pair/${CODE.replace(/-/g, '')}`;
    const secondPairUrl = `lody://pair/${formatPairingString(secondCode).replace(/-/g, '')}`;
    const lookupOf = (url: string) => {
      const secret = Result.getOrThrow(parsePairingString(url));
      const keys = Result.getOrThrow(derivePairingKeys(secret));
      const hex = Array.from(keys.lookupId, (b) => b.toString(16).padStart(2, '0')).join('');
      disposePairingKeys(keys);
      secret.fill(0);
      return hex;
    };
    const expectedFirstLookup = lookupOf(pairUrl);
    const expectedSecondLookup = lookupOf(secondPairUrl);

    const requested: { pairingString?: string; preserveExisting?: boolean }[] = [];
    const cancelled: ({ expectedLookupId: string } | undefined)[] = [];
    let joinedCount = 0;
    let autoStarted = 0;
    let currentState: E2eeAccountPairingRequestState | null = null;
    const runtime = {
      pendingAutomaticPairing: async () => [],
      automaticPairingState: async () => null,
      startAutomaticPairing: async () => {
        autoStarted += 1;
        return {
          id: 'request',
          workspaceId: 'w1',
          workspaceName: 'Alpha',
          deviceName: 'Phone',
          comparisonCode: null,
          expiresAt: NOW + 300_000,
          phase: 'preparing' as const,
        };
      },
      cancelAutomaticPairing: async () => {},
      requestAccountPairing: async (input: {
        pairingString?: string;
        preserveExisting?: boolean;
      }) => {
        requested.push(input);
        return currentState!;
      },
      accountPairingRequest: async () => currentState,
      cancelAccountPairing: async (input?: { expectedLookupId: string }) => {
        cancelled.push(input);
      },
    } as unknown as E2eeWorkspaceRuntime;

    // 1. Cold launch with key="signed-out" -> authenticated user remount does not consume or drop
    // the parked pair link while no join page is open.
    currentState = {
      lookupId: expectedFirstLookup,
      direction: 'approver-shows',
      pairingString: null,
      expiresAt: NOW + 600_000,
      status: 'waiting',
      workspaces: [{ workspaceId: 'w1', name: 'Alpha', state: 'pending', approval: 'waiting' }],
    };
    (window as { __LODY_PENDING_E2EE_PAIR_URL__?: string }).__LODY_PENDING_E2EE_PAIR_URL__ =
      pairUrl;
    await act(async () =>
      root.render(<E2eeAutomaticPairingInbox key="signed-out" runtime={runtime} />)
    );
    await flush();
    expect(requested).toEqual([]);
    await act(async () =>
      root.render(
        <ForceMobileLayoutProvider force>
          <E2eeAutomaticPairingInbox key="user-1" runtime={runtime}>
            <E2eeAutomaticPairingPage
              runtime={runtime}
              workspaceId="w1"
              onJoined={() => {
                joinedCount += 1;
              }}
              onBack={() => {}}
            />
          </E2eeAutomaticPairingInbox>
        </ForceMobileLayoutProvider>
      )
    );
    await flush();
    // The join page submits the link at once (owner decision, 2026-11-27) and holds the
    // automatic request while the cancelable join runs.
    expect(autoStarted).toBe(0);
    expect(requested).toEqual([{ pairingString: pairUrl }]);
    expect(document.querySelector('[data-testid="e2ee-qr-joining"]')).not.toBeNull();
    // The join's own Cancel is the only way out while it runs.
    expect(
      [...document.querySelectorAll('button')].filter((value) =>
        /^(common\.cancel|e2ee\.auto\.cancel)$/.test(value.textContent ?? '')
      )
    ).toHaveLength(1);
    expect(document.body.textContent).toContain('e2ee.auto.joining.title');
    expect(document.body.textContent).not.toContain('e2ee.auto.noRequest');
    expect(document.body.textContent).not.toContain('e2ee.auto.requesting');
    expect(document.querySelector('[data-testid="e2ee-lost-all-entry"]')).toBeNull();

    // 2. Leaving/unmounting while the link request is still waiting cancels its lookupId.
    await act(async () => root.render(<div />));
    await flush();
    expect(cancelled).toEqual([{ expectedLookupId: expectedFirstLookup }]);

    // 3. Partial join where w1 joined and w2 was omitted cancels expectedLookupId once settled.
    requested.length = 0;
    cancelled.length = 0;
    currentState = {
      lookupId: expectedSecondLookup,
      direction: 'approver-shows',
      pairingString: null,
      expiresAt: NOW + 600_000,
      status: 'waiting',
      workspaces: [
        { workspaceId: 'w1', name: 'Alpha', state: 'joined', approval: 'approved' },
        { workspaceId: 'w2', name: 'Beta', state: 'pending', approval: 'omitted' },
      ],
    };
    await act(async () =>
      root.render(
        <ForceMobileLayoutProvider force>
          <E2eeAutomaticPairingInbox key="user-1" runtime={runtime}>
            <E2eeAutomaticPairingPage
              runtime={runtime}
              workspaceId="w1"
              onJoined={() => {
                joinedCount += 1;
              }}
              onBack={() => {}}
            />
          </E2eeAutomaticPairingInbox>
        </ForceMobileLayoutProvider>
      )
    );
    await flush();
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('lody:e2ee-pair-url', { detail: { url: secondPairUrl } })
      )
    );
    await flush();
    expect(requested).toEqual([{ pairingString: secondPairUrl }]);
    expect(joinedCount).toBe(1);
    expect(cancelled).toEqual([{ expectedLookupId: expectedSecondLookup }]);
  });

  it('keeps a device that joined by code from popping its request up afterwards', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { E2eeAddDeviceCard } = await import('../src/components/pages/e2ee-instant-qr');
    let submitted = false;
    const runtime = {
      pendingAutomaticPairing: async () => [review],
      approveAutomaticPairing: async () => {},
      declineAutomaticPairing: async () => {},
      accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
      inspectAccountPairing: async () =>
        submitted
          ? {
              requestId: 'request-1',
              deviceName: 'Phone',
              approximateLocation: null,
              requestedAt: NOW,
              expiresAt: NOW + 600_000,
              workspaces: [{ workspaceId: 'w1', name: 'Alpha' }],
              unavailable: [{ workspaceId: 'w9', name: 'Omega' }],
            }
          : null,
      approveAccountPairing: async () => ({
        workspaces: [{ workspaceId: 'w1', outcome: 'admitted' }],
      }),
    } as unknown as E2eeWorkspaceRuntime;
    // The console's own QR card marks itself as a pairing surface: the popup waits.
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingInbox runtime={runtime}>
          <E2eeAddDeviceCard runtime={runtime} defaultShowQr />
        </E2eeAutomaticPairingInbox>
      )
    );
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-code"]')).toBeNull();
    // The waiting request is reachable from the card.
    expect(document.querySelector('[data-testid="e2ee-waiting-requests"]')).not.toBeNull();
    submitted = true;
    await tick(900);
    await flush();
    expect(text()).toContain('e2ee.instantQr.joined');
    expect(text()).toContain('e2ee.instantQr.unavailable {"count":1,"names":"Omega"}');
    await tick(2000);
    await flush();
    expect(document.querySelector('[data-testid="e2ee-approval-code"]')).toBeNull();
  });

  it('opens the typed-code panel inside the Add device card, not as a second card', async () => {
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
  });

  it('names a code for the other role instead of calling it unreadable', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const runtime = {
      automaticPairingState: async () => ({
        id: 'request',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Phone',
        comparisonCode: null,
        expiresAt: NOW + 300_000,
        phase: 'preparing',
      }),
      requestAccountPairing: vi.fn(),
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
      await click('e2ee.auto.scanJoin');
      await act(async () => qr.scan!('lody://auto-pair?id=request&code=123456'));
      await flush();
      expect(text()).toContain('e2ee.instantQr.wrongRole');
      expect(runtime.requestAccountPairing).not.toHaveBeenCalled();
    } finally {
      restoreCamera();
    }
  });

  it('lets a scanned join be cancelled or end on a partial join, then ends its own request', async () => {
    const restoreCamera = withCamera();
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const { ForceMobileLayoutProvider } = await import('../src/hooks/use-mobile');
    const calls: string[] = [];
    let workspaces: E2eeAccountPairingRequestState['workspaces'] = [
      { workspaceId: 'w1', name: 'Alpha', state: 'pending' },
      { workspaceId: 'w2', name: 'Beta', state: 'pending' },
    ];
    const request = (): E2eeAccountPairingRequestState => ({
      expiresAt: NOW + 600_000,
      status: 'waiting',
      workspaces,
    });
    const runtime = {
      automaticPairingState: async () => {
        calls.push('state');
        return {
          id: 'request',
          workspaceId: 'w1',
          workspaceName: 'Alpha',
          deviceName: 'Phone',
          comparisonCode: null,
          expiresAt: NOW + 300_000,
          phase: 'preparing',
        };
      },
      cancelAutomaticPairing: async () => {
        calls.push('cancelAutomatic');
      },
      requestAccountPairing: async () => request(),
      accountPairingRequest: async () => request(),
      cancelAccountPairing: async () => {
        calls.push('cancelAccount');
      },
    } as unknown as E2eeWorkspaceRuntime;
    const scan = async () => {
      await click('e2ee.auto.scanJoin');
      await act(async () => qr.scan!(`lody://pair/${CODE.replace(/-/g, '')}`));
      await flush();
    };
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
      await scan();
      await click('common.cancel');
      expect(calls).toContain('cancelAccount');
      expect(calls).not.toContain('cancelAutomatic');
      // The automatic request resumes.
      const before = calls.filter((call) => call === 'state').length;
      await tick(2000);
      expect(calls.filter((call) => call === 'state').length).toBeGreaterThan(before);
      calls.length = 0;
      await scan();
      // Approved but still installing (a slow history download): never cut short.
      workspaces = [
        { workspaceId: 'w1', name: 'Alpha', state: 'pending', approval: 'approved' },
        { workspaceId: 'w2', name: 'Beta', state: 'joined', approval: 'approved' },
      ];
      for (let poll = 0; poll < 10; poll++) await tick(800);
      await flush();
      expect(text()).toContain('e2ee.instantQr.scannedJoining');
      expect(calls).not.toContain('cancelAccount');
      // Left out of the verified approval, with nothing else still installing.
      workspaces = [
        { workspaceId: 'w1', name: 'Alpha', state: 'pending', approval: 'omitted' },
        { workspaceId: 'w2', name: 'Beta', state: 'joined', approval: 'approved' },
      ];
      await tick(800);
      await flush();
      expect(text()).toContain('e2ee.instantQr.partial');
      expect(calls).toContain('cancelAccount');
    } finally {
      restoreCamera();
    }
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

  it('opens the Instant QR dialog immediately on a preparing review and coalesces in-flight subscription wakeups', async () => {
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
        phase: 'preparing' as const,
      },
    ];
    let currentPhase: 'preparing' | 'waiting' = 'preparing';
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
        return Promise.resolve([{ ...waitingRows[0]!, phase: currentPhase }]);
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
      // Coalesced immediately without waiting for the 2s interval, and Instant QR is already visible on preparing!
      expect(calls).toBe(2);
      expect(document.querySelector('[data-testid="e2ee-instant-qr"]')).not.toBeNull();
      // Promote to waiting via another wakeup.
      currentPhase = 'waiting';
      await act(async () => listener!());
      await flush();
      expect(calls).toBe(3);
      expect(document.querySelector('[data-testid="e2ee-instant-qr"]')).not.toBeNull();
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

  it('wakes instant QR approval immediately on subscribeAccountPairingApproval without waiting for poll', async () => {
    const { E2eeInstantQrApprove } = await import('../src/components/pages/e2ee-instant-qr');
    let onSignal: (() => void) | undefined;
    let unsubscribed = false;
    let submitted = false;
    const lookupId = 'ab'.repeat(16);
    const runtime = {
      accountPairingCode: async () => ({
        pairingString: CODE,
        expiresAt: NOW + 600_000,
        lookupId,
      }),
      subscribeAccountPairingApproval: (id: string, changed: () => void) => {
        expect(id).toBe(lookupId);
        onSignal = changed;
        return () => {
          unsubscribed = true;
        };
      },
      inspectAccountPairing: async () => (submitted ? preview : null),
      approveAccountPairing: async () => ({
        workspaces: [{ workspaceId: 'w1', outcome: 'admitted' }],
      }),
    } as unknown as E2eeWorkspaceRuntime;
    const joined: string[] = [];
    await act(async () =>
      root.render(<E2eeInstantQrApprove runtime={runtime} onJoined={(d) => joined.push(d)} />)
    );
    await flush();
    expect(onSignal).toBeDefined();
    submitted = true;
    await act(async () => onSignal!());
    await flush();
    expect(joined).toEqual(['Synthetic phone']);
    expect(unsubscribed).toBe(true);
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
