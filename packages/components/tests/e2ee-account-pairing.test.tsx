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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
// The QR drawing and camera are presentation; the payload is asserted directly.
const qr = vi.hoisted(() => ({ payloads: [] as string[] }));
vi.mock('../src/components/pages/e2ee-ledger-verification', () => ({
  LedgerQrCode: (props: { payload: string }) => {
    qr.payloads.push(props.payload);
    return null;
  },
  useQrCamera: () => ({ video: { current: null }, state: 'idle' }),
}));

// Synthetic code from packages/e2ee-core/test/pairing-vector.json, parsed by real core.
const CODE = '50M6-HA79-55MT-KTHA-DANE-PAVB-NF38';
const TYPO = CODE.replace('HA79', 'HA78');
const NOW = 1_800_000_000_000;

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  qr.payloads = [];
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

/** A host holding one request and its progress, like a desktop or portable host. */
function requesterHost(initial: E2eeAccountPairingRequestState | null = null) {
  const host = {
    state: initial,
    started: [] as Array<{ pairingString?: string }>,
    cancelled: 0,
    runtime: {} as Pick<
      E2eeWorkspaceRuntime,
      'requestAccountPairing' | 'accountPairingRequest' | 'cancelAccountPairing'
    >,
  };
  host.runtime = {
    requestAccountPairing: async (input) => {
      host.started.push(input);
      host.state = {
        direction: input.pairingString ? 'approver-shows' : 'requester-shows',
        pairingString: input.pairingString ? null : CODE,
        expiresAt: NOW + 600_000,
        status: 'waiting',
        workspaces: [{ workspaceId: 'w1', name: 'Alpha', state: 'pending' }],
      };
      return host.state;
    },
    accountPairingRequest: async () => host.state,
    cancelAccountPairing: async () => {
      host.cancelled++;
      host.state = null;
    },
  };
  return host;
}

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

  // Desktop IPC carries only the message; the reason must survive to the screen
  // instead of a generic "Pairing failed".
  it.each(['pairing-unavailable', 'pairing-rate-limited'])(
    'explains a relay refusal (%s) from the desktop host',
    async (code) => {
      const host = requesterHost();
      host.runtime.requestAccountPairing = () =>
        withAccountPairingCode(Promise.reject(new Error(`e2ee_${code}`)));
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
  unavailable: [{ workspaceId: 'w3', name: 'Gamma' }],
};
function approverHost() {
  const host = {
    request: preview as E2eeAccountPairingPreview | null,
    failure: null as Error | null,
    inspected: [] as string[],
    approved: [] as string[][],
    declined: [] as string[],
    runtime: {} as Pick<
      E2eeWorkspaceRuntime,
      | 'accountPairingCode'
      | 'inspectAccountPairing'
      | 'approveAccountPairing'
      | 'declineAccountPairing'
    >,
  };
  host.runtime = {
    accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
    inspectAccountPairing: async (code) => {
      host.inspected.push(code);
      if (host.failure) throw host.failure;
      return host.request;
    },
    approveAccountPairing: async (input) => {
      host.approved.push(input.workspaceIds);
      return {
        workspaces: input.workspaceIds.map((workspaceId, index) => ({
          workspaceId,
          outcome: index === 0 ? ('admitted' as const) : ('awaiting-delivery' as const),
        })),
      };
    },
    declineAccountPairing: async (input) => {
      host.declined.push(input.requestId);
    },
  };
  return host;
}

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
  it('restores from a backup when no other authorized device exists, and opens the result', async () => {
    const { E2eeAutomaticPairingPage } =
      await import('../src/components/pages/e2ee-automatic-pairing');
    const cancelled: string[] = [];
    const restores: string[] = [];
    let recovered = 0;
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
      cancelAutomaticPairing: async (workspaceId: string) => {
        cancelled.push(workspaceId);
      },
    } as unknown as E2eeWorkspaceRuntime;
    const page = (lostAll?: Parameters<typeof E2eeAutomaticPairingPage>[0]['lostAll']) =>
      act(async () =>
        root.render(
          <E2eeAutomaticPairingPage
            runtime={runtime}
            workspaceId="w1"
            onJoined={() => {}}
            onBack={() => {}}
            {...(lostAll ? { lostAll } : {})}
          />
        )
      );
    // Without a backup on this host, the entry explains where to go instead.
    await page();
    await tick(0);
    expect(text()).toContain('e2ee.auto.waiting.help');
    expect(text()).toContain('e2ee.auto.expiresIn {"time":"5:00"}');
    expect(text()).toContain('e2ee.auto.noOtherDevice.elsewhere');
    expect(text()).not.toContain('e2ee.auto.noOtherDevice.restore');

    const inDialog = (label: string) =>
      [...document.body.querySelectorAll('button')].find((value) =>
        (value.textContent ?? '').startsWith(label)
      );
    let restoreResults: { workspaceId: string; name: string; outcome: string }[] = [
      // Another workspace restored, this one not covered by the backup.
      { workspaceId: 'w2', name: 'Alpha', outcome: 'Committed' },
    ];
    await page({
      passkeyAvailable: true,
      restore: async (method) => {
        restores.push(method);
        return { outcome: 'restored', results: restoreResults };
      },
      onRecovered: () => {
        recovered++;
      },
    });
    await click('e2ee.auto.noOtherDevice.restore');
    await act(async () => inDialog('e2ee.lostAll.continue')!.click());
    // Another workspace's success never ends this workspace's pending approval,
    // even when the names match.
    expect(
      document.body.querySelector('[data-testid="e2ee-lost-all-current-pending"]')
    ).not.toBeNull();
    expect(inDialog('e2ee.lostAll.open')).toBeUndefined();
    expect(cancelled).toEqual([]);
    expect(recovered).toBe(0);
    await act(async () => inDialog('e2ee.lostAll.tryAnother')!.click());
    restoreResults = [
      { workspaceId: 'w1', name: 'Alpha', outcome: 'Committed' },
      { workspaceId: 'w3', name: 'Design', outcome: 'Failed' },
    ];
    restores.length = 0;
    // The passkey is the fastest way, so it leads when this device can use one.
    expect(
      document.body.querySelector('[data-lost-all-method="passkey"]')?.getAttribute('aria-checked')
    ).toBe('true');
    await act(async () => inDialog('e2ee.lostAll.continue')!.click());
    expect(restores).toEqual(['passkey']);
    const results = document.body.querySelector('[data-testid="e2ee-lost-all-results"]');
    expect(results?.querySelector('[data-lost-all-result="Committed"]')?.textContent).toContain(
      'Alpha'
    );
    expect(results?.querySelector('[data-lost-all-result="Failed"]')?.textContent).toContain(
      'Design'
    );
    expect(results?.textContent).toContain('e2ee.lostAll.result.askAdmin');
    expect(results?.textContent).toContain('e2ee.lostAll.result.revokeHint');
    await act(async () => inDialog('e2ee.lostAll.open')!.click());
    // The backup admitted this device, so the pending request ends and the host refreshes.
    expect(cancelled).toEqual(['w1']);
    expect(recovered).toBe(1);
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
          throw Object.assign(Error('mismatch'), { code: 'pairing-code-mismatch', attemptsLeft: 2 });
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
        document.querySelector<HTMLButtonElement>('[data-testid="e2ee-approval-authorize"]')!.click()
      );
      expect(approved).toEqual(['123456']);
    } finally {
      focus.mockRestore();
    }
  });
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
