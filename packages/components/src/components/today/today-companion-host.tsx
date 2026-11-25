import { useAtomValue, useStore } from 'jotai';
import { useEffect, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { OPEN_TODAY_COMPANION, type TodayDesktopTarget } from '@/lib/desktop-window';
import { WorkspaceRouteTargetProvider } from '../../providers/workspace-route-target';

type Companion = {
  name: string;
  window: Window;
  runtime: WorkspaceRuntime;
  target: TodayDesktopTarget;
  Surface: typeof import('./today-companion').TodayCompanion;
};

export function TodayCompanionHost() {
  const store = useStore();
  const [companion, setCompanion] = useState<Companion | null>(null);
  useEffect(() => {
    const app = getIpcServices()?.app;
    if (!app) return undefined;
    let active = true;
    let opening = false;
    let ownedWindow: Window | null = null;

    const open = (event: Event) => {
      const target = (event as CustomEvent<TodayDesktopTarget>).detail;
      const runtime = store.get(activeWorkspaceRuntimeAtom);
      if (!target || !store.get(todayFeatureEnabledAtom) || !runtime ||
          runtime.workspaceSlug !== target.workspace ||
          runtime.workspaceId !== store.get(currentWorkspaceIdAtom)) return;
      event.preventDefault();
      if (opening) return;
      opening = true;
      const stillBound = () =>
        active && runtime === store.get(activeWorkspaceRuntimeAtom) &&
        runtime.workspaceId === store.get(currentWorkspaceIdAtom) && store.get(todayFeatureEnabledAtom);
      void (async () => {
        const name = await app.prepareTodayCompanion(target);
        if (!name || !stillBound()) return;
        const { TodayCompanion: Surface } = await import('./today-companion');
        if (!stillBound()) return;
        const popup = window.open('about:blank', name);
        if (!popup) {
          await app.openTodayWindow(target);
          return;
        }
        ownedWindow = popup;
        popup.addEventListener('pagehide', () => {
          if (ownedWindow === popup) ownedWindow = null;
          if (active) flushSync(() => setCompanion((value) => value?.window === popup ? null : value));
        }, { once: true });
        setCompanion({ name, window: popup, runtime, target, Surface });
      })().catch(async (error: unknown) => {
        console.error(error);
        if (stillBound()) await app.openTodayWindow(target).catch(console.error);
      }).finally(() => { opening = false; });
    };

    const unmountBeforeHandoff = () => {
      if (ownedWindow) flushSync(() => setCompanion(null));
    };
    window.addEventListener(OPEN_TODAY_COMPANION, open);
    window.addEventListener('pagehide', unmountBeforeHandoff);
    return () => {
      active = false;
      window.removeEventListener(OPEN_TODAY_COMPANION, open);
      window.removeEventListener('pagehide', unmountBeforeHandoff);
      ownedWindow?.close();
    };
  }, [store]);

  if (!companion) return null;
  return <BoundTodayCompanion companion={companion} />;
}

function BoundTodayCompanion({ companion }: { companion: Companion }) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const enabled = useAtomValue(todayFeatureEnabledAtom);
  const valid = enabled && runtime === companion.runtime && workspaceId === runtime.workspaceId;

  useEffect(() => {
    if (!valid) companion.window.close();
  }, [companion, valid]);

  if (!valid || companion.window.closed) return null;
  return createPortal(
    <WorkspaceRouteTargetProvider slug={companion.runtime.workspaceSlug}>
      <companion.Surface name={companion.name} popup={companion.window} initialTarget={companion.target} />
    </WorkspaceRouteTargetProvider>,
    companion.window.document.body
  );
}
