import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildElectronBrowserCallbackUrl,
  buildElectronAuthorizationCallbackUrl,
  buildElectronRedirectUrl,
  buildElectronRedirectToken,
  buildElectronWebLoginCallbackUrl,
  clearElectronAuthorizationCode,
  ELECTRON_AUTHORIZATION_CODE_COOKIE_KEY,
  isElectronAuthCallbackDeepLink,
  readElectronAuthorizationCode,
  readElectronAuthCallbackToken,
  redirectToElectronWithAuthorizationCode,
} from '../src/lib/electron-oauth';

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
    const callback = new URL(buildElectronWebLoginCallbackUrl(query, 'https://example.test/app/'));
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
  it('reads the Better Auth electron authorization code cookie', () => {
    installMockWindow('https://lody.ai/login');
    installMockDocument(`${ELECTRON_AUTHORIZATION_CODE_COOKIE_KEY}=auth-code-123%3D%3D`);

    expect(readElectronAuthorizationCode()).toBe('auth-code-123==');
  });

  it('builds the official Electron callback deep link from an authorization code', () => {
    expect(buildElectronAuthorizationCallbackUrl('auth-code-123')).toBe(
      'lody://auth/callback#token=auth-code-123'
    );
  });

  it('encodes the Better Auth redirect token shape for Electron deep links', () => {
    const token = buildElectronRedirectToken('auth-code-123', 'state-123');
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));

    expect(decoded).toEqual({
      identifier: 'auth-code-123',
      state: 'state-123',
    });
  });

  it('builds the Electron deep link using the encoded Better Auth redirect token', () => {
    const parsed = new URL(buildElectronRedirectUrl('auth-code-123', 'state-123'));

    expect(parsed.protocol).toBe('lody:');
    expect(`/${parsed.hostname}${parsed.pathname}`).toBe('/auth/callback');
    expect(parsed.hash).toBe(`#token=${buildElectronRedirectToken('auth-code-123', 'state-123')}`);
  });

  it('builds the auth-origin browser callback URL for Electron sign-in', () => {
    expect(
      buildElectronBrowserCallbackUrl(
        {
          client_id: 'electron',
          state: 'state-123',
          code_challenge: 'challenge-123',
          code_challenge_method: 'S256',
        },
        'https://auth.example.test'
      )
    ).toBe(
      'https://auth.example.test/electron/callback?client_id=electron&state=state-123&code_challenge=challenge-123&code_challenge_method=S256'
    );
  });

  it('builds the Web login callback URL for Electron sign-in', () => {
    expect(
      buildElectronWebLoginCallbackUrl(
        {
          client_id: 'electron',
          state: 'state-123',
          code_challenge: 'challenge-123',
          code_challenge_method: 'S256',
        },
        '/'
      )
    ).toBe(
      '/login?client_id=electron&state=state-123&code_challenge=challenge-123&code_challenge_method=S256'
    );
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

  it('builds an absolute Web login callback URL when given a site URL', () => {
    expect(
      buildElectronWebLoginCallbackUrl(
        {
          client_id: 'electron',
          state: 'state-123',
          code_challenge: 'challenge-123',
        },
        'https://lody.ai/app'
      )
    ).toBe(
      'https://lody.ai/app/login?client_id=electron&state=state-123&code_challenge=challenge-123'
    );
  });

  it('clears the Better Auth electron authorization code cookie', () => {
    installMockWindow('https://lody.ai/login');
    const mockDocument = installMockDocument(
      `${ELECTRON_AUTHORIZATION_CODE_COOKIE_KEY}=auth-code-123`
    );

    clearElectronAuthorizationCode();

    expect(mockDocument.cookie).toBe(
      `${ELECTRON_AUTHORIZATION_CODE_COOKIE_KEY}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`
    );
  });

  it('redirects the browser page back to Electron with the encoded redirect token', () => {
    const mockWindow = installMockWindow('https://lody.ai/login');

    redirectToElectronWithAuthorizationCode('auth-code-123', 'state-123');

    expect(mockWindow.location.replace).toHaveBeenCalledWith(
      `lody://auth/callback#token=${buildElectronRedirectToken('auth-code-123', 'state-123')}`
    );
  });
});

describe('isElectronAuthCallbackDeepLink', () => {
  it('matches the token-bearing auth callback deep link', () => {
    expect(isElectronAuthCallbackDeepLink('lody://auth/callback#token=abc123')).toBe(true);
  });

  it('matches the deep link produced by buildElectronAuthorizationCallbackUrl', () => {
    expect(isElectronAuthCallbackDeepLink(buildElectronAuthorizationCallbackUrl('abc'))).toBe(true);
  });

  it('tolerates a trailing slash and the single-slash form', () => {
    expect(isElectronAuthCallbackDeepLink('lody://auth/callback/#token=abc')).toBe(true);
    expect(isElectronAuthCallbackDeepLink('lody:/auth/callback#token=xyz')).toBe(true);
  });

  it('requires a token in the fragment', () => {
    expect(isElectronAuthCallbackDeepLink('lody://auth/callback')).toBe(false);
    expect(isElectronAuthCallbackDeepLink('lody://auth/callback#foo=bar')).toBe(false);
  });

  it('ignores other lody:// deep links', () => {
    expect(isElectronAuthCallbackDeepLink('lody://github-install?installation_id=123')).toBe(false);
    expect(isElectronAuthCallbackDeepLink('lody://auth/other#token=abc')).toBe(false);
  });

  it('ignores non-lody and malformed URLs', () => {
    expect(isElectronAuthCallbackDeepLink('https://lody.ai/auth/callback#token=abc')).toBe(false);
    expect(isElectronAuthCallbackDeepLink('not a url')).toBe(false);
  });
});

describe('readElectronAuthCallbackToken', () => {
  it('reads the token from Electron auth callback deep links', () => {
    expect(readElectronAuthCallbackToken('lody://auth/callback#token=abc123')).toBe('abc123');
    expect(readElectronAuthCallbackToken('lody:/auth/callback#token=xyz')).toBe('xyz');
  });

  it('returns null for non-auth deep links', () => {
    expect(readElectronAuthCallbackToken('lody://github-install?installation_id=123')).toBeNull();
    expect(readElectronAuthCallbackToken('not a url')).toBeNull();
  });
});
