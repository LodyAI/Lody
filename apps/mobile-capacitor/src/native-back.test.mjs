import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const nativeBackSource = ts.transpileModule(
  readFileSync(new URL('./native-back.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

const mobileBackNavSource = ts.transpileModule(
  readFileSync(
    new URL('../../../packages/components/src/lib/mobile-back-navigation.ts', import.meta.url),
    'utf8'
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

async function boot({ platform = 'android', deferListener = false } = {}) {
  const listeners = [];
  const minimized = [];
  const historyBacks = [];
  let releaseListener;
  const listenerGate = deferListener
    ? new Promise((resolve) => {
        releaseListener = resolve;
      })
    : Promise.resolve();

  const context = vm.createContext({ Promise });
  const navModule = new vm.SourceTextModule(mobileBackNavSource, { context });
  await navModule.link(() => {
    throw new Error('Unexpected import in mobile-back-navigation.ts');
  });
  await navModule.evaluate();

  const syntheticExports = {
    '@capacitor/core': {
      Capacitor: {
        getPlatform: () => platform,
      },
    },
    '@capacitor/app': {
      App: {
        addListener: async (name, fn) => {
          const record = { name, fn, removed: false };
          listeners.push(record);
          await listenerGate;
          return {
            remove: async () => {
              record.removed = true;
              const index = listeners.indexOf(record);
              if (index !== -1) listeners.splice(index, 1);
            },
          };
        },
        minimizeApp: async () => {
          minimized.push(Date.now());
        },
      },
    },
  };

  const entry = new vm.SourceTextModule(nativeBackSource, { context });
  await entry.link((specifier) => {
    if (specifier === '@lody/components/lib/mobile-back-navigation') {
      return navModule;
    }
    const mod = syntheticExports[specifier];
    if (!mod) throw new Error(`Unexpected import: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(mod),
      function () {
        for (const [key, value] of Object.entries(mod)) {
          this.setExport(key, value);
        }
      },
      { context }
    );
  });
  await entry.evaluate();

  const location = { pathname: '/workspace/chat', search: {} };
  const router = {
    state: { location },
    history: {
      back: () => {
        historyBacks.push({
          pathname: location.pathname,
          marked: navModule.namespace.consumeMobileBackNavigation(),
        });
      },
    },
  };

  const stop = entry.namespace.initNativeBackNavigation(router);
  const triggerBack = (canGoBack = true) => {
    for (const listener of listeners.filter((item) => item.name === 'backButton')) {
      listener.fn({ canGoBack });
    }
  };

  return {
    entry: entry.namespace,
    nav: navModule.namespace,
    location,
    listeners,
    minimized,
    historyBacks,
    stop,
    releaseListener: () => releaseListener?.(),
    triggerBack,
  };
}

await test('does not install a backButton listener on iOS', async () => {
  const t = await boot({ platform: 'ios' });
  assert.equal(t.listeners.length, 0);
  await t.stop();
});

await test('dispatches registered mobile back handlers before router history or minimizeApp', async () => {
  const t = await boot();
  const calls = [];
  const unregister = t.nav.registerMobileBackHandler(() => {
    calls.push('handler');
  });

  t.location.pathname = '/workspace/settings/appearance';
  t.triggerBack(true);

  assert.deepEqual(calls, ['handler']);
  assert.equal(t.historyBacks.length, 0);
  assert.equal(t.minimized.length, 0);

  unregister();
  await t.stop();
});

await test('minimizes on root home routes even when WebView history reports canGoBack', async () => {
  const t = await boot();
  for (const pathname of ['/', '/app', '/login', '/onboarding', '/workspace', '/workspace/chat']) {
    t.location.pathname = pathname;
    t.location.search = {};
    t.triggerBack(true);
  }

  assert.equal(t.minimized.length, 6);
  assert.equal(t.historyBacks.length, 0);
  await t.stop();
});

await test('marks back navigation and falls back to router.history.back on non-root routes', async () => {
  const t = await boot();
  t.location.pathname = '/workspace/chat';
  t.location.search = { context: 'local', machine: 'm1', project: 'p1' };
  t.triggerBack(true);

  t.location.pathname = '/forgot-password';
  t.location.search = {};
  t.triggerBack(true);

  assert.deepEqual(t.historyBacks, [
    { pathname: '/workspace/chat', marked: true },
    { pathname: '/forgot-password', marked: true },
  ]);
  assert.equal(t.minimized.length, 0);

  t.location.pathname = '/workspace/archive';
  t.triggerBack(false);
  assert.equal(t.minimized.length, 1);

  await t.stop();
});

await test('removes a pending listener cleanly when disposed before addListener resolves', async () => {
  const t = await boot({ deferListener: true });
  assert.equal(t.listeners.length, 1);

  const stopPromise = t.stop();
  t.triggerBack(true);
  assert.equal(t.minimized.length, 0);

  t.releaseListener();
  await stopPromise;
  assert.equal(t.listeners.length, 0);
});
