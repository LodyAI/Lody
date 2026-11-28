import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createCapacitorAuthHygienePlugin } from './capacitor-auth-hygiene.ts';

function createMemoryPreferences(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get({ key }) {
      return { value: map.has(key) ? map.get(key) : null };
    },
    async set({ key, value }) {
      map.set(key, value);
    },
    async remove({ key }) {
      map.delete(key);
    },
  };
}

function createMemoryLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const NOW = Date.parse('2026-11-26T00:00:00.000Z');

void test('prunes locally expired native session tokens before capacitorClient reads Preferences', async () => {
  const preferences = createMemoryPreferences({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'expired-token.sig',
        expires: '2026-11-25T23:59:59.000Z',
      },
      'better-auth.session_token': {
        value: 'expired-token.sig',
        expires: '2026-11-25T23:59:59.000Z',
      },
    }),
  });
  const plugin = createCapacitorAuthHygienePlugin({
    isNative: () => true,
    getPreferences: async () => preferences,
    getLocalStorage: () => createMemoryLocalStorage(),
    now: () => NOW,
  });

  await plugin.fetchPlugins[0].init('https://backend.lody.ai/api/auth/get-session', {});

  assert.equal(preferences.map.has('better-auth_cookie'), false);
});

void test('retains active and no-expiry native tokens while pruning only expired ones', async () => {
  const preferences = createMemoryPreferences({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'live-token.sig',
        expires: null,
      },
      'better-auth.session_token': {
        value: 'expired-token.sig',
        expires: '2026-11-25T00:00:00.000Z',
      },
    }),
  });
  const plugin = createCapacitorAuthHygienePlugin({
    isNative: () => true,
    getPreferences: async () => preferences,
    getLocalStorage: () => createMemoryLocalStorage(),
    now: () => NOW,
  });

  await plugin.fetchPlugins[0].init('https://backend.lody.ai/api/auth/get-session', {});

  const remaining = JSON.parse(preferences.map.get('better-auth_cookie'));
  assert.deepEqual(remaining, {
    '__Secure-better-auth.session_token': {
      value: 'live-token.sig',
      expires: null,
    },
  });
});

void test('clears server-rejected native Bearer token on /get-session null but preserves a concurrently written newer token', async () => {
  const preferences = createMemoryPreferences({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'revoked-token.sig',
        expires: null,
      },
    }),
    'better-auth_session_data': JSON.stringify({ user: { id: 'old' } }),
  });
  const plugin = createCapacitorAuthHygienePlugin({
    isNative: () => true,
    getPreferences: async () => preferences,
    getLocalStorage: () => createMemoryLocalStorage(),
    now: () => NOW,
  });

  // 1. Stale response for the exact sent Bearer token clears Preferences.
  await plugin.fetchPlugins[0].hooks.onSuccess({
    data: null,
    request: {
      url: 'https://backend.lody.ai/api/auth/get-session',
      headers: { Authorization: 'Bearer revoked-token.sig' },
    },
  });
  assert.equal(preferences.map.has('better-auth_cookie'), false);
  assert.equal(preferences.map.has('better-auth_session_data'), false);

  // 2. Concurrent sign-in writes a newer token before an older /get-session returns null:
  //    neither an anonymous /get-session nor an older Bearer token may erase the new session.
  await preferences.set({
    key: 'better-auth_cookie',
    value: JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'fresh-token.sig',
        expires: null,
      },
    }),
  });
  await plugin.fetchPlugins[0].hooks.onSuccess({
    data: null,
    request: {
      url: 'https://backend.lody.ai/api/auth/get-session',
      headers: {},
    },
  });
  await plugin.fetchPlugins[0].hooks.onSuccess({
    data: null,
    request: {
      url: 'https://backend.lody.ai/api/auth/get-session',
      headers: { Authorization: 'Bearer older-token.sig' },
    },
  });
  const stored = JSON.parse(preferences.map.get('better-auth_cookie'));
  assert.equal(stored['__Secure-better-auth.session_token'].value, 'fresh-token.sig');
});

void test('migrates a valid legacy localStorage session_token into Preferences once without overwriting an existing native token', async () => {
  const localStorage = createMemoryLocalStorage({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'legacy-email-token.sig',
        expires: '2026-12-01T00:00:00.000Z',
      },
      'unrelated.cookie': {
        value: 'keep-me',
        expires: null,
      },
    }),
  });
  const preferences = createMemoryPreferences();
  const plugin = createCapacitorAuthHygienePlugin({
    isNative: () => true,
    getPreferences: async () => preferences,
    getLocalStorage: () => localStorage,
    now: () => NOW,
  });

  await plugin.fetchPlugins[0].init('https://backend.lody.ai/api/auth/get-session', {});

  const migrated = JSON.parse(preferences.map.get('better-auth_cookie'));
  assert.deepEqual(migrated['__Secure-better-auth.session_token'], {
    value: 'legacy-email-token.sig',
    expires: '2026-12-01T00:00:00.000Z',
  });
  assert.deepEqual(migrated['better-auth.session_token'], {
    value: 'legacy-email-token.sig',
    expires: '2026-12-01T00:00:00.000Z',
  });
  assert.deepEqual(JSON.parse(localStorage.getItem('better-auth_cookie')), {
    'unrelated.cookie': { value: 'keep-me', expires: null },
  });

  // When Preferences already holds a valid token, legacy localStorage must not overwrite it.
  const localStorage2 = createMemoryLocalStorage({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'older-legacy-token.sig',
        expires: '2026-12-01T00:00:00.000Z',
      },
    }),
  });
  const preferences2 = createMemoryPreferences({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'existing-native-token.sig',
        expires: '2026-12-02T00:00:00.000Z',
      },
    }),
  });
  const plugin2 = createCapacitorAuthHygienePlugin({
    isNative: () => true,
    getPreferences: async () => preferences2,
    getLocalStorage: () => localStorage2,
    now: () => NOW,
  });

  await plugin2.fetchPlugins[0].init('https://backend.lody.ai/api/auth/get-session', {});

  assert.equal(
    JSON.parse(preferences2.map.get('better-auth_cookie'))['__Secure-better-auth.session_token']
      .value,
    'existing-native-token.sig'
  );
  assert.equal(localStorage2.getItem('better-auth_cookie'), null);
});

void test('non-native browser mode leaves localStorage and Preferences untouched', async () => {
  const localStorage = createMemoryLocalStorage({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'web-token.sig',
        expires: '2026-12-01T00:00:00.000Z',
      },
    }),
  });
  const preferences = createMemoryPreferences({
    'better-auth_cookie': JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'expired-token.sig',
        expires: '2026-11-25T00:00:00.000Z',
      },
    }),
  });
  const plugin = createCapacitorAuthHygienePlugin({
    isNative: () => false,
    getPreferences: async () => preferences,
    getLocalStorage: () => localStorage,
    now: () => NOW,
  });

  await plugin.fetchPlugins[0].init('https://backend.lody.ai/api/auth/get-session', {});
  await plugin.fetchPlugins[0].hooks.onSuccess({
    data: null,
    request: {
      url: 'https://backend.lody.ai/api/auth/get-session',
      headers: { Authorization: 'Bearer expired-token.sig' },
    },
  });

  assert.equal(
    JSON.parse(localStorage.getItem('better-auth_cookie'))['__Secure-better-auth.session_token']
      .value,
    'web-token.sig'
  );
  assert.equal(
    JSON.parse(preferences.map.get('better-auth_cookie'))['__Secure-better-auth.session_token']
      .value,
    'expired-token.sig'
  );
});

void test('default Preferences loader wraps Capacitor plugin Proxy so Promise resolution never invokes Preferences.then()', async () => {
  const source = ts.transpileModule(
    readFileSync(new URL('./capacitor-auth-hygiene.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText;

  const map = new Map([
    [
      'better-auth_cookie',
      JSON.stringify({
        '__Secure-better-auth.session_token': {
          value: 'expired-token.sig',
          expires: '2026-11-25T23:59:59.000Z',
        },
      }),
    ],
  ]);
  const accessedUnknownProps = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const impl = {
      async get({ key }) {
        return { value: map.has(key) ? map.get(key) : null };
      },
      async set({ key, value }) {
        map.set(key, value);
      },
      async remove({ key }) {
        map.delete(key);
      },
    };
    const nativePreferencesProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === '$$typeof') return undefined;
          if (prop === 'toJSON') return () => ({});
          if (prop in impl) return (...args) => impl[prop](...args);
          accessedUnknownProps.push(String(prop));
          return () =>
            Promise.reject(new Error(`"Preferences.${String(prop)}()" is not implemented on ios`));
        },
      }
    );

    const context = vm.createContext({
      Date,
      Headers,
      JSON,
      Number,
      Object,
      Promise,
      URL,
      window: { localStorage: createMemoryLocalStorage() },
    });
    const makeSynthetic = (exports) =>
      new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
        },
        { context }
      );

    let importAttempts = 0;
    const mod = new vm.SourceTextModule(source, {
      context,
      async importModuleDynamically(specifier) {
        assert.equal(specifier, '@capacitor/preferences');
        importAttempts += 1;
        if (importAttempts === 1) {
          throw new Error('transient dynamic import failure');
        }
        const prefsMod = makeSynthetic({ Preferences: nativePreferencesProxy });
        await prefsMod.link(() => {});
        await prefsMod.evaluate();
        return prefsMod;
      },
    });
    await mod.link((specifier) => {
      assert.equal(specifier, 'better-auth-capacitor/client');
      return makeSynthetic({ isNativePlatform: () => true });
    });
    await mod.evaluate();

    const plugin = mod.namespace.createCapacitorAuthHygienePlugin({
      now: () => NOW,
    });

    await plugin.fetchPlugins[0].init('https://backend.lody.ai/api/auth/get-session', {});
    assert.equal(map.has('better-auth_cookie'), true);

    await plugin.fetchPlugins[0].init('https://backend.lody.ai/api/auth/get-session', {});
    assert.equal(map.has('better-auth_cookie'), false);

    map.set(
      'better-auth_cookie',
      JSON.stringify({
        '__Secure-better-auth.session_token': {
          value: 'revoked-token.sig',
          expires: null,
        },
      })
    );
    await plugin.fetchPlugins[0].hooks.onSuccess({
      data: null,
      request: {
        url: 'https://backend.lody.ai/api/auth/get-session',
        headers: { Authorization: 'Bearer revoked-token.sig' },
      },
    });
    assert.equal(map.has('better-auth_cookie'), false);
    assert.deepEqual(accessedUnknownProps, []);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
