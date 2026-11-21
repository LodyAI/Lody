import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual inline entry, without React, Capacitor packages or a bundle.
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function element(tag = 'div') {
  return {
    tag,
    style: {},
    children: [],
    listeners: {},
    textContent: '',
    disabled: false,
    setAttribute() {},
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    },
    appendChild(child) {
      this.children.push(child);
    },
    set innerHTML(value) {
      this.children = [];
    },
  };
}

function boot({ native = true, plugin, storageThrows = false, confirmed = true } = {}) {
  const root = element();
  root.querySelector = () => root.children.find((child) => child.className === 'bf-actions');
  const timers = new Map();
  const context = {
    document: { getElementById: () => root, createElement: element, body: element() },
    navigator: {},
    localStorage: {
      getItem() {
        if (storageThrows) throw Error('WebKit unavailable');
        return 'install-before-reset';
      },
    },
    location: { reload() {} },
    Capacitor: { isNativePlatform: () => native, Plugins: { LodyNativeReset: plugin } },
    confirm: () => confirmed,
    addEventListener() {},
    setTimeout(fn, delay) {
      timers.set(delay, fn);
      return delay;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  return { context, root, timers };
}

function buttons(root) {
  return root.children.flatMap((child) => (child.tag === 'button' ? [child] : buttons(child)));
}

for (const config of [{ native: false, plugin: {} }, { native: true }]) {
  void test(`does not advertise reset on ${config.native ? 'an old shell' : 'web'}`, () => {
    const { context, root, timers } = boot(config);
    assert.equal(context.__LODY_NATIVE_RESET__, undefined);
    timers.get(12000)();
    assert.equal(
      buttons(root).some((b) => b.textContent === 'Reset app data'),
      false
    );
  });
}

void test('bridge preserves rejection for renderer fallback and passes only the diagnostic ID', async () => {
  const failure = Error('native failed');
  let options;
  const { context } = boot({
    plugin: {
      resetAllData(value) {
        options = value;
        return Promise.reject(failure);
      },
    },
  });
  assert.equal(context.__LODY_NATIVE_RESET__.version, 1);
  await assert.rejects(context.__LODY_NATIVE_RESET__.resetAllData(), (error) => error === failure);
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { installId: 'install-before-reset' });
});

void test('native reset remains usable when WebKit localStorage cannot open', async () => {
  let reset = false;
  const { context } = boot({
    storageThrows: true,
    plugin: {
      async resetAllData() {
        reset = true;
      },
    },
  });
  await context.__LODY_NATIVE_RESET__.resetAllData();
  assert.equal(reset, true);
});

void test('watchdog offers reset without the bundle, confirms and permits retry on rejection', async () => {
  let attempts = 0;
  const { context, root, timers } = boot({
    plugin: {
      async resetAllData() {
        attempts++;
        throw Error('failure');
      },
    },
  });
  timers.get(12000)();
  const reset = buttons(root).find((b) => b.textContent === 'Reset app data');
  assert.ok(reset);
  context.confirm = () => false;
  await reset.listeners.click();
  assert.equal(attempts, 0);
  context.confirm = () => true;
  const pending = reset.listeners.click();
  assert.equal(reset.disabled, true);
  await pending;
  assert.equal(reset.disabled, false);
  assert.equal(reset.textContent, 'Reset failed — try again');
  await reset.listeners.click();
  assert.equal(attempts, 2);
});

void test('styled boot renderer also receives the reset action; throwing renderer falls back', () => {
  for (const throws of [false, true]) {
    const { context, root } = boot({ plugin: { resetAllData() {} } });
    context.__LODY_BOOT__.render = () => {
      if (throws) throw Error('render failed');
      const row = element();
      row.className = 'bf-actions';
      root.appendChild(row);
    };
    context.__LODY_BOOT__.fail(Error('boot failed'));
    assert.equal(buttons(root).filter((b) => b.textContent === 'Reset app data').length, 1);
    if (!throws)
      assert.equal(
        root.querySelector('.bf-actions').children[0].className,
        'bf-button bf-secondary'
      );
  }
});

void test('pending native navigation keeps reset disabled and native diagnostic ID wins', async () => {
  let invoked;
  let options;
  const nativeInvoked = new Promise((resolve) => {
    invoked = resolve;
  });
  const { context, root, timers } = boot({
    plugin: {
      resetAllData(value) {
        options = value;
        invoked();
        return new Promise(() => {});
      },
    },
  });
  context.__LODY_APP_INFO__ = { install_id: 'native-install' };
  timers.get(12000)();
  const reset = buttons(root).find((b) => b.textContent === 'Reset app data');
  void reset.listeners.click();
  await nativeInvoked;
  assert.equal(options.installId, 'native-install');
  assert.equal(reset.disabled, true);
});

void test('pre-React failure beacon excludes an error name carrying private metadata', async () => {
  const { default: ts } = await import('typescript');
  const source = ts.transpileModule(
    readFileSync(new URL('./boot-failure-mobile.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText;
  const beacons = [];
  let visibleError;
  const context = vm.createContext({
    Error,
    Blob,
    navigator: {
      onLine: true,
      sendBeacon(_url, body) {
        beacons.push(body);
        return true;
      },
    },
    window: { __LODY_APP_INFO__: { install_id: 'synthetic-install' } },
  });
  const exports = {
    '@capacitor/device': { Device: {} },
    '@capacitor/core': { Capacitor: { getPlatform: () => 'ios' } },
    '@capacitor/app': { App: {} },
    '@lody/components/lib/boot-failure': {
      renderBootFailure(_root, error) {
        visibleError = error;
      },
    },
    '@lody/components/lib/native-app-info': { updateNativeAppInfo() {} },
  };
  const module = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta(meta) {
      meta.env = {
        MODE: 'test',
        VITE_PUBLIC_POSTHOG_KEY: 'synthetic-key',
        VITE_PUBLIC_POSTHOG_HOST: 'http://127.0.0.1',
      };
    },
  });
  await module.link((specifier) => {
    const values = exports[specifier];
    if (!values) throw new Error(`unexpected import ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context }
    );
  });
  await module.evaluate();
  const error = new Error('PRIVATE_DRAFT_CONTENT');
  error.name = 'PRIVATE_ATTACHMENT_NAME';
  error.stack = 'PRIVATE_REPO_PATH';
  module.namespace.showMobileBootFailure({}, error);
  assert.equal(beacons.length, 1);
  const wire = await beacons[0].text();
  assert.equal(wire.includes('PRIVATE_'), false);
  assert.equal(JSON.parse(wire).properties.error_type, 'Error');
  assert.equal(visibleError, error, 'local copyable diagnostics retain the original');
});
