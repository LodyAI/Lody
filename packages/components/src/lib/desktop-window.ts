import { useAtomValue } from 'jotai';
import { windowPreparationAtom } from './window-preparation';
import { createContext, useEffect, useState } from 'react';
import { isElectronRenderer, isMacOSElectronRenderer } from './electron';
import { getIpcServices } from './electron-ipc-client';
import { jotaiStore } from './utils';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { deferredPostHog } from './deferred-posthog';
import { capturePostHogEvent } from './posthog-analytics';

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

const WARM_WINDOW_STORAGE_KEY = 'lody:warmWindow';

/**
 * Whether this window is the hidden spare kept warm for the next open. It boots
 * on a neutral route and must not redirect into a workspace until a target is
 * bound through the main-owned target preparation or claim protocol.
 */
export function isWarmWindow(): boolean {
  if (
    !isElectronRenderer() ||
    typeof location === 'undefined' ||
    typeof sessionStorage === 'undefined'
  )
    return false;
  if (/[?&]warm=1(?:&|$)/.test(location.href)) {
    sessionStorage.setItem(WARM_WINDOW_STORAGE_KEY, '1');
  }
  return sessionStorage.getItem(WARM_WINDOW_STORAGE_KEY) === '1';
}

/**
 * Clears the warm marker once the spare has been bound to a real target, so a
 * later in-window navigation back to `/` behaves like a normal window.
 */
export function clearWarmWindowFlag(): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(WARM_WINDOW_STORAGE_KEY);
}

/** Renderer entry point that asked for a standalone window (analytics enum). */
export type DesktopWindowOpenSource = 'context_menu' | 'session_menu' | 'modifier_click';

export function openDesktopWindow(
  sessionId: string | undefined,
  workspace: string | null | undefined,
  source: DesktopWindowOpenSource
): boolean {
  const target = workspace ?? jotaiStore.get(currentWorkspaceSlugAtom);
  const services = getIpcServices();
  if (!isElectronRenderer() || !services || !target) return false;
  void services.app.openWindow({ workspace: target, sessionId }).catch(console.error);
  // Called from lib code and memoized sidebar rows without a usePostHog()
  // client; deferredPostHog is the provider's client whenever telemetry is on.
  capturePostHogEvent(deferredPostHog, 'window/opened', {
    kind: sessionId ? 'session' : 'workspace',
    source,
  });
  return true;
}

export function isNewWindowClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isElectronRenderer() && (isMacOSElectronRenderer() ? event.metaKey : event.ctrlKey);
}

export function openSessionOnModifiedClick(
  event: { metaKey: boolean; ctrlKey: boolean; preventDefault(): void; stopPropagation(): void },
  sessionId: string
): boolean {
  if (!isNewWindowClick(event) || !openDesktopWindow(sessionId, undefined, 'modifier_click'))
    return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

// Web Locks release automatically on renderer exit. One owner per workspace,
// without timers, leader heartbeats, or an additional IPC protocol.

export const WorkspaceWindowOwnerContext = createContext(true);
export function useWorkspaceWindowOwner(workspace: string | null): boolean {
  const preparing = useAtomValue(windowPreparationAtom);
  const eligibleWorkspace = preparing ? null : workspace;
  const [ownedWorkspace, setOwnedWorkspace] = useState<string | null>(null);
  useEffect(() => {
    if (!isElectronRenderer() || !eligibleWorkspace) return undefined;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void navigator.locks
      .request(`lody:workspace-window:${eligibleWorkspace}`, { signal: controller.signal }, async () => {
        if (controller.signal.aborted) return;
        setOwnedWorkspace(eligibleWorkspace);
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
  }, [eligibleWorkspace]);
  return !preparing && (!isElectronRenderer() || (workspace !== null && ownedWorkspace === workspace));
}

/** A cancellation token only releases its own source-window request. */
export function prepareDesktopWindow(sessionId: string): () => void {
  const services = getIpcServices();
  const workspace = jotaiStore.get(currentWorkspaceSlugAtom);
  if (!isMacOSElectronRenderer() || !services || !workspace || jotaiStore.get(windowPreparationAtom))
    return () => {};
  const requestId = crypto.randomUUID();
  void services.app.prepareWindow({ workspace, sessionId }, requestId).catch(console.error);
  return () => { void services.app.cancelPreparedWindow(requestId).catch(console.error); };
}
