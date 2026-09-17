/**
 * Process-level restart and quit for the desktop shell.
 *
 * A page reload is not the same thing and cannot replace this: Chromium keeps a
 * dying IndexedDB backing store bound to the renderer process, so a storage
 * crisis (`lib/storage-crisis.ts`) survives `location.reload()` and only clears
 * when the process itself is gone. Recovery from one therefore has to relaunch,
 * not reload.
 */

import { getIpcServices } from './electron-ipc-client';

export function isDesktopAppShell(): boolean {
  return typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
}

/**
 * Quit and start Lody again in a fresh process.
 *
 * @returns `false` when the desktop bridge is absent or fails. The caller must
 *   explain how to quit and reopen the host process manually, never reload.
 */
export async function restartApp(): Promise<boolean> {
  const services = isDesktopAppShell() ? getIpcServices() : null;
  if (!services) return false;
  try {
    await services.app.restartApp();
    return true;
  } catch (error) {
    console.error('[Lody] restartApp bridge threw', error);
    return false;
  }
}

/** Quit Lody without relaunching. */
export async function quitApp(): Promise<boolean> {
  const services = isDesktopAppShell() ? getIpcServices() : null;
  if (!services) return false;
  try {
    await services.app.quitApp();
    return true;
  } catch (error) {
    console.error('[Lody] quitApp bridge threw', error);
    return false;
  }
}
