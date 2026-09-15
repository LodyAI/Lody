// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '../src/components/login-page';
import { AuthProvider } from '../src/providers/convex-provider';
import { StableSessionContext } from '../src/hooks/useStableSession';
import type { LodyAuthClient } from '../src/lib/auth';
import { initI18n } from '../src/i18n';

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

  const renderLoginPage = async (
    authClient: LodyAuthClient,
    sessionValue: StableSessionValue = createSessionValue(true)
  ) => {
    await act(async () => {
      root.render(
        <AuthProvider authClient={authClient}>
          <StableSessionContext.Provider value={sessionValue}>
            <LoginPage replaceLocation={() => undefined} />
          </StableSessionContext.Provider>
        </AuthProvider>
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
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

    await renderLoginPage(authClient, createSessionValue(false));
    await clickButton(/Continue with GitHub/i);

    const callbackURL = signInSocial.mock.calls[0]?.[0]?.callbackURL ?? '';
    expect(callbackURL).toContain('client_id=electron');
    expect(callbackURL).toContain('state=state-abc');
    expect(callbackURL).toContain('code_challenge=challenge-xyz');
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
