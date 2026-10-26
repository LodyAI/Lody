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
  const render = () =>
    act(async () =>
      root.render(
        <E2eePersonalPairing workspaceId="w" runtime={runtime} canApprove onJoined={() => {}} />
      )
    );
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (value) => value.textContent === text
    );
    if (!button) throw new Error(`missing ${text}`);
    await act(async () => button.click());
  };
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
