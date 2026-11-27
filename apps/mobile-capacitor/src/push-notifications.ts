import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import type { NativePushBridge } from '@lody/components/lib/push-notifications';
import { getAuthUserId, subscribeAuthUserId } from './auth';

const activity = registerPlugin<{
  configurePushTokens(input: {
    installationId: string;
    enabled: boolean;
    language: string;
  }): Promise<void>;
}>('LodyLiveActivity');
let listeners: Promise<void> | undefined;
let token: string | undefined;
let notify: Parameters<NativePushBridge['register']>[0] | undefined;
let epoch = 0;
let tokenWaiter: { finish(error?: Error): void } | undefined;
function waitForToken() {
  if (token) return { promise: Promise.resolve(), finish: (_error?: Error) => {} };
  let waiter!: { finish(error?: Error): void };
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => waiter.finish(new Error('Native push registration timed out')),
      15_000
    );
    waiter = {
      finish(error) {
        clearTimeout(timer);
        if (tokenWaiter === waiter) tokenWaiter = undefined;
        if (error) reject(error);
        else resolve();
      },
    };
    tokenWaiter = waiter;
  });
  // Native commands can still be pending when cancellation/timeout rejects.
  void promise.catch(() => {});
  return { promise, finish: waiter.finish };
}
// Serialize only local native commands, never authenticated network uploads.
let commands: Promise<unknown> = Promise.resolve();
function nativeCommand(task: () => Promise<void>) {
  const result = commands.catch(() => {}).then(task);
  commands = result;
  return result;
}
async function report() {
  const current = epoch;
  if (!token || !notify) return;
  const bundleId = Capacitor.getPlatform() === 'ios' ? (await App.getInfo()).id : undefined;
  if (current !== epoch || !notify || !token) return;
  await notify({
    ...(bundleId ? { bundleId } : {}),
    platform: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android',
    purpose: 'notification',
    token,
  });
  if (Capacitor.getPlatform() === 'ios')
    await nativeCommand(async () => {
      if (current !== epoch) return;
      await activity.configurePushTokens({
        installationId: localStorage.getItem('lody:push-installation')!,
        enabled: true,
        language: localStorage.getItem('lody-language') ?? 'en',
      });
    }).catch(() => console.error('Activity push configuration failed'));
}
/** A same-origin in-app path; anything else never navigates. */
type SafeAppRoute = string & { readonly safeAppRoute: unique symbol };
type PushTap = { readonly route: SafeAppRoute; readonly recipient: string };
/** `logging-out`: `unregister()` ran for logout but the old session may still read briefly. */
type PushTapGate =
  | { readonly phase: 'signed-out' }
  | { readonly phase: 'signed-in'; readonly user: string }
  | { readonly phase: 'logging-out'; readonly user: string };

function pushTap(data: unknown): PushTap | null {
  const { route, recipientUserId } = (typeof data === 'object' && data !== null ? data : {}) as {
    route?: unknown;
    recipientUserId?: unknown;
  };
  if (typeof recipientUserId !== 'string' || !recipientUserId) return null;
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) return null;
  if (new URL(route, window.location.origin).origin !== window.location.origin) return null;
  return { route: route as SafeAppRoute, recipient: recipientUserId };
}

let gate: PushTapGate = { phase: 'signed-out' };
let parked: PushTap | undefined;
let tapsInstalled = false;
const signedIn = (user: string | null): PushTapGate =>
  user ? { phase: 'signed-in', user } : { phase: 'signed-out' };

/** Opens the newest tap for the signed-in recipient. Workspace admission stays the route's
 * own check, so a startup workspace that never registers push cannot strand the tap. */
function openParked() {
  if (gate.phase === 'logging-out' && localStorage.getItem('lody:push-user') === gate.user)
    gate = signedIn(gate.user);
  const tap = parked;
  if (!tap || gate.phase === 'signed-out') return;
  if (gate.phase === 'logging-out') {
    // The leaving account's taps never open; another account's wait for its own sign-in.
    if (tap.recipient === gate.user) parked = undefined;
    return;
  }
  parked = undefined;
  if (tap.recipient !== gate.user) return;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === tap.route)
    return;
  window.history.pushState(null, '', tap.route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function installPushTaps() {
  if (tapsInstalled) return;
  tapsInstalled = true;
  gate = signedIn(getAuthUserId());
  subscribeAuthUserId((user) => {
    if (gate.phase !== 'logging-out' || gate.user !== user) gate = signedIn(user);
    openParked();
  });
  void PushNotifications.addListener('pushNotificationActionPerformed', (event) => {
    const tap = pushTap(event.notification.data);
    if (!tap) return;
    parked = tap;
    openParked();
  }).catch(() => console.error('Push notification tap listener failed'));
}

export function initPushBridge() {
  installPushTaps();
  window.__LODY_PUSH__ = {
    async permission() {
      const { receive } = await PushNotifications.checkPermissions();
      return receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'default';
    },
    async requestPermission() {
      return (await PushNotifications.requestPermissions()).receive === 'granted';
    },
    async register(listener) {
      tokenWaiter?.finish(new Error('Native push registration replaced'));
      if (gate.phase === 'logging-out') gate = signedIn(getAuthUserId());
      notify = listener;
      const current = ++epoch;
      listeners ??= (async () => {
        await PushNotifications.addListener('registration', (value) => {
          token = value.value;
          if (tokenWaiter) tokenWaiter.finish();
          else void report().catch(() => console.error('Push token upload failed'));
        });
        await PushNotifications.addListener('registrationError', () => {
          tokenWaiter?.finish(new Error('Native push registration failed'));
        });
      })();
      await listeners;
      if (current !== epoch) return;
      const ready = waitForToken();
      try {
        await nativeCommand(async () => {
          if (current !== epoch) return;
          if (Capacitor.getPlatform() === 'android')
            await PushNotifications.createChannel({
              id: 'lody',
              name: 'Lody',
              importance: 4,
              visibility: 0,
            });
          if (current !== epoch) return;
          await PushNotifications.register();
        });
        await ready.promise;
        if (current !== epoch) return;
        await report();
      } finally {
        ready.finish();
      }
    },
    async unregister() {
      ++epoch;
      tokenWaiter?.finish(new Error('Native push registration cancelled'));
      notify = undefined;
      token = undefined;
      // Logout clears the push user first; a Settings opt-out keeps it and fences nothing.
      if (!localStorage.getItem('lody:push-user')) {
        if (gate.phase === 'signed-in') gate = { phase: 'logging-out', user: gate.user };
        if (gate.phase === 'signed-out' || parked?.recipient === gate.user) parked = undefined;
      }
      await nativeCommand(async () => {
        await Promise.allSettled([
          ...(Capacitor.getPlatform() === 'ios'
            ? [activity.configurePushTokens({ installationId: '', enabled: false, language: 'en' })]
            : []),
          PushNotifications.unregister(),
          PushNotifications.removeAllDeliveredNotifications(),
        ]);
      });
    },
  };
}
