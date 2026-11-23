import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSessionLink } from '@lody/shared/session-link';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { WindowDragStrip } from '@/ui/window-drag-region';
import { WorkspaceCard } from '../workspace-frame';
import { getWebWorkspaceLayoutRootClassName } from '../workspace-layout-utils';
import { TodayView, type TodayViewTarget } from './today-view';

/**
 * The desktop's standalone Today window: only the day stream, in one page card on
 * the window ground. Its pin keeps the window above all others; conversations open
 * in the primary window. Behavior: specs/today-outline.md (Switch and entry).
 */
export function TodayWindow(props: { memberId?: string; anchorDate?: string }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<TodayViewTarget>({
    member: props.memberId,
    date: props.anchorDate,
  });
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
    <div
      className={getWebWorkspaceLayoutRootClassName({ settingsRoute: true, surface: 'sidebar' })}
    >
      <WindowDragStrip />
      <WorkspaceCard anchored={false}>
        <TodayView
          target={target}
          onNavigate={setTarget}
          standalone
          pinned={onTop}
          onTogglePin={() => {
            void getIpcServices()
              ?.app.setTodayWindowAlwaysOnTop(!onTop)
              .then(setOnTop)
              .catch(console.error);
          }}
          onOpenSession={(link) => {
            void getIpcServices()
              ?.app.openSessionInMainWindow(buildSessionLink(link))
              .catch(console.error);
          }}
        />
      </WorkspaceCard>
    </div>
  );
}
