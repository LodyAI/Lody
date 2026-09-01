import { useEffect } from 'react';
import { usePostHog } from '@posthog/react';
import {
  captureShortcutUsage,
  commands,
  createShortcutUsagePayload,
  type GlobalShortcutTriggeredPayload,
} from '@/lib/commands';
import { onIpcEvent } from '@/lib/electron-ipc-client';
import { scheduleIdleTask } from '@/lib/idle-task';

export function ShortcutAnalyticsTracker() {
  const postHog = usePostHog();

  useEffect(() => {
    // Shortcut dispatch is synchronous inside the keydown task; PostHog's
    // `capture` resolves session/window ids and event properties, which is
    // enough work to show up in the switch-session key repeat. Nothing waits on
    // the event, so hand it to idle time.
    const pending = new Set<() => void>();
    commands.setShortcutAnalyticsHandler((payload) => {
      const cancel = scheduleIdleTask(() => {
        pending.delete(cancel);
        captureShortcutUsage(postHog, payload);
      });
      pending.add(cancel);
    });
    return () => {
      commands.setShortcutAnalyticsHandler(null);
      for (const cancel of pending) cancel();
      pending.clear();
    };
  }, [postHog]);

  useEffect(() => {
    if (typeof window === 'undefined' || window.__LODY_ELECTRON__ !== true) {
      return undefined;
    }

    return onIpcEvent('app.globalShortcut', (payload: GlobalShortcutTriggeredPayload) => {
      captureShortcutUsage(
        postHog,
        createShortcutUsagePayload({
          commandId: payload.id,
          binding: payload.binding,
          source: 'global_shortcut',
          isUserOverride: payload.binding !== payload.defaultBinding,
        })
      );
    });
  }, [postHog]);

  return null;
}
