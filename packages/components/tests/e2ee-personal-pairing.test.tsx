// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eePersonalPairing } from '../src/components/pages/e2ee-personal-pairing';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../src/components/pages/e2ee-ledger-verification', () => ({ LedgerQrCode: () => null }));
const offer = {
  version: 1 as const,
  workspaceId: 'w',
  genesisHash: '11'.repeat(32),
  genesisRecordHex: 'aabb',
  endorser: '22'.repeat(32),
  membershipId: '33'.repeat(16),
  pairingSessionId: '44'.repeat(16),
};
type Runtime = Pick<
  E2eeWorkspaceRuntime,
  | 'personalPairingOffer'
  | 'preparePersonalJoin'
  | 'pendingPersonalJoin'
  | 'inspectPersonalJoin'
  | 'approvePersonalJoin'
  | 'claimPersonalJoin'
  | 'cancelPersonalJoin'
>;
describe('personal desktop approval', () => {
  let root: Root, container: HTMLDivElement, runtime: Runtime;
  let admitted: boolean, publish: boolean, inspectFailure: Error | undefined;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    admitted = false;
    publish = true;
    inspectFailure = undefined;
    runtime = {
      personalPairingOffer: async () => offer,
      preparePersonalJoin: async () => ({
        pairingSessionId: offer.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        status: 'pending',
      }),
      inspectPersonalJoin: async () => {
        if (inspectFailure) throw inspectFailure;
        return {
          pairingSessionId: offer.pairingSessionId,
          signingPublicKey: '55'.repeat(32),
          encryptionPublicKey: '66'.repeat(32),
          credentialHash: '77'.repeat(32),
          protection: 'os-keystore',
        };
      },
      approvePersonalJoin: async () => {
        admitted = true;
        return { admitted: true, invitationPublished: publish };
      },
      claimPersonalJoin: async () => ({ ready: false, status: 'pending' }),
      cancelPersonalJoin: async () => ({ status: 'cancelled' }),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (canApprove = true, workspaceId = 'w') =>
    act(async () =>
      root.render(
        <E2eePersonalPairing
          workspaceId={workspaceId}
          runtime={runtime}
          canApprove={canApprove}
          onJoined={() => {}}
        />
      )
    );
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (value) => value.textContent === text
    );
    if (!button) throw new Error(`missing ${text}`);
    await act(async () => button.click());
  };
  const inputOffer = async (value = offer) => {
    const input = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        JSON.stringify(value)
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  it('lets the approver cancel a previewed unavailable target and create a fresh offer', async () => {
    let next = offer;
    runtime.personalPairingOffer = async () => next;
    await render();
    await click('e2ee.pair.create');
    await click('e2ee.pair.inspect');
    await click('common.cancel');
    expect(container.textContent).not.toContain('55'.repeat(32));
    expect(container.querySelector('textarea')).toBeNull();
    expect(admitted).toBe(false);
    next = { ...offer, pairingSessionId: '88'.repeat(16) };
    await click('e2ee.pair.create');
    expect(container.querySelector('textarea')!.value).toBe(JSON.stringify(next));
  });
  it('retains the offer and preview throughout a slow cancellation until the server result is confirmed', async () => {
    const cancellation = Promise.withResolvers<{ status: 'cancelled' }>();
    runtime.cancelPersonalJoin = () => cancellation.promise;
    await render();
    await click('e2ee.pair.create');
    await click('e2ee.pair.inspect');
    await click('common.cancel');
    expect(container.querySelector('textarea')!.value).toBe(JSON.stringify(offer));
    expect(container.textContent).toContain('55'.repeat(32));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => cancellation.resolve({ status: 'cancelled' }));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('55'.repeat(32));
    expect(container.textContent).toContain('e2ee.pair.cancelled');
  });
  it.each(['lost cancel receipt', 'admission reserved'])(
    'preserves the pending offer after %s and recovers on the next cancellation',
    async (failure) => {
      let cancelFailure = true;
      runtime.cancelPersonalJoin = async () => {
        if (cancelFailure) throw new Error(failure);
        return { status: 'cancelled' };
      };
      await render();
      await click('e2ee.pair.create');
      await click('e2ee.pair.inspect');
      await click('common.cancel');
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.querySelector('textarea')!.value).toBe(JSON.stringify(offer));
      expect(container.textContent).toContain('55'.repeat(32));
      cancelFailure = false;
      await click('common.cancel');
      expect(container.querySelector('textarea')).toBeNull();
      expect(container.textContent).not.toContain('55'.repeat(32));
      expect(admitted).toBe(false);
    }
  );
  it('discovers a request saved before begin failed, restores it after remount, and accepts a new offer only after terminal reconciliation', async () => {
    type Pending = Awaited<ReturnType<NonNullable<Runtime['pendingPersonalJoin']>>>;
    let pending: Pending = null;
    runtime.pendingPersonalJoin = async () => pending;
    runtime.preparePersonalJoin = async (value) => {
      pending = {
        pairingSessionId: value.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        offer: value,
      };
      throw new Error('request_conflict');
    };
    await render(false);
    await inputOffer();
    await click('e2ee.pair.trust');
    expect(container.textContent).toContain('55'.repeat(32));
    expect(container.textContent).toContain('e2ee.pair.claim');
    expect(container.querySelector('textarea')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(false);
    expect(container.textContent).toContain('55'.repeat(32));
    runtime.claimPersonalJoin = async () => {
      pending = null;
      return { ready: false, status: 'cancelled' };
    };
    await click('e2ee.pair.claim');
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(container.textContent).not.toContain('55'.repeat(32));
    const next = { ...offer, pairingSessionId: '88'.repeat(16) };
    runtime.preparePersonalJoin = async (value) => ({
      pairingSessionId: value.pairingSessionId,
      signingPublicKey: '55'.repeat(32),
      status: 'pending',
    });
    await inputOffer(next);
    await click('e2ee.pair.trust');
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('55'.repeat(32));
    expect(container.textContent).toContain('e2ee.pair.waiting');
  });
  it('retries the saved pin when preparation stopped before request creation, without inventing a key or session', async () => {
    runtime.pendingPersonalJoin = async () => ({ pairingSessionId: offer.pairingSessionId, offer });
    runtime.preparePersonalJoin = async (value) => {
      if (JSON.stringify(value) !== JSON.stringify(offer)) throw new Error('changed original');
      return {
        pairingSessionId: value.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        status: 'pending',
      };
    };
    await render(false);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('55'.repeat(32));
    await click('e2ee.pair.retrySubmission');
    expect(container.textContent).toContain('55'.repeat(32));
    expect(container.textContent).toContain('e2ee.pair.waiting');
  });
  it('keeps a joining request after an unknown cancellation and a nonterminal claim', async () => {
    runtime.pendingPersonalJoin = async () => ({
      pairingSessionId: offer.pairingSessionId,
      signingPublicKey: '55'.repeat(32),
      offer,
    });
    runtime.cancelPersonalJoin = async () => {
      throw new Error('unknown');
    };
    runtime.claimPersonalJoin = async () => ({ ready: false, status: 'admitting' });
    await render(false);
    await click('common.cancel');
    expect(container.textContent).toContain('55'.repeat(32));
    expect(container.querySelector('textarea')).toBeNull();
    await click('e2ee.pair.claim');
    expect(container.textContent).toContain('e2ee.pair.waiting');
    expect(container.textContent).toContain('55'.repeat(32));
  });
  it('does not let an old workspace pending query populate the new workspace', async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<NonNullable<Runtime['pendingPersonalJoin']>>>>();
    runtime.pendingPersonalJoin = (workspaceId) =>
      workspaceId === 'w' ? pending.promise : Promise.resolve(null);
    await render(false);
    await render(false, 'other');
    await act(async () =>
      pending.resolve({
        pairingSessionId: offer.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        offer,
      })
    );
    expect(container.textContent).not.toContain('55'.repeat(32));
    expect(container.querySelector('textarea')!.value).toBe('');
  });
  it('does not render a delayed preview after switching workspaces', async () => {
    const response =
      Promise.withResolvers<Awaited<ReturnType<NonNullable<Runtime['inspectPersonalJoin']>>>>();
    runtime.inspectPersonalJoin = () => response.promise;
    await render();
    await click('e2ee.pair.create');
    await click('e2ee.pair.inspect');
    await render(true, 'other');
    await act(async () =>
      response.resolve({
        pairingSessionId: offer.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        encryptionPublicKey: '66'.repeat(32),
        credentialHash: '77'.repeat(32),
        protection: 'os-keystore',
      })
    );
    expect(container.textContent).not.toContain('55'.repeat(32));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('e2ee.pair.create');
  });
  it('shows verified identity before a separate approval, preserving committed admission after delivery failure', async () => {
    publish = false;
    await render();
    await click('e2ee.pair.create');
    await click('e2ee.pair.inspect');
    expect(container.textContent).toContain('55'.repeat(32));
    expect(admitted).toBe(false);
    await click('e2ee.pair.approve');
    expect(admitted).toBe(true);
    expect(container.textContent).toContain('e2ee.pair.retryPublication');
    publish = true;
    await click('e2ee.pair.retryPublication');
    expect(container.textContent).toContain('e2ee.pair.published');
  });
  it('can start a new offer after confirmed pre-submit cancellation without approving it', async () => {
    inspectFailure = new Error('e2ee_join_cancelled');
    await render();
    await click('e2ee.pair.create');
    await click('e2ee.pair.inspect');
    expect(container.textContent).toContain('e2ee.pair.cancelled');
    expect(admitted).toBe(false);
    inspectFailure = undefined;
    await click('e2ee.pair.create');
    await click('e2ee.pair.inspect');
    expect(container.textContent).toContain('55'.repeat(32));
    expect(admitted).toBe(false);
  });
  it('recovers a failed inspection on the next normal call without signing anything', async () => {
    inspectFailure = new Error('temporary');
    await render();
    await click('e2ee.pair.create');
    await click('e2ee.pair.inspect');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(admitted).toBe(false);
    inspectFailure = undefined;
    await click('e2ee.pair.inspect');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(admitted).toBe(false);
  });
  it('does not publish a delayed preview into an unmounted workspace', async () => {
    const response =
      Promise.withResolvers<Awaited<ReturnType<NonNullable<Runtime['inspectPersonalJoin']>>>>();
    runtime.inspectPersonalJoin = () => response.promise;
    await render();
    await click('e2ee.pair.create');
    const button = [...container.querySelectorAll('button')].find(
      (value) => value.textContent === 'e2ee.pair.inspect'
    )!;
    await act(async () => button.click());
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      response.resolve({
        pairingSessionId: offer.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        encryptionPublicKey: '66'.repeat(32),
        credentialHash: '77'.repeat(32),
        protection: 'os-keystore',
      })
    );
    expect(container.textContent).toBe('');
    expect(admitted).toBe(false);
  });
});
