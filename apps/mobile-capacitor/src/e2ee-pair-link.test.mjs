import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const transpile = (url) =>
  ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
const source = transpile(new URL('./e2ee-pair-link.ts', import.meta.url));
const parser = transpile(
  new URL('../../../packages/shared/src/e2ee-pair-link.ts', import.meta.url)
);

const firstAutoPairUrl = 'lody://auto-pair?id=automatic-0&code=secret-code-0';
const secondAutoPairUrl = 'lody://auto-pair?id=automatic-1&code=secret-code-1';

/** A native shell whose launch URL and URL-open events the test controls. */
async function boot({ launchUrl = null, launchFails = false } = {}) {
  let release;
  const launch = new Promise((resolve) => (release = resolve));
  const listeners = [];
  const events = [];
  const logged = [];
  const record =
    (level) =>
    (...args) =>
      logged.push([level, ...args]);
  const window = {
    dispatchEvent: (event) => {
      events.push({
        type: event.type,
        url: event.detail?.url,
        pending: window.__LODY_PENDING_E2EE_PAIR_URL__,
      });
      return true;
    },
  };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  const console = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug', 'trace'].map((level) => [level, record(level)])
  );
  const context = vm.createContext({ window, CustomEvent, URL, console });
  const exports = {
    '@capacitor/app': {
      App: {
        getLaunchUrl: () =>
          launch.then(() => {
            if (launchFails) throw new Error(`native failure for ${launchUrl}`);
            return launchUrl ? { url: launchUrl } : undefined;
          }),
        addListener: async (name, fn) => {
          listeners.push({ name, fn });
          return {
            remove: async () =>
              listeners.splice(
                listeners.findIndex((l) => l.fn === fn),
                1
              ),
          };
        },
      },
    },
  };
  const entry = new vm.SourceTextModule(source, { context });
  const shared = new vm.SourceTextModule(parser, { context });
  await entry.link((name) =>
    name === '@lody/shared/e2ee-pair-link'
      ? shared
      : new vm.SyntheticModule(
          Object.keys(exports[name]),
          function () {
            for (const [key, value] of Object.entries(exports[name])) this.setExport(key, value);
          },
          { context }
        )
  );
  await entry.evaluate();
  const stop = entry.namespace.initE2eePairLinks();
  const settle = async () => {
    release();
    await launch.catch(() => {});
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };
  const open = (url) => {
    for (const listener of listeners.filter((l) => l.name === 'appUrlOpen')) listener.fn({ url });
  };
  return { window, events, logged, settle, open, stop, listeners };
}

await test('a pairing link that cold-launches the app is handed to the pairing screen', async () => {
  const t = await boot({ launchUrl: firstAutoPairUrl });
  await t.settle();
  assert.equal(t.window.__LODY_PENDING_E2EE_PAIR_URL__, firstAutoPairUrl);
  assert.deepEqual(t.events, [
    { type: 'lody:e2ee-pair-url', url: firstAutoPairUrl, pending: firstAutoPairUrl },
  ]);
});

await test('a pairing link opened while the app runs is stored before the screen is told', async () => {
  const t = await boot();
  await t.settle();
  t.open(secondAutoPairUrl);
  assert.deepEqual(t.events, [
    { type: 'lody:e2ee-pair-url', url: secondAutoPairUrl, pending: secondAutoPairUrl },
  ]);
});

await test('a later warm link is not replaced by the slower cold-launch answer', async () => {
  const t = await boot({ launchUrl: firstAutoPairUrl });
  t.open(secondAutoPairUrl);
  await t.settle();
  assert.equal(t.window.__LODY_PENDING_E2EE_PAIR_URL__, secondAutoPairUrl);
  assert.deepEqual(
    t.events.map((event) => event.url),
    [secondAutoPairUrl]
  );
});

await test('only lody auto-pair approval links reach the pairing screen', async () => {
  const t = await boot();
  await t.settle();
  for (const url of [
    'lody://auth/callback?code=oauth-secret',
    'lody://pair/ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345',
    'lody://pair/',
    'lody://auto-pair',
    'https://lody.ai/auto-pair?id=a&code=b',
    'lodyx://auto-pair?id=a&code=b',
    'not a url',
  ])
    t.open(url);
  assert.deepEqual(t.events, []);
  assert.equal(t.window.__LODY_PENDING_E2EE_PAIR_URL__, undefined);
  t.open('Lody://Auto-Pair?id=a&code=b');
  assert.deepEqual(
    t.events.map((event) => event.url),
    ['Lody://Auto-Pair?id=a&code=b']
  );
});

await test('an oversized pairing link is ignored', async () => {
  const t = await boot();
  await t.settle();
  const prefix = 'lody://auto-pair?id=';
  t.open(`${prefix}${'A'.repeat(512)}`);
  assert.deepEqual(t.events, []);
  const longest = `${prefix}${'A'.repeat(512 - prefix.length)}`;
  t.open(longest);
  assert.deepEqual(
    t.events.map((event) => event.url),
    [longest]
  );
});

await test('pairing codes are never written to the console, even when the native lookup fails', async () => {
  const failing = await boot({ launchUrl: firstAutoPairUrl, launchFails: true });
  await failing.settle();
  failing.open(secondAutoPairUrl);
  failing.open('lody://auth/callback?code=oauth-secret');
  failing.open(`lody://auto-pair?id=${'A'.repeat(600)}`);
  assert.deepEqual(failing.logged, []);
});

await test('stopping the bridge removes its URL listener', async () => {
  const t = await boot();
  await t.settle();
  await t.stop();
  assert.equal(t.listeners.length, 0);
  t.open(firstAutoPairUrl);
  assert.deepEqual(t.events, []);
});
