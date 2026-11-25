import { createContext, useContext, useSyncExternalStore } from 'react';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';

export const isElectronRenderer = (): boolean => {
  return typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
};

export const isMacOSElectronRenderer = (): boolean => {
  return isElectronRenderer() && window.__LODY_PLATFORM__?.os === 'darwin';
};

export const isWindowsElectronRenderer = (): boolean => {
  return isElectronRenderer() && window.__LODY_PLATFORM__?.os === 'win32';
};

// Native fullscreen state of the Electron window. The main process pushes
// `app.fullscreen` on enter/leave; the renderer uses it to
// collapse the macOS traffic-light insets while the lights are auto-hidden.
let fullscreenSnapshot = false;
let fullscreenBridgeStarted = false;
const fullscreenListeners = new Set<() => void>();

const setFullscreenSnapshot = (value: boolean): void => {
  if (fullscreenSnapshot === value) return;
  fullscreenSnapshot = value;
  for (const listener of fullscreenListeners) {
    listener();
  }
};

const ensureFullscreenBridge = (): void => {
  if (fullscreenBridgeStarted) return;
  fullscreenBridgeStarted = true;
  if (!isElectronRenderer()) return;
  onIpcEvent('app.fullscreen', setFullscreenSnapshot);
  void getIpcServices()
    ?.app.getFullscreen()
    .then(setFullscreenSnapshot)
    .catch(() => undefined);
};

const subscribeFullscreen = (listener: () => void): (() => void) => {
  fullscreenListeners.add(listener);
  ensureFullscreenBridge();
  return () => {
    fullscreenListeners.delete(listener);
  };
};

export const ElectronFullscreenContext = createContext<boolean | null>(null);

/** Reactive native-fullscreen state of the Electron window; always `false` outside Electron. */
export const useElectronFullscreen = (): boolean => {
  const companionFullscreen = useContext(ElectronFullscreenContext);
  const sourceFullscreen = useSyncExternalStore(
    subscribeFullscreen,
    () => fullscreenSnapshot,
    () => false
  );
  return companionFullscreen ?? sourceFullscreen;
};
