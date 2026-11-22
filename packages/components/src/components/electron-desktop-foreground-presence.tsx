import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { usePlatformCapability } from '@lody/platform/react';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { electronSuppressMobilePushWhenFocusedAtom, userAtom } from '@/atoms';
import {
  createBrowserDesktopForegroundEnvironment,
  startDesktopForegroundPublisher,
} from '@/lib/desktop-foreground-presence';

/**
 * Publishes this Electron window's focused state into the active workspace's
 * presence room so Hosts can skip mobile pushes while the user is at a desktop.
 * Renders nothing; only the active workspace is covered.
 */
export function ElectronDesktopForegroundPresence() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const userId = typeof user?.id === 'string' ? user.id.trim() : '';
  const enabled = useAtomValue(electronSuppressMobilePushWhenFocusedAtom);
  const notificationsAvailable = usePlatformCapability('notifications');
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;

  useEffect(() => {
    if (!isElectron || !notificationsAvailable || !enabled || !runtime || !userId) {
      return undefined;
    }
    return startDesktopForegroundPublisher({
      userId,
      publish: (value) => runtime.publishDesktopForeground(value),
      env: createBrowserDesktopForegroundEnvironment(),
    });
  }, [isElectron, notificationsAvailable, enabled, runtime, userId]);

  return null;
}
