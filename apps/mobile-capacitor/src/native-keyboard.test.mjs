import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(
  readFileSync(new URL('./native-keyboard.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

async function renderer(platform) {
  const style = new Map();
  const keyboardListeners = new Map();
  const window = new EventTarget();
  const document = {
    documentElement: {
      style: {
        getPropertyValue: (name) => style.get(name) ?? '',
        setProperty: (name, value) => style.set(name, value),
      },
    },
  };
  const events = [];
  window.addEventListener('lody:keyboard-resize', (event) => events.push(event.detail.height));
  const context = vm.createContext({ window, document, CustomEvent });
  const entry = new vm.SourceTextModule(source, { context });
  await entry.link((specifier) => {
    const exports =
      specifier === '@capacitor/core'
        ? { Capacitor: { getPlatform: () => platform } }
        : {
            Keyboard: {
              addListener: async (name, listener) => keyboardListeners.set(name, listener),
            },
          };
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { context }
    );
  });
  await entry.evaluate();
  return {
    context,
    document,
    events,
    start: () => entry.namespace.initNativeKeyboard(),
    height: () => document.documentElement.style.getPropertyValue('--native-keyboard-height'),
    show: (height) => keyboardListeners.get('keyboardWillShow')?.({ keyboardHeight: height }),
    hide: () => keyboardListeners.get('keyboardWillHide')?.(),
  };
}

void test('legacy iOS still offsets the composer and clears it when the keyboard closes', async () => {
  const app = await renderer('ios');
  app.start();
  assert.equal(app.height(), '0px');
  app.show(300);
  assert.equal(app.height(), '300px');
  app.hide();
  assert.equal(app.height(), '0px');
  assert.deepEqual(app.events, [300, 0]);
});

void test('Android leaves viewport resizing in charge and still notifies focused-field scrolling', async () => {
  const app = await renderer('android');
  app.start();
  app.show(300);
  assert.equal(app.height(), '0px');
  app.hide();
  assert.equal(app.height(), '0px');
  assert.deepEqual(app.events, [300, 0]);
});

void test(
  'native window geometry reaches CSS across resize, dismissal and document recovery',
  {
    skip: process.platform !== 'darwin' && 'Native Swift geometry checks require macOS',
  },
  async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'lody-viewport-test-'));
    try {
      const binary = join(temporary, 'viewport-tests');
      execFileSync('xcrun', [
        'swiftc',
        '-module-cache-path',
        join(temporary, 'modules'),
        fileURLToPath(new URL('../ios/App/App/LodyViewportLayout.swift', import.meta.url)),
        fileURLToPath(new URL('../tests/ViewportLayoutTests.swift', import.meta.url)),
        '-o',
        binary,
      ]);
      const scripts = JSON.parse(execFileSync(binary, { encoding: 'utf8' }));
      const app = await renderer('ios');
      vm.runInContext(scripts[1], app.context);
      app.start();
      assert.equal(app.height(), '300px', 'boot must preserve the native window offset');
      app.show(999);
      app.hide();
      assert.equal(app.height(), '300px', 'legacy plugin events cannot overwrite window geometry');
      vm.runInContext(scripts[1], app.context);
      assert.deepEqual(app.events, [300], 'unchanged layout does not notify again');
      vm.runInContext(scripts[2], app.context);
      assert.equal(app.height(), '50px');
      vm.runInContext(scripts[3], app.context);
      assert.equal(app.height(), '0px');
      assert.deepEqual(app.events, [300, 50, 0]);

      const recovered = await renderer('ios');
      vm.runInContext(scripts[0], recovered.context);
      vm.runInContext(scripts[1], recovered.context);
      recovered.start();
      assert.equal(recovered.height(), '300px');
      assert.deepEqual(recovered.events, [0, 300]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
);
