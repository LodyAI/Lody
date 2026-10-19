// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Provider, createStore } from 'jotai';

import { LoginPage } from '../src/components/login-page';
import { AuthProvider } from '../src/providers/convex-provider';
import { StableSessionContext } from '../src/hooks/useStableSession';
import type { LodyAuthClient } from '../src/lib/auth';
import { initI18n } from '../src/i18n';

type StableSessionValue = NonNullable<
  React.ComponentProps<typeof StableSessionContext.Provider>['value']
>;

const SIGNED_OUT: StableSessionValue = {
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

function signedIn(): StableSessionValue {
  const data = {
    user: { id: 'user-1', email: 'person@example.com', name: 'Person' },
    session: { token: 'session-token' },
  } as StableSessionValue['data'];
  return {
    ...SIGNED_OUT,
    data,
    rawData: data,
    hasLocalToken: true,
    hasRawUser: true,
    confirmedUnauthenticated: false,
  };
}

const authClient = {
  signIn: {
    social: async () => undefined,
    email: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
  },
  signUp: { email: async () => ({ data: null, error: null }) },
  sendVerificationEmail: async () => ({ data: null, error: null }),
  signOut: async () => undefined,
  getSession: async () => ({ data: null }),
} as unknown as LodyAuthClient;

describe('login page last-used method', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (session: StableSessionValue = SIGNED_OUT) => {
    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <AuthProvider authClient={authClient}>
            <StableSessionContext.Provider value={session}>
              <LoginPage replaceLocation={() => undefined} isElectronRenderer={false} />
            </StableSessionContext.Provider>
          </AuthProvider>
        </Provider>
      );
    });
  };

  // A fresh mount, as a later visit to /login would be.
  const remount = async (session: StableSessionValue = SIGNED_OUT) => {
    act(() => root.unmount());
    root = createRoot(container);
    await render(session);
  };

  const buttons = () => Array.from(container.querySelectorAll('button'));
  const buttonsMarkedLastUsed = () =>
    buttons()
      .filter((button) => /Last used/.test(button.textContent ?? ''))
      .map((button) => (button.textContent ?? '').replace('Last used', '').trim());

  const click = async (label: RegExp) => {
    const button = buttons().find((candidate) => label.test(candidate.textContent ?? ''));
    expect(button, `no button matching ${label}`).toBeDefined();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const typeInto = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/login');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('marks nothing on a device that has not signed in before', async () => {
    await render();

    expect(buttons().some((button) => /Continue with GitHub/.test(button.textContent ?? ''))).toBe(
      true
    );
    expect(buttonsMarkedLastUsed()).toEqual([]);
  });

  it('marks the provider whose sign-in completed, after the OAuth round trip returns', async () => {
    await render();
    await click(/Continue with Google/);

    // The provider redirects back to /login with a session.
    await remount(signedIn());
    await remount();

    expect(buttonsMarkedLastUsed()).toEqual(['Continue with Google']);
  });

  it('does not mark a provider whose sign-in was only started', async () => {
    await render();
    await click(/Continue with Apple/);
    await remount();

    expect(buttonsMarkedLastUsed()).toEqual([]);
  });

  it('marks email after a successful email sign-in', async () => {
    window.history.replaceState({}, '', '/login?view=email');
    await render();

    const email = container.querySelector<HTMLInputElement>('input[type="email"]');
    const password = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(email).not.toBeNull();
    expect(password).not.toBeNull();
    await act(async () => {
      typeInto(email!, 'person@example.com');
      typeInto(password!, 'correct-horse-1');
    });
    await act(async () => {
      email!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    window.history.replaceState({}, '', '/login');
    await remount();

    expect(buttonsMarkedLastUsed()).toEqual(['Continue with email']);
  });

  it('ignores a stored value that is not a sign-in method', async () => {
    window.localStorage.setItem('lody.auth.last_login_method', 'myspace');
    await render();

    expect(buttonsMarkedLastUsed()).toEqual([]);
  });
});
