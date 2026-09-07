import * as React from 'react';

export type SafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

const ZERO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Reads the device safe-area insets as numbers so they can be fed into Radix's
 * `collisionPadding` (which only accepts numbers). Without this, floating
 * surfaces (dropdowns, popovers) may open beneath the iPhone Dynamic Island /
 * status bar and become unreachable when their option list is taller than the
 * viewport.
 *
 * The insets are one document-level value, so they are read into a module-level
 * store rather than once per hook instance. `DropdownMenuContent` and
 * `PopoverContent` run this hook whether or not their menu is open, and a
 * session switch mounts hundreds of them; a per-instance `getComputedStyle`
 * lands in the passive-effect phase right after the commit dirtied style, so
 * every one of them forced a full-document style recalculation.
 *
 * The snapshot keeps its identity while the values are unchanged so subscribers
 * do not re-render, and the two window listeners are held for the document's
 * lifetime: releasing them on the last unsubscribe would re-read — and force a
 * recalculation again — every time a commit briefly unmounts every floating
 * surface, which is the burst this exists to avoid.
 */
let currentInsets: SafeAreaInsets = ZERO_INSETS;
let listening = false;
const listeners = new Set<() => void>();

function readInsets(): SafeAreaInsets {
  const computed = getComputedStyle(document.documentElement);
  const px = (name: string) => {
    const value = Number.parseFloat(computed.getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
  };
  return {
    top: px('--safe-area-top'),
    right: px('--safe-area-right'),
    bottom: px('--safe-area-bottom'),
    left: px('--safe-area-left'),
  };
}

function refreshInsets(): void {
  const next = readInsets();
  const previous = currentInsets;
  if (
    next.top === previous.top &&
    next.right === previous.right &&
    next.bottom === previous.bottom &&
    next.left === previous.left
  ) {
    return;
  }
  currentInsets = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!listening) {
    listening = true;
    refreshInsets();
    window.addEventListener('resize', refreshInsets);
    window.addEventListener('orientationchange', refreshInsets);
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SafeAreaInsets {
  return currentInsets;
}

/** Server/prerender has no layout to measure, so the zero snapshot is the answer. */
function getServerSnapshot(): SafeAreaInsets {
  return ZERO_INSETS;
}

export function useSafeAreaInsets(): SafeAreaInsets {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test seam: drops the cached read and its window listeners. */
export function resetSafeAreaInsetsForTest(): void {
  if (listening) {
    window.removeEventListener('resize', refreshInsets);
    window.removeEventListener('orientationchange', refreshInsets);
  }
  listening = false;
  listeners.clear();
  currentInsets = ZERO_INSETS;
}
