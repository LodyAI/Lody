import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(
  readFileSync(new URL('./push-notifications.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }
).outputText;
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(platform, { channel, configure, autoToken = true } = {}) {
  const events = [];
  const listeners = new Map();
  const timers = new Set();
  const context = vm.createContext({
    setTimeout: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimeout: (fn) => timers.delete(fn),
    window: {},
    console,
    localStorage: { getItem: () => 'installation' },
  });
  const exports = {
    '@capacitor/app': { App: { getInfo: async () => ({ id: 'app.test' }) } },
    '@capacitor/core': {
      Capacitor: { getPlatform: () => platform },
      registerPlugin: () => ({
        configurePushTokens: async (input) => {
          await configure?.(input);
          events.push(input.enabled ? 'activity-on' : 'activity-off');
        },
      }),
    },
    '@capacitor/push-notifications': {
      PushNotifications: {
        addListener: async (name, fn) => listeners.set(name, fn),
        createChannel: async () => {
          await channel?.();
        },
        register: async () => {
          events.push('register');
          if (autoToken) listeners.get('registration')({ value: 'token' });
        },
        unregister: async () => events.push('unregister'),
        removeAllDeliveredNotifications: async () => events.push('clear'),
      },
    },
  };
  const entry = new vm.SourceTextModule(source, { context });
  await entry.link(
    (name) =>
      new vm.SyntheticModule(
        Object.keys(exports[name]),
        function () {
          for (const [key, value] of Object.entries(exports[name])) this.setExport(key, value);
        },
        { context }
      )
  );
  await entry.evaluate();
  entry.namespace.initPushBridge();
  return { bridge: context.window.__LODY_PUSH__, events, listeners, timers };
}
await test('logout while Android channel creation is pending cannot register afterward', async () => {
  const entered = deferred();
  const release = deferred();
  const t = await setup('android', {
    channel: () => {
      entered.resolve();
      return release.promise;
    },
  });
  const registration = t.bridge.register(async () => {}).catch((error) => error);
  await entered.promise;
  const logout = t.bridge.unregister();
  release.resolve();
  await Promise.all([registration, logout]);
  assert.deepEqual(t.events, ['unregister', 'clear']);
});
await test('logout drains in-flight ActivityKit enable before disabling and clearing notifications', async () => {
  const entered = deferred();
  const release = deferred();
  const t = await setup('ios', {
    configure: async ({ enabled }) => {
      if (enabled) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const registration = t.bridge.register(async () => {});
  await entered.promise;
  const logout = t.bridge.unregister();
  release.resolve();
  await Promise.all([logout, registration]);
  assert.ok(t.events.indexOf('activity-on') < t.events.indexOf('activity-off'));
  assert.ok(t.events.includes('unregister'));
  assert.ok(t.events.includes('clear'));
  assert.equal(t.events.filter((event) => event.startsWith('activity-')).at(-1), 'activity-off');
});
await test('local logout never waits for an authenticated upload and late upload cannot enable ActivityKit', async () => {
  const entered = deferred();
  const release = deferred();
  const t = await setup('ios');
  const registration = t.bridge.register(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  await t.bridge.unregister();
  assert.ok(t.events.includes('activity-off'));
  release.resolve();
  await registration;
  assert.equal(t.events.includes('activity-on'), false);
});

await test('register reports upload failure rather than OS permission as success', async () => {
  const t = await setup('ios');
  await assert.rejects(
    t.bridge.register(async () => {
      throw new Error('backend unavailable');
    }),
    /backend unavailable/
  );
  assert.equal(t.events.includes('activity-on'), false);
});
await test('missing OS token has a bounded timeout and does not enable ActivityKit', async () => {
  const registered = deferred();
  const t = await setup('android', { autoToken: false, channel: () => registered.resolve() });
  const result = t.bridge.register(async () => {}).catch((error) => error);
  await registered.promise;
  for (const timer of t.timers) timer();
  assert.match((await result).message, /timed out/);
  assert.equal(t.timers.size, 0);
});

await test('encrypted Live Activity keeps session navigation while removing HTTP permission actions', async () => {
  const payloads = [];
  const configurations = [];
  const context = vm.createContext({ window: {} });
  const bridgeSource = ts.transpileModule(
    readFileSync(new URL('./live-activity.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }
  ).outputText;
  const entry = new vm.SourceTextModule(bridgeSource, { context });
  await entry.link(
    () =>
      new vm.SyntheticModule(
        ['registerPlugin'],
        function () {
          this.setExport('registerPlugin', () => ({
            syncConversationSummary: async (payload) => {
              payloads.push(payload);
              return { activityId: payload.activityId };
            },
            configurePermissionActions: async (config) => {
              configurations.push(config);
            },
          }));
        },
        { context }
      )
  );
  await entry.evaluate();
  entry.namespace.initLiveActivityBridge();
  const bridge = context.window.__LODY_LIVE_ACTIVITY__;
  const item = {
    id: 'session',
    title: 'Task',
    status: 'permission',
    permissionRequestId: 'request',
  };
  const input = {
    activityId: 'activity',
    workspaceId: 'workspace',
    contentMode: 'e2ee',
    items: [item],
    permissionAlert: { key: 'request' },
  };
  await bridge.configurePermissionActions({
    authToken: 'synthetic',
    convexSiteUrl: 'https://example.invalid',
    permissionActionsEnabled: false,
  });
  await bridge.syncConversationSummary(input);
  assert.equal(payloads[0].items[0].id, 'session');
  assert.equal(payloads[0].items[0].permissionRequestId, undefined);
  assert.equal(payloads[0].permissionAlert, undefined);
  assert.equal(item.permissionRequestId, 'request');
  assert.equal(configurations[0].permissionActionsEnabled, false);
  assert.equal(configurations[0].authToken, 'synthetic');
  await bridge.syncConversationSummary({ ...input, contentMode: 'plaintext' });
  assert.equal(payloads[1].items[0].permissionRequestId, 'request');
});
