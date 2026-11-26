import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'jotai';
import { docMetaSubscriptionAtom } from '@/atoms/doc-meta';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { useTranslation } from 'react-i18next';
import { buildSessionLink } from '@lody/shared/session-link';
import { revealTodayWindow } from '@/lib/desktop-window';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { WindowDragStrip } from '@/ui/window-drag-region';
import { WorkspaceCard } from '../workspace-frame';
import { getWebWorkspaceLayoutRootClassName } from '../workspace-layout-utils';
import { TodayView, type TodayViewTarget } from './today-view';
import { markTodayWindowBoot } from '@/lib/today/today-window-boot-timeline';

/**
 * The desktop's standalone Today window: only the day stream, in one page card on
 * the window ground. Its pin keeps the window above all others; conversations open
 * in the primary window. Behavior: specs/today-outline.md (Switch and entry).
 */
export function TodayWindow(props: { memberId?: string; anchorDate?: string; bindingId: number }) {
  const { t } = useTranslation();
  markTodayWindowBoot('view-chunk');
  const [target, setTarget] = useState<TodayViewTarget>({
    member: props.memberId,
    date: props.anchorDate,
  });
  const store = useStore();
  const [dayReady, setDayReady] = useState(false);
  const onDayReady = useCallback(() => {
    revealTodayWindow(props.bindingId);
    setDayReady(true);
  }, [props.bindingId]);
  useEffect(() => {
    if (!dayReady || !isLocalAppPlatform()) return undefined;
    let unsubscribe: (() => void) | undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        unsubscribe = store.sub(docMetaSubscriptionAtom, () => {});
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe?.();
    };
  }, [dayReady, store]);
  const [onTop, setOnTop] = useState(false);
  useEffect(() => {
    let current = true;
    void getIpcServices()
      ?.app.getTodayWindowAlwaysOnTop()
      .then((value) => {
        if (current) setOnTop(value);
      })
      .catch(console.error);
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    document.title = t('today.nav', 'Today');
  }, [t]);
  return (
    <TodayWindowFrame>
      <TodayView
        target={target}
        onNavigate={setTarget}
        standalone
        onDayReady={onDayReady}
        pinned={onTop}
        onTogglePin={() => {
          void getIpcServices()?.app.setTodayWindowAlwaysOnTop(!onTop).then(setOnTop).catch(console.error);
        }}
        onOpenSession={(link) => {
          void getIpcServices()?.app.openSessionInMainWindow(buildSessionLink(link)).catch(console.error);
        }}
      />
    </TodayWindowFrame>
  );
}

export function TodayWindowFrame({ children }: { children: ReactNode }) {
  return (
    <div className={getWebWorkspaceLayoutRootClassName({ settingsRoute: true, surface: 'sidebar' })}>
      <WindowDragStrip />
      <WorkspaceCard anchored={false}>{children}</WorkspaceCard>
    </div>
  );
}
