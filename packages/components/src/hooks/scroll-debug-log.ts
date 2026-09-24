/**
 * Diagnostic timeline for conversation scrolling: open, reveal, follow
 * corrections, hydration windows and follow-mode transitions.
 *
 * Recording is on in development builds and whenever
 * `localStorage['lody:debug-scroll'] === '1'`; console output needs that flag.
 * `window.__lodyScrollLog.dump()` returns the retained entries (JSON friendly)
 * and `.clear()` empties them. Entries carry geometry only — never message text.
 */

const FLAG_KEY = 'lody:debug-scroll';
const MAX_ENTRIES = 3000;

export interface ScrollDebugEntry {
  /** Milliseconds from page load (`performance.now()`). */
  t: number;
  event: string;
  data?: Record<string, unknown>;
}

interface ScrollDebugLog {
  entries: ScrollDebugEntry[];
  dump: () => ScrollDebugEntry[];
  clear: () => void;
}

const readFlag = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
};

const consoleEnabled = readFlag();
const recordingEnabled = consoleEnabled || import.meta.env?.DEV === true;

let log: ScrollDebugLog | null = null;
const getLog = (): ScrollDebugLog => {
  if (log) return log;
  const entries: ScrollDebugEntry[] = [];
  log = {
    entries,
    dump: () => entries.slice(),
    clear: () => {
      entries.length = 0;
    },
  };
  if (typeof window !== 'undefined') {
    (window as unknown as { __lodyScrollLog?: ScrollDebugLog }).__lodyScrollLog = log;
  }
  return log;
};

export const isScrollDebugEnabled = (): boolean => recordingEnabled;

export function scrollDebug(event: string, data?: Record<string, unknown>): void {
  if (!recordingEnabled) return;
  const entry: ScrollDebugEntry = { t: Math.round(performance.now() * 10) / 10, event, data };
  const { entries } = getLog();
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  if (consoleEnabled) console.debug(`[lody:scroll] ${event}`, data ?? '');
}

/** Geometry snapshot of a scroll viewport for log entries. */
export const describeViewport = (
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'> | null
): Record<string, number> | null =>
  viewport
    ? {
        scrollTop: Math.round(viewport.scrollTop),
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      }
    : null;
