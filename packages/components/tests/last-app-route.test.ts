import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearLastAppRoutePath,
  clearLastAppRoutePathIfWorkspaceMatch,
  getWorkspaceSlugFromAppRoutePath,
  normalizeLastAppRoutePath,
  readLastAppRoutePath,
  writeLastAppRoutePath,
} from '../src/lib/last-app-route';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

const installWindowStorage = () => {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('last app route path validation', () => {
  it('accepts conversation routes and preserves query parameters', () => {
    expect(normalizeLastAppRoutePath('/loro-dev/sessions/session-1?tab=changes&pr=12')).toBe(
      '/loro-dev/sessions/session-1?tab=changes&pr=12'
    );
    expect(getWorkspaceSlugFromAppRoutePath('/loro-dev/settings/github')).toBe('loro-dev');
  });

  it('rejects workspace routes that are not conversation routes', () => {
    expect(normalizeLastAppRoutePath('/loro-dev/chat')).toBeNull();
    expect(normalizeLastAppRoutePath('/loro-dev/archive')).toBeNull();
    expect(normalizeLastAppRoutePath('/loro-dev/settings/github')).toBeNull();
    expect(normalizeLastAppRoutePath('/loro-dev/sessions')).toBeNull();
    expect(normalizeLastAppRoutePath('/loro-dev/sessions/session-1/extra')).toBeNull();
  });

  it('rejects root, top-level, malformed, and external paths', () => {
    expect(normalizeLastAppRoutePath('/')).toBeNull();
    expect(normalizeLastAppRoutePath('/login')).toBeNull();
    expect(normalizeLastAppRoutePath('/workspace/create')).toBeNull();
    expect(normalizeLastAppRoutePath('//evil.example/loro/chat')).toBeNull();
    expect(normalizeLastAppRoutePath('https://example.com/loro/chat')).toBeNull();
  });
});

describe('last app route storage', () => {
  it('persists and restores the last conversation route', () => {
    installWindowStorage();

    writeLastAppRoutePath('/loro-dev/sessions/session-1?tab=changes&pr=12');

    expect(readLastAppRoutePath()).toBe('/loro-dev/sessions/session-1?tab=changes&pr=12');
  });

  it('clears a stored route when writing a non-conversation app route', () => {
    installWindowStorage();

    writeLastAppRoutePath('/loro-dev/sessions/session-1');
    writeLastAppRoutePath('/loro-dev/chat?context=github&repo=loro-dev%2Flody');

    expect(readLastAppRoutePath()).toBeNull();
  });

  it('does not overwrite a valid route with a malformed route', () => {
    installWindowStorage();

    writeLastAppRoutePath('/loro-dev/sessions/session-1');
    writeLastAppRoutePath('//evil.example/loro/chat');

    expect(readLastAppRoutePath()).toBe('/loro-dev/sessions/session-1');
  });

  it('clears legacy stored routes that are no longer restorable', () => {
    installWindowStorage();

    localStorage.setItem(
      'lody:lastAppRoute',
      JSON.stringify({
        version: 1,
        path: '/loro-dev/settings/github',
        updatedAt: 1,
      })
    );

    expect(readLastAppRoutePath()).toBeNull();
  });

  it('clears a stored route for a workspace that is no longer accessible', () => {
    installWindowStorage();

    writeLastAppRoutePath('/loro-dev/sessions/session-1');
    clearLastAppRoutePathIfWorkspaceMatch('loro-dev');

    expect(readLastAppRoutePath()).toBeNull();
  });

  it('leaves other workspace routes untouched when clearing by workspace', () => {
    installWindowStorage();

    writeLastAppRoutePath('/loro-dev/sessions/session-1');
    clearLastAppRoutePathIfWorkspaceMatch('other-workspace');

    expect(readLastAppRoutePath()).toBe('/loro-dev/sessions/session-1');
  });

  it('is a no-op when storage is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'localStorage');

    expect(readLastAppRoutePath()).toBeNull();
    expect(() => writeLastAppRoutePath('/loro-dev/chat')).not.toThrow();
    expect(() => clearLastAppRoutePath()).not.toThrow();
  });
});

describe('desktop window navigation isolation', () => {
  it('preserves primary history while auxiliary windows navigate and reload independently', () => {
    const primary = installWindowStorage();
    writeLastAppRoutePath('/local/sessions/original');
    const auxiliary = installWindowStorage();
    vi.stubGlobal('localStorage', primary);
    vi.stubGlobal('sessionStorage', auxiliary);
    vi.stubGlobal('window', { __LODY_ELECTRON__: true });
    vi.stubGlobal('location', { href: 'file:///index.html#/local/sessions/second?window=session' });

    expect(readLastAppRoutePath()).toBeNull();
    writeLastAppRoutePath('/local/sessions/second');
    vi.stubGlobal('location', { href: 'file:///index.html#/local/sessions/second' });
    expect(readLastAppRoutePath()).toBe('/local/sessions/second');
    clearLastAppRoutePath();
    expect(readLastAppRoutePath()).toBeNull();

    auxiliary.clear();
    vi.stubGlobal('location', { href: 'file:///index.html#/' });
    expect(readLastAppRoutePath()).toBe('/local/sessions/original');
  });
});
