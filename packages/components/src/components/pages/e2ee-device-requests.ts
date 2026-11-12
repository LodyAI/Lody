import { createContext, useContext } from 'react';

/** The account's waiting device requests, as the application-level inbox sees them. */
export type E2eeDeviceRequestsUi = {
  count: number;
  /** Opens the inbox list. */
  open: () => void;
  /** Opens the single waiting request directly, otherwise the inbox list. */
  review: () => void;
  /** A device just joined through a shown QR code: its automatic request needs no popup. */
  joinedByCode: () => void;
};
export const E2eeDeviceRequestsContext = createContext<E2eeDeviceRequestsUi | null>(null);
/** Null outside the inbox (a host without automatic pairing). */
export const useE2eeDeviceRequests = () => useContext(E2eeDeviceRequestsContext);

/**
 * Pairing links opened outside Lody (a phone's system camera scanning `lody://pair/…`
 * or `lody://auto-pair?…`). The native shell parks the URL on
 * `window.__LODY_PENDING_E2EE_PAIR_URL__` and dispatches `lody:e2ee-pair-url`. The most
 * recently mounted handler that accepts it consumes it; an unaccepted link is retried
 * on `retryE2eePairLink` (a request that has not been fetched yet) until it goes stale.
 */
type PairLinkHandler = (url: string) => boolean;
const handlers: PairLinkHandler[] = [];
const LINK_TTL_MS = 60_000;
let pending: { url: string; at: number } | null = null;
let listening = false;
type PairLinkWindow = Window & { __LODY_PENDING_E2EE_PAIR_URL__?: string };

export const isPairLink = (url: string) => /^lody:\/\/(?:pair\/|auto-pair\?)/i.test(url.trim());

function takeParked() {
  if (typeof window === 'undefined') return;
  const host = window as PairLinkWindow;
  const url = host.__LODY_PENDING_E2EE_PAIR_URL__;
  if (typeof url !== 'string') return;
  delete host.__LODY_PENDING_E2EE_PAIR_URL__;
  if (isPairLink(url)) pending = { url, at: Date.now() };
}
export function retryE2eePairLink() {
  takeParked();
  if (!pending) return;
  if (Date.now() - pending.at > LINK_TTL_MS) {
    pending = null;
    return;
  }
  for (const handler of [...handlers].reverse()) {
    if (handler(pending.url)) {
      pending = null;
      return;
    }
  }
}
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('lody:e2ee-pair-url', (event) => {
    const url = (event as CustomEvent<{ url?: unknown }>).detail?.url;
    if (typeof url !== 'string' || !isPairLink(url)) return;
    // The event carries the link; the parked copy is the same one.
    delete (window as PairLinkWindow).__LODY_PENDING_E2EE_PAIR_URL__;
    pending = { url, at: Date.now() };
    retryE2eePairLink();
  });
}
/** Registers a handler and returns its removal. */
export function registerE2eePairLinkHandler(handler: PairLinkHandler) {
  listen();
  handlers.push(handler);
  retryE2eePairLink();
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}
