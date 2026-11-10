import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ElectronCliState } from '@lody/shared';
import { useElectronCliDaemon } from '@/hooks/use-electron-cli-daemon';

/** How long this machine has been cut off and how long it may keep working, from the
 * local runtime's outage window (specs/e2ee/execution-freshness-outage.md). Display
 * only: the machine decides every request itself. */
export interface E2eeOfflineWindow {
  /** When this machine last reached the backend, when it says so. */
  offlineSinceMs?: number;
  executionUntilMs: number;
}

export function e2eeOfflineWindow(
  state: ElectronCliState | null,
  workspaceId: string | null | undefined
): E2eeOfflineWindow | null {
  const window = workspaceId ? state?.runtime?.e2eeAccessWindows?.[workspaceId] : undefined;
  if (!window) return null;
  const since = state?.runtime?.connectionAges?.backendNotConnectedSinceMs;
  return {
    executionUntilMs: window.executionUntilMs,
    ...(since === undefined ? {} : { offlineSinceMs: since }),
  };
}

/** Minutes are enough here; the window is hours long. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const duration = (t: TFunction, ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? t('e2ee.offline.minutes', { count: minutes })
    : t('e2ee.offline.hoursMinutes', { hours, minutes: minutes % 60 });
};

/** One sentence for the workspace's Offline mark: how long the server has been out of
 * reach, then how long this machine can keep working or that it has paused. */
export function E2eeOfflineSummaryText(props: { window: E2eeOfflineWindow | null; now: number }) {
  const { t } = useTranslation();
  const { window, now } = props;
  const since =
    window?.offlineSinceMs !== undefined
      ? t('e2ee.offline.since', { duration: duration(t, now - window.offlineSinceMs) })
      : t('e2ee.offline.unreachable');
  if (!window) return <>{since}</>;
  const left = window.executionUntilMs - now;
  return (
    <>
      {since}
      {left > 0
        ? t('e2ee.offline.machineLeft', { duration: duration(t, left) })
        : t('e2ee.offline.machinePaused')}
    </>
  );
}

/** Tooltip body for the current workspace's Offline mark. A leaf: its clock and the
 * runtime subscription re-render only this text, never the sidebar. */
export function E2eeOfflineSummary({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { state } = useElectronCliDaemon();
  const now = useMinuteClock();
  return <E2eeOfflineSummaryText window={e2eeOfflineWindow(state, workspaceId)} now={now} />;
}

export function E2eeMachineWindowPillView(props: { window: E2eeOfflineWindow; now: number }) {
  const { t } = useTranslation();
  const left = props.window.executionUntilMs - props.now;
  const minutes = Math.max(0, Math.floor(left / 60_000));
  return (
    <span
      data-e2ee-machine-window={left > 0 ? 'active' : 'paused'}
      className="inline-flex h-4 shrink-0 items-center rounded-full border border-sidebar-foreground-muted/30 px-1.5 text-[10px] font-normal leading-none tracking-normal text-sidebar-foreground-muted"
    >
      {left > 0
        ? t('e2ee.offline.machinePill', {
            time: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`,
          })
        : t('e2ee.offline.machinePillPaused')}
    </span>
  );
}

/** "Offline · 3:12 left" after this machine's name while it works from the outage
 * window; nothing otherwise. A leaf, like the machine Offline pill. */
export function E2eeMachineWindowPill({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { state } = useElectronCliDaemon();
  const now = useMinuteClock();
  const window = e2eeOfflineWindow(state, workspaceId);
  return window ? <E2eeMachineWindowPillView window={window} now={now} /> : null;
}
