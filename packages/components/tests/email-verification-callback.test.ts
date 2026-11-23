import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  buildEmailVerificationCallbackSearch,
  buildEmailVerificationCallbackUrl,
} from '../src/lib/email-verification-callback';
import {
  buildElectronRedirectUrl,
  buildElectronWebLoginCallbackUrl,
} from '../src/lib/electron-oauth';
import { runNativeOAuthSignIn, waitForNativeOAuthReturn } from '../src/lib/native-oauth';

describe('email-verification-callback', () => {
  const baseInput = {
    targetEmail: 'user@example.com',
    appOrigin: 'https://app.lody.ai',
    loginPathname: '/login',
  };

  describe('buildEmailVerificationCallbackSearch', () => {
    it('keeps the email sign-in view and drops stale error state', () => {
      const params = buildEmailVerificationCallbackSearch({
        ...baseInput,
        sourceSearchParams: new URLSearchParams({
          view: 'oauth',
          email: 'old@example.com',
          error: 'TOKEN_EXPIRED',
        }),
      });

      expect(params.get('view')).toBe('email');
      expect(params.get('email')).toBe('user@example.com');
      expect(params.has('error')).toBe(false);
    });

    it('preserves a safe redirect for invite and protected-workspace flows', () => {
      const params = buildEmailVerificationCallbackSearch({
        ...baseInput,
        sourceSearchParams: new URLSearchParams({
          redirect: '/invite/abc?workspace=lody',
        }),
      });

      expect(params.get('redirect')).toBe('/invite/abc?workspace=lody');
    });

    it('drops unsafe redirects from verification callbacks', () => {
      const params = buildEmailVerificationCallbackSearch({
        ...baseInput,
        sourceSearchParams: new URLSearchParams({
          redirect: 'https://evil.example/login',
        }),
      });

      expect(params.has('redirect')).toBe(false);
    });

    it('preserves Electron OAuth state through verification callbacks', () => {
      const params = buildEmailVerificationCallbackSearch({
        ...baseInput,
        sourceSearchParams: new URLSearchParams(),
        electronOAuthQuery: {
          client_id: 'electron',
          state: 'state-1',
          code_challenge: 'challenge-1',
          code_challenge_method: 'S256',
        },
      });

      expect(params.get('client_id')).toBe('electron');
      expect(params.get('state')).toBe('state-1');
      expect(params.get('code_challenge')).toBe('challenge-1');
      expect(params.get('code_challenge_method')).toBe('S256');
    });

    it('normalizes the mobile ./ login path before building callback URLs', () => {
      const url = buildEmailVerificationCallbackUrl({
        ...baseInput,
        callbackBaseUrl: 'https://lody.ai',
        loginPathname: './login',
        sourceSearchParams: new URLSearchParams(),
      });

      expect(url).toBe('https://lody.ai/login?view=email&email=user%40example.com');
    });

    it('keeps a configured public app base path without duplicating it', () => {
      const url = buildEmailVerificationCallbackUrl({
        ...baseInput,
        callbackBaseUrl: 'https://lody.ai/app',
        loginPathname: '/app/login',
        sourceSearchParams: new URLSearchParams(),
      });

      expect(url).toBe('https://lody.ai/app/login?view=email&email=user%40example.com');
    });

    it('still forbids redirecting back to the login page when callbackPathname differs', () => {
      const params = buildEmailVerificationCallbackSearch({
        ...baseInput,
        sourceSearchParams: new URLSearchParams({ redirect: '/login' }),
      });

      expect(params.has('redirect')).toBe(false);
    });
  });
});

describe('electron-oauth', () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

  function installMockWindow(url: string): Window {
    const parsedUrl = new URL(url);
    const replace = vi.fn();
    const mockWindow = {
      location: {
        href: parsedUrl.toString(),
        pathname: parsedUrl.pathname,
        search: parsedUrl.search,
        hash: parsedUrl.hash,
        protocol: parsedUrl.protocol,
        origin: parsedUrl.origin,
        replace,
      },
    } as unknown as Window;

    Object.defineProperty(globalThis, 'window', {
      value: mockWindow,
      configurable: true,
      writable: true,
    });

    return mockWindow;
  }

  function installMockDocument(cookie = ''): Document {
    const mockDocument = {
      cookie,
    } as unknown as Document;

    Object.defineProperty(globalThis, 'document', {
      value: mockDocument,
      configurable: true,
      writable: true,
    });

    return mockDocument;
  }

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }

    if (originalDocumentDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  describe('electron oauth helpers', () => {
    it('preserves Nightly selection across browser login and selects only a fixed callback scheme', () => {
      const query = {
        client_id: 'electron',
        state: 'state',
        code_challenge: 'challenge',
        desktop_channel: 'nightly' as const,
      };
      const callback = new URL(
        buildElectronWebLoginCallbackUrl(query, 'https://example.test/app/')
      );
      expect(callback.searchParams.get('desktop_channel')).toBe('nightly');
      expect(callback.searchParams.get('client_id')).toBe('electron');
      expect(buildElectronRedirectUrl('code', 'state', 'nightly')).toMatch(
        /^ai\.lody\.nightly:\/\/auth\/callback#token=/
      );
      expect(buildElectronRedirectUrl('code', 'state')).toMatch(/^lody:\/\/auth\/callback#token=/);
      expect(() =>
        buildElectronRedirectUrl('code', 'state', 'https://attacker.test' as 'nightly')
      ).toThrow('Unsupported desktop callback channel');
    });

    it('keeps a configured app base path for the Web login callback URL', () => {
      expect(
        buildElectronWebLoginCallbackUrl(
          {
            client_id: 'electron',
            state: 'state-123',
            code_challenge: 'challenge-123',
          },
          '/app/'
        )
      ).toBe('/app/login?client_id=electron&state=state-123&code_challenge=challenge-123');
    });
  });
});

describe('native-oauth', () => {
  class MockDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = 'visible';
  }

  class MockWindow extends EventTarget {
    document = new MockDocument();
  }

  const returnGraceMs = 50;

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('waitForNativeOAuthReturn', () => {
    it('waits until the app loses focus and returns', async () => {
      const appWindow = new MockWindow();
      let returned = false;
      const returnedPromise = waitForNativeOAuthReturn(appWindow).then(() => {
        returned = true;
      });

      appWindow.dispatchEvent(new Event('focus'));
      await Promise.resolve();

      expect(returned).toBe(false);

      appWindow.dispatchEvent(new Event('blur'));
      appWindow.dispatchEvent(new Event('focus'));
      await returnedPromise;

      expect(returned).toBe(true);
    });

    it('treats visibility becoming visible after hidden as a return', async () => {
      const appWindow = new MockWindow();
      const returnedPromise = waitForNativeOAuthReturn(appWindow);

      appWindow.document.visibilityState = 'hidden';
      appWindow.document.dispatchEvent(new Event('visibilitychange'));
      appWindow.document.visibilityState = 'visible';
      appWindow.document.dispatchEvent(new Event('visibilitychange'));

      await expect(returnedPromise).resolves.toBeUndefined();
    });
  });

  describe('runNativeOAuthSignIn', () => {
    it('returns without session when the native browser returns and the sign-in promise hangs', async () => {
      vi.useFakeTimers();
      const appWindow = new MockWindow();
      const resultPromise = runNativeOAuthSignIn(() => new Promise(() => undefined), {
        appWindow,
        returnGraceMs,
      });

      appWindow.dispatchEvent(new Event('blur'));
      appWindow.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(returnGraceMs);

      await expect(resultPromise).resolves.toBe('returned_without_session');
    });

    it('does not report interruption when a session update arrives during the return grace period', async () => {
      vi.useFakeTimers();
      const appWindow = new MockWindow();
      const resultPromise = runNativeOAuthSignIn(() => new Promise(() => undefined), {
        appWindow,
        returnGraceMs,
      });

      appWindow.dispatchEvent(new Event('blur'));
      appWindow.dispatchEvent(new Event('focus'));
      appWindow.dispatchEvent(new Event('better-auth:session-update'));
      await vi.advanceTimersByTimeAsync(returnGraceMs);

      await expect(resultPromise).resolves.toBe('completed');
    });
  });
});
