import { useEffect, useId, useRef, useState } from 'react';

export type SideRailAction = {
  id: string;
  label: string;
  symbol: string;
  selected?: boolean;
  onPress: () => void;
};

type Registration = {
  priority: number;
  actions: SideRailAction[];
  setVisible: (value: boolean) => void;
};

type RailMessage = { owner: string; items: Omit<SideRailAction, 'onPress'>[] };
type NativeWindow = Window & {
  webkit?: { messageHandlers?: { lodySideRail?: { postMessage: (message: RailMessage) => void } } };
};

const registrations = new Map<string, Registration>();
let currentOwner = '';
let observer: MutationObserver | undefined;
let lastMessage = '';

function hasBlockingDialog(): boolean {
  return Array.from(
    document.querySelectorAll(
      '[aria-modal="true"]:not([data-state="closed"]), [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'
    )
  ).some((dialog) => !dialog.hasAttribute('data-lody-session-drawer'));
}

function publish(): void {
  const native = (window as NativeWindow).webkit?.messageHandlers?.lodySideRail;
  if (!native) return;
  const active = !hasBlockingDialog()
    ? [...registrations.entries()].sort((a, b) => b[1].priority - a[1].priority)[0]
    : undefined;
  currentOwner = active?.[0] ?? '';
  for (const [owner, registration] of registrations) {
    if (owner !== currentOwner) registration.setVisible(false);
  }
  const actions = active?.[1].actions ?? [];
  const message: RailMessage = {
    owner: currentOwner,
    items: (actions.length <= 6 ? actions : []).map(({ id, label, symbol, selected }) => ({
      id,
      label,
      symbol,
      selected: selected ?? false,
    })),
  };
  const serialized = JSON.stringify(message);
  if (serialized !== lastMessage) {
    lastMessage = serialized;
    native.postMessage(message);
  }
}

function onRailEvent(event: Event): void {
  const detail = (event as CustomEvent<{ owner: string; action?: string; visible?: boolean }>)
    .detail;
  if (!detail || detail.owner !== currentOwner) return;
  const registration = registrations.get(detail.owner);
  if (typeof detail.visible === 'boolean') registration?.setVisible(detail.visible);
  if (detail.action) registration?.actions.find((action) => action.id === detail.action)?.onPress();
}

/** The native host owns geometry; normal web controls remain the fallback. */
export function useNativeSideRail(actions: SideRailAction[], priority: number): boolean {
  const id = useId();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!(window as NativeWindow).webkit?.messageHandlers?.lodySideRail) return undefined;
    if (!observer) {
      window.addEventListener('lody:side-rail', onRailEvent);
      observer = new MutationObserver(publish);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-modal', 'data-state', 'role'],
      });
    }
    registrations.set(id, { priority, actions: actionsRef.current, setVisible });
    publish();
    return () => {
      registrations.delete(id);
      publish();
      if (!registrations.size) {
        observer?.disconnect();
        observer = undefined;
        window.removeEventListener('lody:side-rail', onRailEvent);
        lastMessage = '';
      }
    };
  }, [id, priority]);

  useEffect(() => {
    const registration = registrations.get(id);
    if (registration) {
      registration.actions = actionsRef.current;
      publish();
    }
  });
  return visible;
}
