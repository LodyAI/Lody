import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildElectronRedirectUrl,
  buildElectronWebLoginCallbackUrl,
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
