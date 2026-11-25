import { isTodayWindow } from '../desktop-window';

/**
 * Boot phases of the desktop Today window, in milliseconds since its renderer's
 * navigation start. Main correlates them with its own open request through
 * `timeOrigin` (epoch ms) and logs the report.
 */
export type TodayWindowBootPhase =
  | 'renderer-entry'
  | 'i18n-ready'
  | 'react-render'
  | 'route'
  | 'view-chunk'
  | 'runtime-start'
  | 'runtime-module'
  | 'runtime-ready'
  | 'view-runtime'
  | 'page-acquired'
  | 'content-painted'
  /** The top page's room synced with a peer; never while the page is unregistered. */
  | 'page-synced';

export const TODAY_WINDOW_BOOT_LOG_PREFIX = '[today-window] boot timeline';

const marks: Partial<Record<TodayWindowBootPhase, number>> = {};
let reported = false;

export function markTodayWindowBoot(phase: TodayWindowBootPhase): void {
  if (marks[phase] !== undefined || !isTodayWindow()) return;
  marks[phase] = Math.round(performance.now());
  if (reported) {
    console.info(`${TODAY_WINDOW_BOOT_LOG_PREFIX} ${JSON.stringify({ [phase]: marks[phase] })}`);
    return;
  }
  if (phase !== 'content-painted') return;
  reported = true;
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  console.info(
    `${TODAY_WINDOW_BOOT_LOG_PREFIX} ${JSON.stringify({
      timeOrigin: Math.round(performance.timeOrigin),
      ...(navigation
        ? {
            domInteractive: Math.round(navigation.domInteractive),
            domContentLoaded: Math.round(navigation.domContentLoadedEventEnd),
          }
        : {}),
      ...marks,
    })}`
  );
}
