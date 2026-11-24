/**
 * Single-shot flag telling the next mounted mobile page it is a back
 * destination, plus the layered back handler stack for Android's Back bridge.
 */
let suppressNextEnter = false;

function clearOnNextPress(): void {
  suppressNextEnter = false;
}

export function markMobileBackNavigation(): void {
  suppressNextEnter = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', clearOnNextPress, { capture: true, once: true });
  }
}

export function consumeMobileBackNavigation(): boolean {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', clearOnNextPress, { capture: true });
  }
  if (suppressNextEnter) {
    suppressNextEnter = false;
    return true;
  }
  return false;
}

export type MobileBackLayer = 'page' | 'drawer' | 'modal';

export type MobileBackHandler = () => boolean | void;

const LAYER_BASE_PRIORITY: Record<MobileBackLayer, number> = {
  page: 0,
  drawer: 100,
  modal: 200,
};

type BackHandlerEntry = {
  readonly id: number;
  readonly priority: number;
  readonly handler: MobileBackHandler;
};

let nextBackHandlerId = 1;
const backHandlers: BackHandlerEntry[] = [];

export function registerMobileBackHandler(
  handler: MobileBackHandler,
  options?: { layer?: MobileBackLayer; depth?: number }
): () => void {
  const layer = options?.layer ?? 'page';
  const depth = Math.max(0, options?.depth ?? 0);
  const entry: BackHandlerEntry = {
    id: nextBackHandlerId++,
    priority: LAYER_BASE_PRIORITY[layer] + depth,
    handler,
  };
  backHandlers.push(entry);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const index = backHandlers.indexOf(entry);
    if (index !== -1) {
      backHandlers.splice(index, 1);
    }
  };
}

export function dispatchMobileBack(): boolean {
  if (backHandlers.length === 0) return false;
  const ordered = [...backHandlers].sort((a, b) => b.priority - a.priority || b.id - a.id);
  for (const entry of ordered) {
    if (!backHandlers.includes(entry)) continue;
    if (entry.handler() !== false) {
      return true;
    }
  }
  return false;
}
