import { isElectronRenderer } from './electron';
import { parseSessionLink } from '@lody/shared/session-link';
import { openSessionDeepLink } from './session-deep-link';
import { getIpcServices } from './electron-ipc-client';
import { isNativeAppShell } from './native-platform';

export async function openExternalUrl(url: string): Promise<boolean> {
  if (typeof window === 'undefined') {
    return false;
  }
  const sessionLink = parseSessionLink(url);
  if (sessionLink) {
    openSessionDeepLink(sessionLink);
    return true;
  }

  const isElectron = isElectronRenderer();
  if (isElectron && getIpcServices()) {
    try {
      const result = await getIpcServices()!.app.openExternalUrl(url);
      if (result.opened) {
        return true;
      }
      console.error('Failed to open URL with Electron shell', result.error ?? 'unknown error');
      return false;
    } catch (error) {
      console.error('Failed to open URL with Electron shell', error);
      return false;
    }
  }

  if (isNativeAppShell()) {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return true;
    } catch (error) {
      console.error('Failed to open URL with Capacitor Browser', error);
    }
  }

  const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
  if (openedWindow) {
    openedWindow.opener = null;
  }

  return openedWindow !== null || isElectron;
}
