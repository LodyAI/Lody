// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '../src/components/login-page';
import { AuthProvider } from '../src/providers/convex-provider';
import { StableSessionContext } from '../src/hooks/useStableSession';
import type { LodyAuthClient } from '../src/lib/auth';
import { initI18n } from '../src/i18n';
import { Provider, createStore } from 'jotai';
import { electronLoginErrorAtom, electronLoginPhaseAtom } from '../src/atoms';

// jsdom cannot navigate to a custom scheme, and `window.location.replace` is
// unforgeable, so the one navigation primitive is replaced. Everything else in
// the module (URL building, token encoding, the cookie helpers) stays real.
const { deepLinkNavigations } = vi.hoisted(() => ({ deepLinkNavigations: [] as string[] }));
vi.mock('../src/lib/electron-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/electron-oauth')>();
  return {
    ...actual,
    redirectToElectronDeepLink: (url: string) => {
      deepLinkNavigations.push(url);
    },
  };
});

const ELECTRON_QUERY = '?client_id=electron&state=state-abc&code_challenge=challenge-xyz';

type StableSessionValue = NonNullable<
  React.ComponentProps<typeof StableSessionContext.Provider>['value']
>;

function createSessionValue(signedIn: boolean): StableSessionValue {
  if (!signedIn) {
    return {
      data: null,
      rawData: null,
      bootstrapSnapshot: null,
      hasLocalToken: false,
      hasRawUser: false,
      isOptimistic: false,
      isPending: false,
      isRetrying: false,
      error: null,
      confirmedUnauthenticated: true,
      refetch: async () => undefined,
    };
  }

  const data = {
    user: { id: 'user-old', email: 'old-account@lody.ai', name: 'Old Account' },
    session: { token: 'browser-session-token' },
  } as StableSessionValue['data'];

  return {
    data,
    rawData: data,
    bootstrapSnapshot: null,
    hasLocalToken: true,
    hasRawUser: true,
    isOptimistic: false,
    isPending: false,
    isRetrying: false,
    error: null,
    confirmedUnauthenticated: false,
    refetch: async () => undefined,
  };
}

type TransferUser = (options?: {
  fetchOptions?: { query?: Record<string, string> };
}) => Promise<{ data?: { electron_authorization_code?: string | null } }>;

function createAuthClient(overrides: {
  transferUser?: TransferUser;
  signOut?: () => Promise<unknown>;
  signInSocial?: (options?: { provider?: string; callbackURL?: string }) => Promise<unknown>;
}): LodyAuthClient {
  return {
    signIn: {
      social: overrides.signInSocial ?? (async () => undefined),
      email: async () => ({ data: null, error: null }),
    },
    signUp: { email: async () => ({ data: null, error: null }) },
    sendVerificationEmail: async () => ({ data: null, error: null }),
    signOut: overrides.signOut ?? (async () => undefined),
    electron: overrides.transferUser ? { transferUser: overrides.transferUser } : undefined,
  } as unknown as LodyAuthClient;
}

function readDeepLinkPayload(deepLinkUrl: string): unknown {
  const token = new URLSearchParams(new URL(deepLinkUrl).hash.slice(1)).get('token') ?? '';
  const base64 = decodeURIComponent(token).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64));
}

describe('electron browser sign-in handoff', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  const renderLoginPage = async (
    authClient: LodyAuthClient,
    sessionValue: StableSessionValue = createSessionValue(true),
    desktop = false
  ) => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <AuthProvider authClient={authClient}>
            <StableSessionContext.Provider value={sessionValue}>
              <LoginPage replaceLocation={() => undefined} isElectronRenderer={desktop} />
            </StableSessionContext.Provider>
          </AuthProvider>
        </Provider>
      );
    });
  };

  const findButton = (label: RegExp): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((button) =>
      label.test(button.textContent ?? '')
    );

  const clickButton = async (label: RegExp) => {
    const button = findButton(label);
    expect(button, `no button matching ${label}`).toBeDefined();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const handoffLink = () =>
    container.querySelector<HTMLAnchorElement>('a[data-electron-handoff-link]');

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    window.history.replaceState({}, '', `/login${ELECTRON_QUERY}`);
    deepLinkNavigations.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    store = createStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('shows the main-process failure and allows a new browser attempt', async () => {
    window.history.replaceState({}, '', '/login');
    store.set(electronLoginPhaseAtom, 'error');
    store.set(electronLoginErrorAtom, 'exchange_timeout');
    await renderLoginPage(
      createAuthClient({
        signInSocial: async () => {
          store.set(electronLoginPhaseAtom, 'waiting');
          store.set(electronLoginErrorAtom, null);
        },
      }),
      createSessionValue(false),
      true
    );
    expect(container.textContent).toContain('The sign-in request timed out');
    await clickButton(/Open browser to sign in/i);
    expect(container.textContent).toContain('Waiting for browser sign-in');
    expect(findButton(/Open browser to sign in/i)?.disabled).toBe(false);
  });

  it('restores exchange progress from the main snapshot on a newly mounted page', async () => {
    window.history.replaceState({}, '', '/login');
    store.set(electronLoginPhaseAtom, 'exchanging');
    await renderLoginPage(createAuthClient({}), createSessionValue(false), true);
    expect(container.textContent).toContain('Signing you in');
    expect(findButton(/Open browser to sign in/i)).toBeUndefined();
  });

  it('names the browser account and hands nothing over until the user chooses', async () => {
    const transferUser = vi.fn<TransferUser>(async () => ({
      data: { electron_authorization_code: 'code-123' },
    }));
    await renderLoginPage(createAuthClient({ transferUser }));

    expect(container.textContent).toContain('old-account@lody.ai');
    expect(findButton(/Continue with this account/i)).toBeDefined();
    expect(findButton(/Use a different account/i)).toBeDefined();
    // The desktop app was signed out of this account; bridging the browser
    // session without being asked is what left the user with no way to switch.
    expect(transferUser).not.toHaveBeenCalled();
    expect(deepLinkNavigations).toEqual([]);
    expect(handoffLink()).toBeNull();
  });

  it('offers a clickable desktop link carrying the same payload it navigates to', async () => {
    const transferUser = vi.fn<TransferUser>(async () => ({
      data: { electron_authorization_code: 'code-123' },
    }));
    await renderLoginPage(createAuthClient({ transferUser }));

    await clickButton(/Continue with this account/i);

    expect(transferUser).toHaveBeenCalledTimes(1);
    expect(transferUser.mock.calls[0]?.[0]?.fetchOptions?.query).toMatchObject({
      client_id: 'electron',
      state: 'state-abc',
      code_challenge: 'challenge-xyz',
    });

    const link = handoffLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toMatch(/^lody:\/\/auth\/callback#token=/);
    expect(readDeepLinkPayload(link!.getAttribute('href')!)).toEqual({
      identifier: 'code-123',
      state: 'state-abc',
    });
    // The automatic attempt and the visible fallback must be the same handoff.
    expect(deepLinkNavigations).toEqual([link!.getAttribute('href')]);
    // Switching accounts stays reachable after the code exists.
    expect(findButton(/Use a different account/i)).toBeDefined();
  });

  it('returns Nightly authorization to Nightly and preserves its PKCE state', async () => {
    window.history.replaceState({}, '', `/login${ELECTRON_QUERY}&desktop_channel=nightly`);
    await renderLoginPage(
      createAuthClient({
        transferUser: async () => ({ data: { electron_authorization_code: 'nightly-code' } }),
      })
    );
    await clickButton(/Continue with this account/i);
    const url = handoffLink()?.getAttribute('href');
    expect(url).toMatch(/^ai\.lody\.nightly:\/\/auth\/callback#token=/);
    expect(readDeepLinkPayload(url!)).toEqual({ identifier: 'nightly-code', state: 'state-abc' });
    expect(deepLinkNavigations).toEqual([url]);
  });

  it('does not offer a desktop handoff for an unrecognized callback channel', async () => {
    window.history.replaceState(
      {},
      '',
      `/login${ELECTRON_QUERY}&desktop_channel=https%3A%2F%2Fattacker.test`
    );
    await renderLoginPage(
      createAuthClient({
        transferUser: async () => ({ data: { electron_authorization_code: 'code' } }),
      })
    );
    expect(findButton(/Continue with this account/i)).toBeUndefined();
    expect(handoffLink()).toBeNull();
    expect(deepLinkNavigations).toEqual([]);
  });

  it('drops a transfer that lands after the user switched accounts', async () => {
    let resolveTransfer: ((code: string) => void) | undefined;
    const transferUser = vi.fn<TransferUser>(
      () =>
        new Promise((resolve) => {
          resolveTransfer = (code) => resolve({ data: { electron_authorization_code: code } });
        })
    );
    const signOut = vi.fn(async () => undefined);
    await renderLoginPage(createAuthClient({ transferUser, signOut }));

    await clickButton(/Continue with this account/i);
    expect(transferUser).toHaveBeenCalledTimes(1);

    await clickButton(/Use a different account/i);
    expect(signOut).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTransfer?.('code-from-old-account');
    });

    // The old account's code must not become a usable handoff after the switch.
    expect(handoffLink()).toBeNull();
    expect(deepLinkNavigations).toEqual([]);
  });

  it('keeps this attempt PKCE parameters across the account switch', async () => {
    const signInSocial = vi.fn(async () => undefined);
    const authClient = createAuthClient({
      transferUser: async () => ({ data: { electron_authorization_code: 'code-123' } }),
      signInSocial,
    });
    await renderLoginPage(authClient);
    await clickButton(/Use a different account/i);

    // The desktop app is still waiting on the code verifier for this state, so
    // the signed-out page has to keep carrying it into the next sign-in.
    const search = new URLSearchParams(window.location.search);
    expect(search.get('client_id')).toBe('electron');
    expect(search.get('state')).toBe('state-abc');
    expect(search.get('code_challenge')).toBe('challenge-xyz');

    // Remount for the signed-out render instead of swapping panels in place:
    // the card's `AnimatePresence` uses `mode="wait"`, so the incoming provider
    // panel would not mount until the handoff panel's exit transition finished,
    // which is real time this test must not race.
    await act(async () => root.render(null));
    await renderLoginPage(authClient, createSessionValue(false));
    await clickButton(/Continue with GitHub/i);

    const callbackURL = signInSocial.mock.calls[0]?.[0]?.callbackURL ?? '';
    expect(callbackURL).toContain('client_id=electron');
    expect(callbackURL).toContain('state=state-abc');
    expect(callbackURL).toContain('code_challenge=challenge-xyz');
  });

  // Better Auth reports a refused sign-out in `response.error` and a transport
  // failure by throwing; neither may leave the handoff offering the account the
  // user asked to leave, because this browser's cookie is what a transfer hands
  // over.
  const signOutFailures: [label: string, signOut: () => Promise<unknown>][] = [
    ['a rejected request', () => Promise.reject(new Error('network down'))],
    ['an error response', async () => ({ data: null, error: { message: 'sign out failed' } })],
  ];
  it.each(signOutFailures)(
    'blocks the handoff when the account switch fails with %s',
    async (_label, signOut) => {
      const transferUser = vi.fn<TransferUser>(async () => ({
        data: { electron_authorization_code: 'code-123' },
      }));
      await renderLoginPage(createAuthClient({ transferUser, signOut }));

      await clickButton(/Use a different account/i);

      expect(container.textContent).toContain('Could not sign out of this browser');
      // The old account is still the one this browser would hand over.
      expect(container.textContent).toContain('old-account@lody.ai');
      const continueButton = findButton(/Continue with this account/i);
      expect(continueButton?.disabled).toBe(true);

      await clickButton(/Continue with this account/i);
      expect(transferUser).not.toHaveBeenCalled();
      expect(handoffLink()).toBeNull();
      expect(deepLinkNavigations).toEqual([]);
    }
  );

  it('releases the handoff again once a retried account switch succeeds', async () => {
    const transferUser = vi.fn<TransferUser>(async () => ({
      data: { electron_authorization_code: 'code-123' },
    }));
    const signOut = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ data: { success: true }, error: null });
    await renderLoginPage(createAuthClient({ transferUser, signOut }));

    await clickButton(/Use a different account/i);
    expect(findButton(/Continue with this account/i)?.disabled).toBe(true);

    await clickButton(/Use a different account/i);
    expect(signOut).toHaveBeenCalledTimes(2);

    // The banner's disappearance is deliberately not asserted: the error sits
    // inside `AnimatePresence`, so a cleared message stays mounted until its
    // exit transition finishes — real time this test must not race. The block
    // being lifted is what matters, and the transfer below proves it.
    const continueButton = findButton(/Continue with this account/i);
    expect(continueButton?.disabled).toBe(false);
    await clickButton(/Continue with this account/i);
    expect(transferUser).toHaveBeenCalledTimes(1);
    expect(handoffLink()).not.toBeNull();
  });

  it('keeps a retry entry point when the transfer fails', async () => {
    const transferUser = vi.fn<TransferUser>(async () => {
      throw new Error('transfer failed');
    });
    await renderLoginPage(createAuthClient({ transferUser }));

    await clickButton(/Continue with this account/i);

    expect(container.textContent).toContain('Login failed');
    expect(handoffLink()).toBeNull();
    expect(deepLinkNavigations).toEqual([]);

    const retry = findButton(/Continue with this account/i);
    expect(retry).toBeDefined();
    expect(retry!.disabled).toBe(false);

    await clickButton(/Continue with this account/i);
    expect(transferUser).toHaveBeenCalledTimes(2);
  });
});
