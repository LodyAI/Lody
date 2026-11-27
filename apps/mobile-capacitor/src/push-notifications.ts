import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import type { NativePushBridge } from '@lody/components/lib/push-notifications';

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
let tapped: { route: string; recipient: unknown } | undefined;
function openTapped() {
  const tap = tapped;
  if (!tap || !notify) return;
  tapped = undefined;
  if (tap.recipient !== localStorage.getItem('lody:push-user')) return;
  window.history.pushState(null, '', tap.route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export function initPushBridge() {
  void PushNotifications.addListener('pushNotificationActionPerformed', (event) => {
    const route = event.notification.data?.route;
    if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) return;
    if (new URL(route, window.location.origin).origin !== window.location.origin) return;
    tapped = { route, recipient: event.notification.data?.recipientUserId };
    openTapped();
  }).catch(() => console.error('Push notification tap listener failed'));
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
      openTapped();
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
      tapped = undefined;
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
