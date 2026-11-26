import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual entry with module boundaries substituted. This checks the
// import ordering: loading main itself starts auth/storage owners.
const source = ts.transpileModule(
  readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }
).outputText;

const polyfillSource = ts.transpileModule(
  readFileSync(new URL('./polyfills.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

async function run({
  native = true,
  available = true,
  outcome = 'none',
  wipe,
  consumeError,
  credentialCleanupFailed = false,
  acknowledged,
} = {}) {
  const events = [];
  let failure;
  let diagnosticsInstalled = false;
  const context = vm.createContext({
    AbortController,
    AbortSignal: class extends AbortSignal {
      static any = undefined;
    },
    window: {
      sessionStorage: {
        clear() {
          events.push('session-clear');
        },
      },
      __LODY_BOOT__: {
        fail(error) {
          failure = error;
        },
      },
    },
  });
  vm.runInContext('delete Promise.withResolvers', context);
  function module(exports) {
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { context }
    );
  }
  const capacitor = module({
    Capacitor: { isNativePlatform: () => native, isPluginAvailable: () => available },
    registerPlugin: () => ({
      async getResetResult() {
        events.push('read-result');
        if (consumeError) throw consumeError;
        return { outcome, credentialCleanupFailed };
      },
      async acknowledgeResetResult() {
        events.push('acknowledge');
        return acknowledged;
      },
    }),
  });
  const entry = new vm.SourceTextModule(source, {
    context,
    async importModuleDynamically(specifier) {
      let imported;
      if (specifier === './main') {
        // App imports must see the real compatibility entry already evaluated.
        assert.equal(vm.runInContext('typeof Promise.withResolvers', context), 'function');
        assert.equal(vm.runInContext('typeof AbortSignal.any', context), 'function');
        assert.ok(diagnosticsInstalled, 'client errors are captured before the app loads');
        events.push('main-import');
        imported = module({});
      } else {
        assert.equal(specifier, '@lody/components/lib/clear-local-cache');
        imported = module({
          async clearAllLodyLocalData() {
            events.push('wipe-start');
            await wipe?.();
            events.push('wipe-finished');
          },
        });
      }
      await imported.link(() => {});
      await imported.evaluate();
      return imported;
    },
  });
  await entry.link((specifier) => {
    if (specifier === '@capacitor/core') return capacitor;
    if (specifier === '@lody/components/lib/client-log')
      return module({
        installClientLog() {
          diagnosticsInstalled = true;
          return () => {};
        },
      });
    assert.equal(specifier, './polyfills');
    return new vm.SourceTextModule(polyfillSource, { context });
  });
  const done = entry.evaluate();
  return { events, done, failure: () => failure, appInfo: () => context.window.__LODY_APP_INFO__ };
}

void test('web, old shells and normal boot never wipe storage', async () => {
  for (const config of [{ native: false }, { available: false }, {}]) {
    const boot = await run(config);
    await boot.done;
    assert.deepEqual(
      boot.events,
      config.native === false || config.available === false
        ? ['main-import']
        : ['read-result', 'main-import']
    );
  }
});

void test('native success clears browsing-context storage before importing main', async () => {
  const boot = await run({ outcome: 'success' });
  await boot.done;
  assert.deepEqual(boot.events, ['read-result', 'session-clear', 'acknowledge', 'main-import']);
});

void test('native failure blocks app import until the shared web wipe finishes', async () => {
  let finishWipe;
  let started;
  const wiping = new Promise((resolve) => {
    started = resolve;
  });
  const barrier = new Promise((resolve) => {
    finishWipe = resolve;
  });
  const boot = await run({
    outcome: 'fallback',
    wipe() {
      started();
      return barrier;
    },
  });
  await wiping;
  assert.deepEqual(boot.events, ['read-result', 'session-clear', 'wipe-start']);
  finishWipe();
  await boot.done;
  assert.deepEqual(boot.events, [
    'read-result',
    'session-clear',
    'wipe-start',
    'wipe-finished',
    'acknowledge',
    'main-import',
  ]);
});

void test('failed result consumption or web wipe exposes boot recovery without importing main', async () => {
  const error = Error('recovery failed');
  for (const config of [
    { consumeError: error },
    {
      outcome: 'fallback',
      wipe() {
        throw error;
      },
    },
  ]) {
    const boot = await run(config);
    await boot.done;
    assert.equal(boot.failure(), error);
    assert.equal(boot.events.includes('main-import'), false);
    assert.equal(boot.events.includes('acknowledge'), false);
  }
});

void test('degraded credential recovery still wipes before boot and retains honest diagnostics', async () => {
  const boot = await run({ outcome: 'fallback', credentialCleanupFailed: true });
  await boot.done;
  assert.deepEqual(boot.events, [
    'read-result',
    'session-clear',
    'wipe-start',
    'wipe-finished',
    'acknowledge',
    'main-import',
  ]);
  assert.equal(boot.appInfo().last_native_reset_outcome, 'fallback');
  assert.equal(boot.appInfo().native_reset_credential_cleanup_failed, true);
});

void test('native outcome remains available if the web wipe fails', async () => {
  const error = Error('wipe failed');
  const boot = await run({
    outcome: 'fallback',
    wipe() {
      throw error;
    },
  });
  await boot.done;
  assert.equal(boot.failure(), error);
  assert.equal(boot.appInfo().last_native_reset_outcome, 'fallback');
  assert.equal(boot.appInfo().native_reset_credential_cleanup_failed, false);
  assert.equal(boot.events.includes('main-import'), false);
});

void test('a fallback whose native key cleanup failed still boots and reports it', async () => {
  const boot = await run({ outcome: 'fallback', acknowledged: { custodyCleanupFailed: true } });
  await boot.done;
  assert.ok(boot.events.includes('main-import'));
  assert.equal(boot.appInfo().native_reset_custody_cleanup_failed, true);
  const older = await run({ outcome: 'fallback' });
  await older.done;
  assert.equal(older.appInfo().native_reset_custody_cleanup_failed, false);
});
