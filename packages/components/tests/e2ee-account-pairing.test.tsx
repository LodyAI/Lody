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
  E2eeAutomaticPairingState,
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
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
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

describe('new device request', () => {
  it('does not open a workspace from a retained requester result on an approver-only host', async () => {
    let openedWorkspace = false;
    const runtime = {
      accountPairingRequest: async (): Promise<E2eeAccountPairingRequestState> => ({
        direction: 'requester-shows',
        pairingString: null,
        expiresAt: NOW + 600_000,
        status: 'joined',
        workspaces: [{ workspaceId: 'w1', name: 'Alpha', state: 'joined' }],
      }),
    };
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest
          runtime={runtime}
          autoStart={false}
          onJoined={() => {
            openedWorkspace = true;
          }}
        />
      )
    );
    expect(container.textContent).toBe('');
    expect(openedWorkspace).toBe(false);
  });
  it('starts automatically on desktop and mobile, shows the code, and finishes once approved', async () => {
    const host = requesterHost();
    let joined = 0;
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={host.runtime} autoStart onJoined={() => joined++} />
      )
    );
    expect(host.started).toEqual([{ pairingString: undefined }]);
    expect(
      container.querySelector('[data-testid="e2ee-account-pairing-string"]')?.textContent
    ).toBe(CODE);
    expect(qr.payloads.at(-1)).toBe('lody://pair/50M6HA7955MTKTHADANEPAVBNF38');
    expect(text()).toContain('e2ee.accountPair.request.private');
    // Still waiting: polling changes nothing.
    await tick();
    expect(joined).toBe(0);
    host.state = { ...host.state!, status: 'joined', pairingString: null };
    await tick();
    expect(text()).toContain('e2ee.accountPair.request.joined');
    expect(container.querySelector('[data-testid="e2ee-account-pairing-string"]')).toBeNull();
    await tick();
    expect(joined).toBe(1);
  });

  it('learns of an approval from the relay hint before the next poll, and releases the hint once joined', async () => {
    // Without the hint the new device sits idle until its poll; the poll stays the fallback.
    const host = requesterHost();
    const lookupId = 'ab'.repeat(16);
    const hints = new Map<string, () => void>();
    const runtime = {
      ...host.runtime,
      requestAccountPairing: async (input: { pairingString?: string }) => ({
        ...(await host.runtime.requestAccountPairing!(input)),
        lookupId,
      }),
      accountPairingRequest: async () => host.state && { ...host.state, lookupId },
      subscribeAccountPairingRequest: (id: string, changed: () => void) => {
        hints.set(id, changed);
        return () => hints.delete(id);
      },
    };
    let joined = 0;
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={runtime} autoStart onJoined={() => joined++} />
      )
    );
    expect([...hints.keys()]).toEqual([lookupId]);
    host.state = { ...host.state!, status: 'joined', pairingString: null };
    await act(async () => {
      hints.get(lookupId)!();
      await Promise.resolve();
    });
    expect(text()).toContain('e2ee.accountPair.request.joined');
    expect(hints.size).toBe(0);
  });

  // Desktop IPC carries only the message; the reason must survive to the screen
  // instead of a generic "Pairing failed".
  it.each(['pairing-unavailable', 'pairing-rate-limited', 'pairing-elsewhere'])(
    'explains a relay refusal (%s) from the desktop host',
    async (code) => {
      const host = requesterHost();
      host.runtime.requestAccountPairing = () =>
        withAccountPairingCode(
          Promise.reject(
            new Error(
              `Error invoking remote method 'e2ee.requestAccountPairing': Error: e2ee_${code}`
            )
          )
        );
      await act(async () =>
        root.render(
          <E2eeAccountPairingRequest runtime={host.runtime} autoStart onJoined={() => {}} />
        )
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        `e2ee.accountPair.error.${code}`
      );
    }
  );

  it('on Web asks before creating any request', async () => {
    const host = requesterHost();
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={host.runtime} autoStart={false} onJoined={() => {}} />
      )
    );
    expect(host.started).toEqual([]);
    expect(text()).toContain('e2ee.accountPair.request.web');
    await click('e2ee.accountPair.request.start');
    expect(host.started).toHaveLength(1);
    expect(text()).toContain(CODE);
  });

  it('recovers a retained open request instead of starting another', async () => {
    const host = requesterHost();
    await host.runtime.requestAccountPairing!({});
    host.started = [];
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={host.runtime} autoStart onJoined={() => {}} />
      )
    );
    expect(host.started).toEqual([]);
    expect(text()).toContain(CODE);
  });

  it('checks a code from the other device locally before handing it to the host', async () => {
    const host = requesterHost({
      direction: 'requester-shows',
      pairingString: CODE,
      expiresAt: NOW,
      status: 'expired',
      workspaces: [],
    });
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={host.runtime} autoStart={false} onJoined={() => {}} />
      )
    );
    expect(text()).toContain('e2ee.accountPair.request.expired');
    await click('e2ee.accountPair.request.haveCode');
    await type(TYPO);
    await click('e2ee.accountPair.request.useCode');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'e2ee.accountPair.code.checksum'
    );
    await type(CODE.slice(0, 20));
    await click('e2ee.accountPair.request.useCode');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'e2ee.accountPair.code.length'
    );
    expect(host.started).toEqual([]);
    await type(` ${CODE.toLowerCase()} `);
    await click('e2ee.accountPair.request.useCode');
    expect(host.started).toEqual([{ pairingString: CODE.toLowerCase() }]);
    expect(text()).toContain('e2ee.accountPair.request.answered');
  });

  it('names workspaces blocked by an unfinished per-workspace pairing', async () => {
    const host = requesterHost({
      direction: 'requester-shows',
      pairingString: CODE,
      expiresAt: NOW + 600_000,
      status: 'waiting',
      workspaces: [
        { workspaceId: 'w1', name: 'Alpha', state: 'joined' },
        { workspaceId: 'w2', name: 'Beta', state: 'blocked' },
      ],
    });
    await host.runtime.requestAccountPairing!({});
    host.state = {
      ...host.state!,
      workspaces: [
        { workspaceId: 'w1', name: 'Alpha', state: 'joined' },
        { workspaceId: 'w2', name: 'Beta', state: 'blocked' },
      ],
    };
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={host.runtime} autoStart onJoined={() => {}} />
      )
    );
    expect(text()).toContain('e2ee.accountPair.request.blocked {"names":"Beta"}');
  });

  it('starting again abandons the old request before creating a new one', async () => {
    const host = requesterHost({
      direction: 'requester-shows',
      pairingString: null,
      expiresAt: NOW,
      status: 'declined',
      workspaces: [],
    });
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={host.runtime} autoStart={false} onJoined={() => {}} />
      )
    );
    expect(text()).toContain('e2ee.accountPair.request.declined');
    await click('e2ee.accountPair.request.restart');
    expect(host.cancelled).toBe(1);
    expect(host.state?.status).toBe('waiting');
    expect(text()).toContain(CODE);
  });
});

describe('approving device', () => {
  it('shows the fixed warning and the named target, and signs only the selected workspaces', async () => {
    const host = approverHost();
    await act(async () => root.render(<E2eeAccountPairingApprove runtime={host.runtime} />));
    await type(CODE);
    await click('e2ee.accountPair.approve.check');
    expect(host.inspected).toEqual([CODE]);
    expect(text()).toContain('e2ee.accountPair.approve.warning');
    expect(text()).toContain('e2ee.accountPair.approve.device');
    expect(text()).toContain('e2ee.accountPair.approve.location');
    expect(text()).toContain('e2ee.accountPair.approve.locationUnknown');
    expect(
      container.querySelector('[data-testid="e2ee-account-pairing-device"]')?.textContent
    ).toBe('Synthetic phone');
    expect(text()).toContain('"names":"Gamma"');
    expect(text()).toContain('"count":2,"total":2');
    // Deselect Alpha: only Beta is signed.
    await act(async () =>
      (container.querySelector('[aria-label="Alpha"]') as HTMLButtonElement).click()
    );
    expect(text()).toContain('"count":1,"total":2');
    await click('e2ee.accountPair.approve.approve');
    expect(host.approved).toEqual([['w2']]);
    const outcomes = [...container.querySelectorAll('[data-outcome]')].map((item) =>
      item.getAttribute('data-outcome')
    );
    expect(outcomes).toEqual(['admitted']);
    expect(text()).toContain('"name":"Beta"');
  });

  it('cannot approve with every workspace deselected', async () => {
    const host = approverHost();
    await act(async () => root.render(<E2eeAccountPairingApprove runtime={host.runtime} />));
    await type(CODE);
    await click('e2ee.accountPair.approve.check');
    for (const name of ['Alpha', 'Beta'])
      await act(async () =>
        (container.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement).click()
      );
    expect(button('e2ee.accountPair.approve.approve').disabled).toBe(true);
    expect(host.approved).toEqual([]);
  });

  it('names typing mistakes before any request and refuses a tampered request', async () => {
    const host = approverHost();
    await act(async () => root.render(<E2eeAccountPairingApprove runtime={host.runtime} />));
    await type(TYPO);
    await click('e2ee.accountPair.approve.check');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'e2ee.accountPair.code.checksum'
    );
    await type(`U${CODE.slice(1)}`);
    await click('e2ee.accountPair.approve.check');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'e2ee.accountPair.code.character'
    );
    expect(host.inspected).toEqual([]);
    host.failure = Object.assign(new Error('tag mismatch'), { code: 'pairing-tampered' });
    await type(CODE);
    await click('e2ee.accountPair.approve.check');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'e2ee.accountPair.error.pairing-tampered'
    );
    expect(text()).not.toContain('e2ee.accountPair.approve.warning');
    host.failure = null;
    host.request = null;
    await click('e2ee.accountPair.approve.check');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'e2ee.accountPair.approve.notFound'
    );
  });

  it('in the reverse direction shows its own code and opens the confirmation once a request arrives', async () => {
    const host = approverHost();
    host.request = null;
    await act(async () => root.render(<E2eeAccountPairingApprove runtime={host.runtime} />));
    await click('e2ee.accountPair.approve.showInstead');
    expect(text()).toContain(CODE);
    expect(qr.payloads.at(-1)).toBe('lody://pair/50M6HA7955MTKTHADANEPAVBNF38');
    await tick();
    expect(host.inspected).toEqual([CODE]);
    expect(text()).not.toContain('e2ee.accountPair.approve.warning');
    host.request = preview;
    await tick();
    expect(text()).toContain('e2ee.accountPair.approve.warning');
    await tick();
    // The confirmation stops polling.
    expect(host.inspected).toHaveLength(2);
  });

  it('in the reverse direction learns of a request from the relay hint before the next poll, and releases the hint when leaving the code', async () => {
    // Without the hint the approver waits for its poll; the poll stays the fallback.
    const host = approverHost();
    host.request = null;
    const lookupId = 'cd'.repeat(16);
    const hints = new Map<string, () => void>();
    const runtime = {
      ...host.runtime,
      accountPairingCode: async () => ({
        pairingString: CODE,
        expiresAt: NOW + 600_000,
        lookupId,
      }),
      subscribeAccountPairingApproval: (id: string, changed: () => void) => {
        hints.set(id, changed);
        return () => hints.delete(id);
      },
    };
    await act(async () => root.render(<E2eeAccountPairingApprove runtime={runtime} />));
    await click('e2ee.accountPair.approve.showInstead');
    expect([...hints.keys()]).toEqual([lookupId]);
    expect(host.inspected).toEqual([]);
    host.request = preview;
    await act(async () => {
      hints.get(lookupId)!();
      await Promise.resolve();
    });
    expect(host.inspected).toEqual([CODE]);
    expect(text()).toContain('e2ee.accountPair.approve.warning');
    expect(hints.size).toBe(0);
  });

  it('declines without signing anything', async () => {
    const host = approverHost();
    await act(async () => root.render(<E2eeAccountPairingApprove runtime={host.runtime} />));
    await type(CODE);
    await click('e2ee.accountPair.approve.check');
    await click('e2ee.accountPair.approve.decline');
    expect(host.declined).toEqual(['request-1']);
    expect(host.approved).toEqual([]);
    expect(text()).toContain('e2ee.accountPair.approve.declined');
  });

  it('renders nothing on a host without account pairing', async () => {
    await act(async () => root.render(<E2eeAccountPairingApprove runtime={{}} />));
    expect(container.innerHTML).toBe('');
    await act(async () =>
      root.render(<E2eeAccountPairingRequest runtime={{}} autoStart onJoined={() => {}} />)
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('account pairing relay operations', () => {
  it('reach the relay only on a platform with workspace cloud access, never on local', async () => {
    const { cloudOperations } = await import('../src/lib/cloud-api-operations');
    const { PlatformContext, useCloudMutation } = await import('@lody/platform/react');
    const { createLocalPlatformProvider, CloudCapabilityUnavailableError } =
      await import('@lody/platform');
    let submit: ((args: never) => Promise<unknown>) | undefined;
    function Probe() {
      submit = useCloudMutation(cloudOperations.e2eeAccountPairing.submit) as never;
      return null;
    }
    const local = createLocalPlatformProvider({
      session: { status: 'unauthenticated' },
      workspaces: { status: 'ready', workspaces: [], activeWorkspaceId: null },
    } as never);
    await act(async () =>
      root.render(
        <PlatformContext.Provider value={local}>
          <Probe />
        </PlatformContext.Provider>
      )
    );
    await expect(submit!({} as never)).rejects.toBeInstanceOf(CloudCapabilityUnavailableError);
  });
});

describe('automatic pairing product flow', () => {
  /** A waiting runtime for one workspace whose request the page may cancel. */
  const waitingRuntime = (
    cancelled: string[],
    phase: E2eeAutomaticPairingState['phase'] = 'waiting'
  ): E2eeWorkspaceRuntime => {
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected runtime operation');
    };
    return {
      account: unused,
      recordCreated: unused,
      open: unused,
      close: unused,
      status: unused,
      refresh: unused,
      contentStreamsToken: unused,
      seal: unused,
      openContent: unused,
      ingestLedgerRecords: unused,
      ledgerView: unused,
      automaticPairingState: async () => ({
        id: 'request',
        workspaceId: 'w1',
        workspaceName: 'Alpha',
        deviceName: 'Phone',
        comparisonCode: '123456',
        expiresAt: NOW + 300_000,
        phase,
      }),
      cancelAutomaticPairing: async (workspaceId) => {
        cancelled.push(workspaceId);
      },
    };
  };
  const inDialog = (label: string) =>
    [...document.body.querySelectorAll('button')].find((value) =>
      (value.textContent ?? '').startsWith(label)
    );
  const pressInDialog = async (label: string) => {
    const found = inDialog(label);
    if (!found) throw new Error(`missing ${label}`);
    await act(async () => found.click());
  };
  const testId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
  type LostAccess = NonNullable<
    Parameters<
      typeof import('../src/components/pages/e2ee-automatic-pairing').E2eeAutomaticPairingPage
    >[0]['lostAccess']
  >;
  const renderWaiting = async (runtime: E2eeWorkspaceRuntime, lostAccess?: LostAccess) => {
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingPage
          runtime={runtime}
          workspaceId="w1"
          onJoined={() => {}}
          onBack={() => {}}
          {...(lostAccess ? { lostAccess } : {})}
        />
      )
    );
    await tick(0);
  };
  it.each(['expired', 'revoked', 'declined', 'cancelled'] as const)(
    'keeps lost-access recovery available after pairing is %s',
    async (phase) => {
      const runtime = waitingRuntime([], phase);
      await renderWaiting(runtime, {
        workspaceName: 'Alpha',
        accountRole: 'owner',
        onBackToWorkspaces: () => {},
        onRemoved: () => {},
      });
      expect(text()).toContain(`e2ee.auto.${phase}.title`);
      await click('e2ee.lostAccess.entry');
      expect(testId('e2ee-lost-access-lost')).not.toBeNull();
    }
  );
  /** An account removal port whose submit the test settles by hand. */
  const removalPort = (listed: () => Promise<boolean | null>) => {
    const port = {
      submits: [] as Array<{ kind: string; workspaceId: string }>,
      settle: null as null | { resolve: () => void; reject: (error: unknown) => void },
      refreshes: 0,
      removal: {
        submit: (kind: 'delete' | 'leave', workspaceId: string) =>
          new Promise<void>((resolve, reject) => {
            port.submits.push({ kind, workspaceId });
            port.settle = { resolve, reject };
          }),
        listed: () => listed(),
        refresh: () => {
          port.refreshes++;
          // Refreshing the list after a removal may fail; that never undoes it.
          throw new Error('list refresh failed');
        },
      },
    };
    return port;
  };
  const typeName = async (value: string) => {
    const input = document.body.querySelector<HTMLInputElement>('#e2ee-lost-access-name')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('restores from a configured backup when no other authorized device exists, and only this workspace ends its request', async () => {
    const cancelled: string[] = [];
    const restores: string[] = [];
    let recovered = 0,
      checked = 0,
      back = 0;
    const runtime = waitingRuntime(cancelled);
    // Without a lost-access host, the entry only explains where to go instead.
    await renderWaiting(runtime);
    expect(text()).toContain('e2ee.auto.waiting.help');
    expect(text()).toContain('e2ee.auto.expiresIn {"time":"5:00"}');
    expect(text()).toContain('e2ee.auto.noOtherDevice.elsewhere');
    expect(container.querySelector('[data-testid="e2ee-lost-access-entry"]')).toBeNull();

    let restoreResults: { workspaceId?: string; name: string; outcome: string }[] = [
      // Another workspace restored, this one not covered by the backup.
      { workspaceId: 'w2', name: 'Alpha', outcome: 'Committed' },
    ];
    const lostAccess = (): LostAccess => ({
      workspaceName: 'Alpha',
      accountRole: 'owner',
      recovery: {
        passkeyAvailable: true,
        restore: async (method) => {
          restores.push(method);
          return { outcome: 'restored', results: restoreResults };
        },
        onRecovered: () => {
          recovered++;
        },
        onCheck: () => {
          checked++;
        },
      },
      onBackToWorkspaces: () => {
        back++;
      },
      onRemoved: () => {},
    });
    await renderWaiting(runtime, lostAccess());
    // The main pairing flow stays in place beside the way out.
    expect(text()).toContain('123 456');
    await click('e2ee.lostAccess.entry');
    await pressInDialog('e2ee.lostAll.continue');
    // Another workspace's success never ends this workspace's pending approval,
    // even when the names match.
    expect(testId('e2ee-lost-all-current-pending')).not.toBeNull();
    expect(inDialog('e2ee.lostAll.open')).toBeUndefined();
    expect(cancelled).toEqual([]);
    expect(recovered).toBe(0);

    // A host that names no workspace IDs cannot say which row is this one: the page
    // re-reads this device's status instead, and keeps the request.
    await pressInDialog('e2ee.lostAll.tryAnother');
    restoreResults = [{ name: 'Alpha', outcome: 'Committed' }];
    await pressInDialog('e2ee.lostAll.continue');
    expect(testId('e2ee-lost-all-current-pending')).toBeNull();
    await pressInDialog('e2ee.lostAll.check');
    expect(checked).toBe(1);
    expect(cancelled).toEqual([]);

    await pressInDialog('e2ee.lostAll.tryAnother');
    restoreResults = [
      { workspaceId: 'w1', name: 'Alpha', outcome: 'Committed' },
      { workspaceId: 'w3', name: 'Design', outcome: 'Failed' },
    ];
    restores.length = 0;
    // The passkey is the fastest way, so it leads when this device can use one.
    expect(
      document.body.querySelector('[data-lost-all-method="passkey"]')?.getAttribute('aria-checked')
    ).toBe('true');
    await pressInDialog('e2ee.lostAll.continue');
    expect(restores).toEqual(['passkey']);
    const results = testId('e2ee-lost-all-results');
    expect(results?.querySelector('[data-lost-all-result="Committed"]')?.textContent).toContain(
      'Alpha'
    );
    expect(results?.querySelector('[data-lost-all-result="Failed"]')?.textContent).toContain(
      'Design'
    );
    expect(results?.textContent).toContain('e2ee.lostAll.result.askAdmin');
    expect(results?.textContent).toContain('e2ee.lostAll.result.revokeHint');
    await pressInDialog('e2ee.lostAll.open');
    // The backup admitted this device, so the pending request ends and the host refreshes.
    expect(cancelled).toEqual(['w1']);
    expect(recovered).toBe(1);

    // Going back from the lost-access steps keeps the pending request.
    cancelled.length = 0;
    await renderWaiting(runtime, lostAccess());
    await click('e2ee.lostAccess.entry');
    await pressInDialog('e2ee.lostAll.noBackup');
    expect(testId('e2ee-lost-access-lost')?.textContent).toContain('e2ee.lostAccess.lost.body');
    await pressInDialog('e2ee.lostAccess.back');
    expect(back).toBe(1);
    expect(cancelled).toEqual([]);
  });

  it('keeps a settling or failed restore of this workspace away from deletion, and opens a partial key restore', async () => {
    const cancelled: string[] = [];
    let recovered = 0,
      checked = 0;
    const runtime = waitingRuntime(cancelled);
    let restoreResults: {
      workspaceId?: string;
      name: string;
      outcome: string;
      partialEpochKey?: boolean;
    }[] = [{ workspaceId: 'w1', name: 'Alpha', outcome: 'Unconfirmed' }];
    await renderWaiting(runtime, {
      workspaceName: 'Alpha',
      accountRole: 'owner',
      recovery: {
        passkeyAvailable: true,
        restore: async () => ({ outcome: 'restored', results: restoreResults }),
        onRecovered: () => {
          recovered++;
        },
        onCheck: () => {
          checked++;
        },
      },
      onBackToWorkspaces: () => {},
      onRemoved: () => {},
    });
    await click('e2ee.lostAccess.entry');
    await pressInDialog('e2ee.lostAll.continue');
    let results = testId('e2ee-lost-all-results');
    expect(results?.querySelector('[data-lost-all-result="Unconfirmed"]')?.textContent).toContain(
      'e2ee.lostAll.result.waiting'
    );
    expect(testId('e2ee-lost-all-still-waiting')).not.toBeNull();
    expect(results?.textContent).not.toContain('e2ee.lostAll.result.askAdmin');
    expect(testId('e2ee-lost-all-current-pending')).toBeNull();
    expect(inDialog('e2ee.lostAll.cannotRestore')).toBeUndefined();
    await pressInDialog('e2ee.lostAll.check');
    expect(checked).toBe(1);

    await pressInDialog('e2ee.lostAll.tryAnother');
    restoreResults = [{ workspaceId: 'w1', name: 'Alpha', outcome: 'Failed' }];
    await pressInDialog('e2ee.lostAll.continue');
    expect(testId('e2ee-lost-all-results')?.textContent).toContain('e2ee.lostAll.result.failed');
    expect(inDialog('e2ee.lostAll.cannotRestore')).toBeUndefined();

    await pressInDialog('e2ee.lostAll.tryAnother');
    restoreResults = [{ workspaceId: 'w1', name: 'Alpha', outcome: 'not-backed-up' }];
    await pressInDialog('e2ee.lostAll.continue');
    expect(testId('e2ee-lost-all-results')?.textContent).toContain(
      'e2ee.lostAll.result.notBackedUp'
    );
    expect(inDialog('e2ee.lostAll.cannotRestore')).toBeDefined();

    await pressInDialog('e2ee.lostAll.tryAnother');
    restoreResults = [
      { workspaceId: 'w1', name: 'Alpha', outcome: 'Committed', partialEpochKey: true },
    ];
    await pressInDialog('e2ee.lostAll.continue');
    results = testId('e2ee-lost-all-results');
    expect(results?.querySelector('[data-lost-all-partial]')?.textContent).toContain(
      'e2ee.lostAll.result.partial'
    );
    expect(testId('e2ee-lost-all-current-partial')).not.toBeNull();
    expect(cancelled).toEqual([]);
    await pressInDialog('e2ee.lostAll.open');
    expect(cancelled).toEqual(['w1']);
    expect(recovered).toBe(1);
  });

  it('falls back to recovery password when passkey is unavailable and validates password restore', async () => {
    const cancelled: string[] = [];
    const attempts: Array<{ method: string; password?: string }> = [];
    let recovered = 0;
    const runtime = waitingRuntime(cancelled);
    await renderWaiting(runtime, {
      workspaceName: 'Alpha',
      accountRole: 'owner',
      recovery: {
        passkeyAvailable: false,
        restore: async (method, options) => {
          attempts.push({ method, password: options?.password });
          if (options?.password !== 'correct-horse-battery-staple')
            throw new Error('e2ee_recovery_authentication');
          return {
            outcome: 'restored',
            results: [{ workspaceId: 'w1', name: 'Alpha', outcome: 'Committed' }],
          };
        },
        onRecovered: () => {
          recovered++;
        },
      },
      onBackToWorkspaces: () => {},
      onRemoved: () => {},
    });
    await click('e2ee.lostAccess.entry');
    expect(document.body.querySelector('[data-lost-all-method="passkey"]')).toBeNull();
    expect(
      document.body.querySelector('[data-lost-all-method="password"]')?.getAttribute('aria-checked')
    ).toBe('true');

    const typePassword = async (value: string) => {
      const input = testId('e2ee-lost-all-password') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    expect(inDialog('e2ee.lostAll.continue')?.disabled).toBe(true);
    await typePassword('too-short');
    expect(inDialog('e2ee.lostAll.continue')?.disabled).toBe(true);

    await typePassword('wrong-password-1234');
    expect(inDialog('e2ee.lostAll.continue')?.disabled).toBe(false);
    await pressInDialog('e2ee.lostAll.continue');
    expect(document.body.textContent).toContain('e2ee.recovery.wrongPassword');

    await typePassword('correct-horse-battery-staple');
    await pressInDialog('e2ee.lostAll.continue');
    expect(attempts).toEqual([
      { method: 'password', password: 'wrong-password-1234' },
      { method: 'password', password: 'correct-horse-battery-staple' },
    ]);
    await pressInDialog('e2ee.lostAll.open');
    expect(recovered).toBe(1);
    expect(cancelled).toEqual(['w1']);
  });

  it('lets an account owner with no authorized device delete the workspace, reporting background cleanup even when the list refresh fails', async () => {
    let removed = 0;
    const port = removalPort(async () => true);
    await renderWaiting(waitingRuntime([]), {
      workspaceName: 'Alpha',
      accountRole: 'owner',
      removal: port.removal,
      onBackToWorkspaces: () => {},
      onRemoved: () => {
        removed++;
      },
    });
    await click('e2ee.lostAccess.entry');
    // No backup on this host: the steps start at what can still be done.
    expect(testId('e2ee-lost-access-lost')?.textContent).toContain('e2ee.lostAccess.noRestore');
    expect(document.body.querySelector('[data-lost-access-role="owner"]')).not.toBeNull();
    expect(testId('e2ee-lost-access-leave')).toBeNull();
    await act(async () => (testId('e2ee-lost-access-delete') as HTMLButtonElement).click());
    const submit = () => testId('e2ee-lost-access-submit') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    await typeName('Alph');
    expect(submit().disabled).toBe(true);
    await typeName('Alpha');
    await act(async () => submit().click());
    expect(port.submits).toEqual([{ kind: 'delete', workspaceId: 'w1' }]);
    await act(async () => port.settle!.resolve());
    const done = testId('e2ee-lost-access-removed');
    expect(done?.textContent).toContain('e2ee.lostAccess.deleted');
    expect(done?.textContent).toContain('e2ee.lostAccess.cleanupPending');
    expect(port.refreshes).toBe(1);
    await pressInDialog('e2ee.lostAccess.continue');
    expect(removed).toBe(1);
  });

  it('offers a non-owner leave instead of delete, and shows a server refusal of an owner hint as refused', async () => {
    const memberPort = removalPort(async () => true);
    await renderWaiting(waitingRuntime([]), {
      workspaceName: 'Alpha',
      accountRole: 'member',
      removal: memberPort.removal,
      onBackToWorkspaces: () => {},
      onRemoved: () => {},
    });
    await click('e2ee.lostAccess.entry');
    expect(document.body.querySelector('[data-lost-access-role="member"]')).not.toBeNull();
    expect(testId('e2ee-lost-access-delete')).toBeNull();
    expect(testId('e2ee-lost-access-leave')).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);

    // A stale owner hint: the server decides, and the workspace is still listed.
    const port = removalPort(async () => true);
    await renderWaiting(waitingRuntime([]), {
      workspaceName: 'Alpha',
      accountRole: 'owner',
      removal: port.removal,
      onBackToWorkspaces: () => {},
      onRemoved: () => {},
    });
    await click('e2ee.lostAccess.entry');
    await act(async () => (testId('e2ee-lost-access-delete') as HTMLButtonElement).click());
    await typeName('Alpha');
    await act(async () => (testId('e2ee-lost-access-submit') as HTMLButtonElement).click());
    await act(async () => port.settle!.reject({ status: 403, message: 'not allowed' }));
    expect(testId('e2ee-lost-access-refused')?.textContent).toContain(
      'e2ee.lostAccess.refused.notOwner'
    );
    expect(testId('e2ee-lost-access-removed')).toBeNull();
    expect(port.refreshes).toBe(0);
  });

  it('never reports an unanswered deletion as failed: the workspace list decides, and a late success still lands', async () => {
    // This case owns its timeouts: reinstall the clock with setTimeout faked too.
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    vi.setSystemTime(NOW);
    const { LOST_ACCESS_BOUND_MS, LOST_ACCESS_SLOW_MS } =
      await import('../src/components/pages/e2ee-lost-access');
    let listed: boolean | null = true;
    const port = removalPort(async () => listed);
    await renderWaiting(waitingRuntime([]), {
      workspaceName: 'Alpha',
      accountRole: 'owner',
      removal: port.removal,
      onBackToWorkspaces: () => {},
      onRemoved: () => {},
    });
    await click('e2ee.lostAccess.entry');
    await act(async () => (testId('e2ee-lost-access-delete') as HTMLButtonElement).click());
    await typeName('Alpha');
    await act(async () => (testId('e2ee-lost-access-submit') as HTMLButtonElement).click());
    const phase = () => testId('e2ee-lost-access-confirm')?.getAttribute('data-lost-access-phase');
    await tick(LOST_ACCESS_SLOW_MS);
    expect(text() + document.body.textContent).toContain('e2ee.lostAccess.slow');
    // An unanswered request cannot be dismissed while its result is pending.
    await act(async () =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(testId('e2ee-lost-access-confirm')).not.toBeNull();
    await tick(LOST_ACCESS_BOUND_MS - LOST_ACCESS_SLOW_MS);
    // Still listed after the bound: unknown, never failed or deleted.
    expect(phase()).toBe('unknown');
    expect(testId('e2ee-lost-access-refused')).toBeNull();
    expect(port.refreshes).toBe(0);
    // A late success is still the truth.
    await act(async () => port.settle!.resolve());
    expect(testId('e2ee-lost-access-removed')).not.toBeNull();

    // A transport failure whose list read fails stays unknown; a retry that the list
    // then shows as gone is reported as deleted.
    await act(async () => root.unmount());
    root = createRoot(container);
    const second = removalPort(async () => listed);
    listed = null;
    await renderWaiting(waitingRuntime([]), {
      workspaceName: 'Alpha',
      accountRole: 'owner',
      removal: second.removal,
      onBackToWorkspaces: () => {},
      onRemoved: () => {},
    });
    await click('e2ee.lostAccess.entry');
    await act(async () => (testId('e2ee-lost-access-delete') as HTMLButtonElement).click());
    await typeName('Alpha');
    await act(async () => (testId('e2ee-lost-access-submit') as HTMLButtonElement).click());
    await act(async () => second.settle!.reject(new TypeError('Failed to fetch')));
    expect(phase()).toBe('unknown');
    listed = false;
    await act(async () => (testId('e2ee-lost-access-submit') as HTMLButtonElement).click());
    await act(async () => second.settle!.reject(new TypeError('Failed to fetch')));
    expect(testId('e2ee-lost-access-removed')).not.toBeNull();
    expect(second.submits).toHaveLength(2);
  });

  it('discards a late recovery result after switching account runtime and workspace', async () => {
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    let release!: (state: import('@lody/platform').E2eeAutomaticPairingState) => void;
    const pending = new Promise<import('@lody/platform').E2eeAutomaticPairingState>((resolve) => {
      release = resolve;
    });
    let opened = false;
    const host = (workspaceId: string, name: string) =>
      ({
        automaticPairingState: async () => {
          throw Object.assign(new Error('e2ee_pairing-elsewhere'), { code: 'pairing-elsewhere' });
        },
        accountPairingRequest: async () => ({
          lookupId: (workspaceId === 'w1' ? 'a1' : 'b2').repeat(16),
          direction: 'approver-shows',
          pairingString: null,
          status: 'waiting',
          expiresAt: NOW + 600_000,
          workspaces: [{ workspaceId, name, state: 'pending' }],
        }),
        restartAutomaticPairing: async () => pending,
      }) as unknown as E2eeWorkspaceRuntime;
    const first = host('w1', 'Old Alpha'),
      second = host('w2', 'Current Beta');
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingPage
          runtime={first}
          workspaceId="w1"
          onJoined={() => {
            opened = true;
          }}
          onBack={() => {}}
        />
      )
    );
    await click('e2ee.auto.previous.review');
    await click('e2ee.auto.previous.endAndRestart');
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingPage
          runtime={second}
          workspaceId="w2"
          onJoined={() => {
            opened = true;
          }}
          onBack={() => {}}
        />
      )
    );
    await act(async () =>
      release({
        id: 'old',
        workspaceId: 'w1',
        workspaceName: 'Old Alpha',
        deviceName: 'Phone',
        comparisonCode: '987654',
        expiresAt: NOW + 600_000,
        phase: 'joined',
      })
    );
    expect(opened).toBe(false);
    expect(text()).toContain('Current Beta');
    expect(text()).not.toContain('Old Alpha');
    expect(text()).not.toContain('987 654');
    await click('e2ee.auto.previous.review');
    expect(text()).toContain('e2ee.auto.previous.confirm');
  });
  it.each(['restart', 'replacement', 'during-confirmation', 'legacy'] as const)(
    'requires explicit confirmation for an existing device request and preserves replacements: %s',
    async (scenario) => {
      const { E2eeAutomaticPairingPage } =
        await import('../src/components/pages/e2ee-automatic-pairing');
      let native: E2eeAccountPairingRequestState = {
        lookupId: scenario === 'legacy' ? undefined : 'a1'.repeat(16),
        direction: 'approver-shows',
        pairingString: null,
        status: 'waiting',
        expiresAt: NOW + 600_000,
        workspaces: [{ workspaceId: 'w1', name: 'Previous Alpha', state: 'pending' }],
      };
      let fresh: import('@lody/platform').E2eeAutomaticPairingState | null = null;
      const ended: string[] = [];
      const runtime = {
        automaticPairingState: async () => {
          if (fresh) return fresh;
          throw Object.assign(new Error('e2ee_pairing-elsewhere'), { code: 'pairing-elsewhere' });
        },
        accountPairingRequest: async () => structuredClone(native),
        restartAutomaticPairing: async (
          _workspaceId: string,
          input: { expectedLookupId: string }
        ) => {
          if (input.expectedLookupId !== native.lookupId)
            throw Object.assign(new Error('e2ee_pairing-elsewhere'), { code: 'pairing-elsewhere' });
          ended.push(input.expectedLookupId);
          native = { ...native, status: 'expired' };
          return (fresh = {
            id: 'fresh',
            workspaceId: 'w1',
            workspaceName: 'Alpha',
            deviceName: 'Phone',
            comparisonCode: '654321',
            expiresAt: NOW + 600_000,
            phase: 'waiting',
          });
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
      expect(native.status).toBe('waiting');
      expect(fresh).toBeNull();
      if (scenario === 'legacy') {
        expect(text()).toContain('e2ee.accountPair.error.pairing-update-required');
        expect(text()).not.toContain('e2ee.auto.previous.review');
        expect(ended).toEqual([]);
        return;
      }
      expect(text()).toContain('Previous Alpha');
      await click('e2ee.auto.previous.review');
      expect(text()).toContain('e2ee.auto.previous.confirm');
      expect(ended).toEqual([]);
      if (scenario === 'replacement' || scenario === 'during-confirmation') {
        native = {
          ...native,
          lookupId: 'b2'.repeat(16),
          workspaces: [{ workspaceId: 'w1', name: 'Replacement Beta', state: 'pending' }],
        };
        if (scenario === 'replacement') await tick(2000);
        else await click('e2ee.auto.previous.endAndRestart');
        expect(native.status).toBe('waiting');
        expect(fresh).toBeNull();
        expect(text()).toContain('Replacement Beta');
        expect(text()).not.toContain('e2ee.auto.previous.confirm');
        expect(ended).toEqual([]);
        await click('e2ee.auto.previous.review');
      }
      await click('e2ee.auto.previous.endAndRestart');
      expect(native.status).toBe('expired');
      expect(ended).toEqual([
        scenario === 'replacement' || scenario === 'during-confirmation'
          ? 'b2'.repeat(16)
          : 'a1'.repeat(16),
      ]);
      expect(text()).toContain('654 321');
    }
  );
  it('shows the native request immediately and advances after verified admission without a check button', async () => {
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    let saved: import('@lody/platform').E2eeAutomaticPairingState | null = null;
    let opened = false;
    const waiting: import('@lody/platform').E2eeAutomaticPairingState = {
      id: 'request',
      workspaceId: 'w1',
      workspaceName: 'Synthetic team',
      deviceName: 'Phone',
      expiresAt: NOW + 600_000,
      comparisonCode: '123456',
      phase: 'waiting',
    };
    const runtime = {
      automaticPairingState: async () => saved,
      startAutomaticPairing: async () => (saved = waiting),
      cancelAutomaticPairing: async () => {
        saved = { ...waiting, phase: 'cancelled' };
      },
    } as unknown as E2eeWorkspaceRuntime;
    await act(async () =>
      root.render(
        <E2eeAutomaticPairingPage
          runtime={runtime}
          workspaceId="w1"
          onJoined={() => {
            opened = true;
          }}
          onBack={() => {}}
        />
      )
    );
    expect(text()).toContain('123 456');
    expect(text()).toContain('Synthetic team');
    expect(text()).not.toContain('e2ee.pair.claim');
    saved = { ...waiting, phase: 'syncing' };
    await tick(2000);
    expect(opened).toBe(true);
    expect(text()).toContain('e2ee.auto.syncing.title');
  });
  it.each(['revoked', 'removed'] as const)(
    'stops showing an approved device as syncing once the runtime reports it %s',
    async (phase) => {
      const { E2eeAutomaticPairingPage } =
        await import('../src/components/pages/e2ee-automatic-pairing');
      const syncing: import('@lody/platform').E2eeAutomaticPairingState = {
        id: 'request',
        workspaceId: 'w1',
        workspaceName: 'Synthetic team',
        deviceName: 'Phone',
        expiresAt: NOW + 600_000,
        comparisonCode: null,
        phase: 'syncing',
      };
      let saved = syncing;
      let starts = 0;
      const runtime = {
        automaticPairingState: async () => saved,
        startAutomaticPairing: async () => {
          starts += 1;
          return (saved = {
            ...syncing,
            id: 'again',
            comparisonCode: '123456',
            phase: 'waiting',
          });
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
      expect(text()).toContain('e2ee.auto.syncing.title');
      saved = { ...syncing, phase };
      await tick(2000);
      expect(text()).toContain(`e2ee.auto.${phase}.title`);
      expect(text()).not.toContain('e2ee.auto.syncing.title');
      await tick(2000);
      expect(starts).toBe(0);
      if (phase === 'removed') {
        // Only a new invitation helps: no request of this device's own is offered.
        expect(container.querySelector('[data-testid="e2ee-auto-pair-again"]')).toBeNull();
        expect(text()).not.toContain('e2ee.auto.restart');
        return;
      }
      await click('e2ee.devices.pairAgain');
      expect(starts).toBe(1);
      expect(text()).toContain('123 456');
      expect(text()).not.toContain('e2ee.auto.syncing.title');
    }
  );
  it('retains a deferred approval behind the device requests entry and authorizes only after the new device code is typed', async () => {
    const { E2eeAutomaticPairingInbox, E2eeDeviceRequestsButton } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const removeTelemetryScope = installWorkspaceTelemetryScope(() => 'ordinary-under-approval');
    setTelemetryRouteTarget('ordinary-under-approval', true);
    const replay = () =>
      postHogPrivacy.beforeSend({
        event: '$snapshot',
        properties: { $snapshot_data: ['synthetic private surface'] },
      });
    let authorized = false;
    const review = {
      id: 'request',
      requestId: 'native-request',
      workspaceId: 'w1',
      workspaceName: 'Synthetic team',
      deviceName: 'Phone',
      expiresAt: Date.now() + 600_000,
      phase: 'waiting' as const,
    };
    const runtime = {
      pendingAutomaticPairing: async () => (authorized ? [] : [review]),
      // The host compares against its own derived code; the UI never receives it.
      approveAutomaticPairing: async (id: string, code: string) => {
        if (id !== review.id) throw Error('wrong request');
        if (code !== '123456')
          throw Object.assign(Error('mismatch'), {
            code: 'pairing-code-mismatch',
            attemptsLeft: 2,
          });
        authorized = true;
      },
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    const find = (label: string) =>
      [...document.querySelectorAll('button')].find((element) =>
        element.textContent?.includes(label)
      )!;
    try {
      await act(async () =>
        root.render(
          <E2eeAutomaticPairingInbox runtime={runtime}>
            <E2eeDeviceRequestsButton />
          </E2eeAutomaticPairingInbox>
        )
      );
      const codeInput = () =>
        document.querySelector<HTMLInputElement>('[data-testid="e2ee-approval-code"]')!;
      const authorize = () =>
        document.querySelector<HTMLButtonElement>('[data-testid="e2ee-approval-authorize"]')!;
      const type = async (value: string) =>
        act(async () => {
          const input = codeInput();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            value
          );
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      expect(codeInput()).not.toBeNull();
      expect(document.body.textContent).toContain('e2ee.auto.deviceNameUnverified');
      expect(replay()).toBeNull();
      await act(async () => find('e2ee.auto.later').click());
      expect(container.textContent).toContain('e2ee.auto.inbox');
      expect(codeInput()).toBeNull();
      expect(replay()).not.toBeNull();
      await act(async () => find('e2ee.auto.inbox').click());
      expect(document.body.textContent).toContain('Synthetic team');
      expect(replay()).toBeNull();
      await act(async () => find('e2ee.auto.review').click());
      expect(authorize().disabled).toBe(true);
      await type('654321');
      await act(async () => authorize().click());
      expect(authorized).toBe(false);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'e2ee.auto.codeMismatch'
      );
      expect(codeInput().value).toBe('');
      await type('123 456');
      expect(codeInput().value).toBe('123456');
      await act(async () => authorize().click());
      await tick(2000);
      expect(authorized).toBe(true);
      expect(container.textContent).toBe('');
      expect(replay()).not.toBeNull();
    } finally {
      removeTelemetryScope();
      focus.mockRestore();
    }
  });
  it('keeps a partly typed approval code across a poll that briefly omits the request, and accepts full-width digits', async () => {
    const { E2eeAutomaticPairingInbox } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const review = {
      id: 'request',
      requestId: 'native-request',
      workspaceId: 'w1',
      workspaceName: 'Synthetic team',
      deviceName: 'Phone',
      expiresAt: Date.now() + 600_000,
      phase: 'waiting' as const,
    };
    let rows = [review];
    const approved: string[] = [];
    const runtime = {
      pendingAutomaticPairing: async () => rows,
      approveAutomaticPairing: async (_id: string, code: string) => {
        if (code !== '123456')
          throw Object.assign(Error('mismatch'), {
            code: 'pairing-code-mismatch',
            attemptsLeft: 2,
          });
        approved.push(code);
      },
      declineAutomaticPairing: async () => {},
    } as unknown as E2eeWorkspaceRuntime;
    const codeInput = () =>
      document.querySelector<HTMLInputElement>('[data-testid="e2ee-approval-code"]');
    const type = async (value: string) =>
      act(async () => {
        const input = codeInput()!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    try {
      await act(async () =>
        root.render(
          <E2eeAutomaticPairingInbox runtime={runtime}>
            <div />
          </E2eeAutomaticPairingInbox>
        )
      );
      // A full-width IME entry is read as the same digits.
      await type('１２３');
      expect(codeInput()!.value).toBe('123');
      // One discovery round transiently fails for this request, then it returns.
      rows = [];
      await tick(2000);
      expect(codeInput()).toBeNull();
      rows = [review];
      await tick(2000);
      expect(codeInput()!.value).toBe('123');
      await type('１２３４５６');
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[data-testid="e2ee-approval-authorize"]')!
          .click()
      );
      expect(approved).toEqual(['123456']);
    } finally {
      focus.mockRestore();
    }
  });
});
