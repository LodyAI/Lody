import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import * as sessionLinks from '../packages/shared/src/session-link.ts';
import { getDesktopCallbackProtocol } from '../apps/electron/src/main/desktop-channel.ts';
import { withDesktopResourceProtocols } from '../apps/electron/scripts/desktop-protocols.mjs';

const require = createRequire(import.meta.url);
function loadMain(file, overrides, processContext) {
  const source = readFileSync(
    new URL(`../apps/electron/src/main/${file}.ts`, import.meta.url),
    'utf8'
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (name) => overrides[name] ?? require(name),
    process: processContext,
    URL,
    URLSearchParams,
  });
  return exports;
}

test('common legacy routes reach Stable without loops while chat/new stays in the default app', () => {
  for (const protocol of ['lody-oss', 'ai.lody.nightly']) {
    const receiver = loadMain('deep-link-url', {
      './platform': { desktopInstallationProfile: { desktopProtocol: protocol } },
      './desktop-channel': { getDesktopCallbackProtocol },
      '@lody/shared/session-link': sessionLinks,
    });
    const stable = loadMain('deep-link-url', {
      './platform': { desktopInstallationProfile: { desktopProtocol: 'lody' } },
      './desktop-channel': { getDesktopCallbackProtocol },
      '@lody/shared/session-link': sessionLinks,
    });
    for (const route of [
      'invite/open?code=synthetic',
      'github-install?installationId=1',
      'checkout-return',
      'machine/connect?requestId=synthetic',
      'auth/callback#token=synthetic',
    ]) {
      const raw = `lody://${route}`;
      const forwarded = receiver.resolveDesktopDeepLink(receiver.parseDeepLinkArg(raw));
      assert.equal(forwarded.kind, 'forward');
      assert.equal(forwarded.url, `ai.lody.stable://${route}`);
      const consumed = stable.resolveDesktopDeepLink(stable.parseDeepLinkArg(forwarded.url));
      assert.equal(consumed.kind, 'local');
      assert.equal(consumed.url, route.startsWith('auth/') ? forwarded.url : raw);
    }
    const chat = 'lody://chat/new?machine=m&project=p';
    assert.equal(receiver.resolveDesktopDeepLink(chat).url, chat);
    assert.equal(receiver.resolveDesktopDeepLink(chat).kind, 'local');
    assert.equal(receiver.resolveDesktopDeepLink('lody://unknown/action').kind, 'unsupported');
  }
});

test('native handoff opens only the private alias and reports unavailable handlers without leaking tokens', async () => {
  for (const outcome of ['opened', 'missing', 'rejected']) {
    const opened = [];
    const errors = [];
    const jobs = [];
    const profile = { desktopProtocol: 'lody-oss' };
    const routes = loadMain('deep-link-url', {
      './platform': { desktopInstallationProfile: profile },
      './desktop-channel': { getDesktopCallbackProtocol },
      '@lody/shared/session-link': sessionLinks,
    });
    const receiver = loadMain('deep-link', {
      './platform': { desktopInstallationProfile: profile },
      './desktop-channel': { getDesktopCallbackProtocol },
      './deep-link-url': routes,
      electron: {
        app: {
          whenReady: () => ({
            then: (run) => {
              const job = Promise.resolve().then(run);
              jobs.push(job);
              return job;
            },
          }),
          getApplicationNameForProtocol: () => (outcome === 'missing' ? '' : 'Stable'),
        },
        shell: {
          openExternal: async (url) => {
            if (outcome === 'rejected') throw new Error('synthetic');
            opened.push(url);
          },
        },
        dialog: {
          showMessageBox: async (message) => {
            errors.push(message);
          },
        },
      },
      './window-state': {
        setPendingDeepLink: () => assert.fail('must not dispatch cloud routes locally'),
      },
      './services/desktop-login': {
        readDesktopLoginCallback: () => assert.fail('must not exchange credentials locally'),
      },
      './window': {},
      './auth-debug': { logAuthDebug: () => {}, describeDeepLinkForAuthDebug: () => ({}) },
    });
    receiver.handleDeepLink('lody://auth/callback#token=synthetic-secret');
    await Promise.all(jobs);
    assert.deepEqual(
      opened,
      outcome === 'opened' ? ['ai.lody.stable://auth/callback#token=synthetic-secret'] : []
    );
    assert.equal(errors.length, outcome === 'opened' ? 0 : 1);
    assert.equal(JSON.stringify(errors).includes('synthetic-secret'), false);
  }
});

test('Windows first launch registers an unhandled scheme and preserves any existing default', async () => {
  for (const existing of [undefined, 'Stable.exe', 'Nightly.exe', 'Unrelated.exe']) {
    const handlers = new Map(existing ? [['lody', existing]] : []);
    const ready = Promise.resolve();
    const app = {
      isPackaged: true,
      getAppPath: () => '/synthetic/app',
      whenReady: () => ready,
      getApplicationNameForProtocol: (uri) =>
        handlers.get(new URL(uri).protocol.slice(0, -1)) ?? '',
      setAsDefaultProtocolClient: (scheme) => {
        handlers.set(scheme, 'Current.exe');
        return true;
      },
    };
    const receiver = loadMain(
      'protocol-client',
      { electron: { app }, '@lody/shared/session-link': sessionLinks },
      {
        platform: 'win32',
        execPath: '/synthetic/app.exe',
        argv: [],
        env: {},
      }
    );
    receiver.registerLodyProtocolClient({ protocol: 'ai.lody.stable', log: () => {} });
    await ready;
    assert.equal(handlers.get('lody'), existing ?? 'Current.exe');
    assert.equal(handlers.get('ai.lody.stable'), 'Current.exe');
  }
});

for (const protocol of ['lody', 'lody-oss', 'ai.lody.nightly']) {
  test(`${protocol} accepts common launch resources but not another installation's callbacks`, () => {
    const receiver = loadMain('deep-link-url', {
      './platform': { desktopInstallationProfile: { desktopProtocol: protocol } },
      './desktop-channel': { getDesktopCallbackProtocol },
      '@lody/shared/session-link': sessionLinks,
    });
    const link = 'lody://session/Synthetic_A?workspace=workspace_1';
    const quote = String.fromCharCode(34);
    assert.equal(receiver.extractDeepLinkFromArgv(['app', quote + link + quote]), link);
    assert.equal(receiver.parseDeepLinkArg('session://Synthetic_A'), null);
    const callback = `${getDesktopCallbackProtocol({ desktopProtocol: protocol })}://auth/callback#token=synthetic`;
    assert.equal(receiver.parseDeepLinkArg(callback), callback);
    const legacy = 'lody://auth/callback#token=synthetic';
    assert.equal(receiver.parseDeepLinkArg(legacy), legacy);
    assert.equal(
      receiver.resolveDesktopDeepLink(legacy).kind,
      protocol === 'lody' ? 'local' : 'forward'
    );
  });

  test(`${protocol} packaging advertises resources and its own callback only`, () => {
    const config = withDesktopResourceProtocols([{ name: 'Synthetic', schemes: [protocol] }]);
    const schemes = new Set(config.flatMap((entry) => entry.schemes));
    assert.deepEqual(
      schemes,
      new Set(['lody', protocol, getDesktopCallbackProtocol({ desktopProtocol: protocol })])
    );
    assert.deepEqual(withDesktopResourceProtocols(config), config);
  });
}

test('AppImage launch preserves the common default, while explicit selection changes it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lody-link-registration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const iconPath = join(directory, 'synthetic-icon.png');
  writeFileSync(iconPath, 'synthetic');
  const handlers = new Map([['lody', 'previous.desktop']]);
  const app = {
    isPackaged: true,
    getAppPath: () => directory,
    setAsDefaultProtocolClient: (scheme) => {
      handlers.set(scheme, 'synthetic.desktop');
      return true;
    },
    isDefaultProtocolClient: (scheme) => handlers.get(scheme) === 'synthetic.desktop',
  };
  const receiver = loadMain(
    'protocol-client',
    {
      electron: { app },
      '@lody/shared/session-link': sessionLinks,
      'node:child_process': {
        spawn: (command, args) => {
          if (command === 'xdg-mime') handlers.set(args[2].split('/')[1], args[1]);
          const child = new EventEmitter();
          child.stderr = null;
          queueMicrotask(() => child.emit('close', 0, null));
          return child;
        },
      },
    },
    {
      platform: 'linux',
      execPath: '/synthetic/electron',
      argv: [],
      env: { XDG_DATA_HOME: directory, APPIMAGE: '/synthetic/Lody.AppImage' },
    }
  );
  receiver.registerLodyProtocolClient({
    protocol: 'lody-oss',
    productName: 'Synthetic',
    desktopFileName: 'synthetic.desktop',
    iconPath,
    log: () => {},
  });
  assert.equal(handlers.get('lody'), 'previous.desktop');
  assert.equal(handlers.get('lody-oss'), 'synthetic.desktop');
  const desktop = readFileSync(join(directory, 'applications/synthetic.desktop'), 'utf8');
  assert.match(desktop, /MimeType=x-scheme-handler\/lody-oss;x-scheme-handler\/lody;/);
  assert.equal(receiver.isDefaultLodyProtocolClient(), false);
  receiver.setDefaultLodyProtocolClient();
  assert.equal(receiver.isDefaultLodyProtocolClient(), true);
  assert.equal(handlers.get('lody-oss'), 'synthetic.desktop');
});
