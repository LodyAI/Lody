import { createContext, useEffect, useState } from 'react';
import { isElectronRenderer, isMacOSElectronRenderer } from './electron';
import { getIpcServices } from './electron-ipc-client';
import { jotaiStore } from './utils';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';

export function isAuxiliaryWindow(): boolean {
  if (
    !isElectronRenderer() ||
    typeof location === 'undefined' ||
    typeof sessionStorage === 'undefined'
  )
    return false;
  if (/[?&]window=(session|workspace)(?:&|$)/.test(location.href)) {
    sessionStorage.setItem('lody:auxiliaryWindow', '1');
  }
  return sessionStorage.getItem('lody:auxiliaryWindow') === '1';
}

// Preserve the primary window's existing drafts and navigation. Auxiliary
// windows start empty and keep their own view state across reloads.
export const windowStorage = (): Storage =>
  isAuxiliaryWindow() ? globalThis.sessionStorage : globalThis.localStorage;

export function desktopWindowId(): string {
  if (!isAuxiliaryWindow()) return '';
  const id = sessionStorage.getItem('lody:windowId') ?? crypto.randomUUID();
  sessionStorage.setItem('lody:windowId', id);
  return id;
}

export function isSessionWindow(): boolean {
  if (!isElectronRenderer()) return false;
  const storage = windowStorage();
  if (/[?&]window=session(?:&|$)/.test(location.href)) {
    storage.setItem('lody:sessionWindow', '1');
  }
  return storage.getItem('lody:sessionWindow') === '1';
}

export function openDesktopWindow(
  sessionId?: string,
  workspace = jotaiStore.get(currentWorkspaceSlugAtom)
): boolean {
  const services = getIpcServices();
  if (!isElectronRenderer() || !services || !workspace) return false;
  void services.app.openWindow({ workspace, sessionId }).catch(console.error);
  return true;
}

export function isNewWindowClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isElectronRenderer() && (isMacOSElectronRenderer() ? event.metaKey : event.ctrlKey);
}

export function openSessionOnModifiedClick(
  event: { metaKey: boolean; ctrlKey: boolean; preventDefault(): void; stopPropagation(): void },
  sessionId: string
): boolean {
  if (!isNewWindowClick(event) || !openDesktopWindow(sessionId)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

// Web Locks release automatically on renderer exit. One owner per workspace,
// without timers, leader heartbeats, or an additional IPC protocol.

export const WorkspaceWindowOwnerContext = createContext(true);
export function useWorkspaceWindowOwner(workspace: string | null): boolean {
  const [ownedWorkspace, setOwnedWorkspace] = useState<string | null>(null);
  useEffect(() => {
    if (!isElectronRenderer() || !workspace) return undefined;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void navigator.locks
      .request(`lody:workspace-window:${workspace}`, { signal: controller.signal }, async () => {
        if (controller.signal.aborted) return;
        setOwnedWorkspace(workspace);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error(error);
      });
    return () => {
      controller.abort();
      release?.();
      setOwnedWorkspace(null);
    };
  }, [workspace]);
  return !isElectronRenderer() || (workspace !== null && ownedWorkspace === workspace);
}
