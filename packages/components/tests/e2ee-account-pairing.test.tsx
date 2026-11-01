// @vitest-environment jsdom
import React, { act } from 'react';
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
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

  it('says when another tab of this browser already owns the pairing', async () => {
    const host = requesterHost();
    host.runtime.requestAccountPairing = async () => {
      throw Object.assign(new Error('e2ee_pairing-elsewhere'), { code: 'pairing-elsewhere' });
    };
    await act(async () =>
      root.render(
        <E2eeAccountPairingRequest runtime={host.runtime} autoStart={false} onJoined={() => {}} />
      )
    );
    await click('e2ee.accountPair.request.start');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'e2ee.accountPair.error.pairing-elsewhere'
    );
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
    // Every relay and join-mailbox operation is assigned to the same capability.
    const names = [
      ...Object.values(cloudOperations.e2eeAccountPairing),
      ...Object.values(cloudOperations.e2eeJoinMailbox),
    ].map((operation) => [operation.name, operation.capability]);
    expect(names.every(([, capability]) => capability === 'multiWorkspace')).toBe(true);
    expect(names.map(([name]) => name)).toEqual([
      'e2eeAccountPairing:submit',
      'e2eeAccountPairing:pending',
      'e2eeAccountPairing:read',
      'e2eeAccountPairing:decline',
      'e2eeAccountPairing:publish',
      'e2eeAccountPairing:claim',
      'e2eeJoinMailbox:begin',
      'e2eeJoinMailbox:status',
      'e2eeJoinMailbox:readRequest',
      'e2eeJoinMailbox:cancel',
      'e2eeJoinMailbox:publish',
      'e2eeJoinMailbox:claim',
    ]);
  });
});
