import type { SessionId } from '@lody/shared';

import { LRUCache } from '@/lib/lru-cache';

type ManagedPreviewFrameEntry = {
  iframe: HTMLIFrameElement;
  viewerUrl: string;
  loaded: boolean;
  evictionTimer: ReturnType<typeof setTimeout> | null;
};

type StatePreservingParent = HTMLElement & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

const MAX_MANAGED_PREVIEW_FRAMES = 5;
const DORMANT_FRAME_TTL_MS = 30 * 60 * 1000;

/**
 * Only an atomic move preserves an iframe's browsing context while reparenting.
 * Without it, parking and re-hosting a frame each reload the page, so caching
 * would cost more loads than mounting a fresh iframe every time.
 */
const supportsStatePreservingMove = (): boolean =>
  typeof HTMLElement !== 'undefined' &&
  typeof (HTMLElement.prototype as StatePreservingParent).moveBefore === 'function';

export const supportsCredentiallessManagedPreviewFrames = (): boolean =>
  typeof HTMLIFrameElement !== 'undefined' && 'credentialless' in HTMLIFrameElement.prototype;

const cancelDormantEviction = (entry: ManagedPreviewFrameEntry): void => {
  if (entry.evictionTimer === null) return;
  clearTimeout(entry.evictionTimer);
  entry.evictionTimer = null;
};

const destroyEntry = (entry: ManagedPreviewFrameEntry): void => {
  cancelDormantEviction(entry);
  entry.iframe.remove();
};

const frames = new LRUCache<SessionId, ManagedPreviewFrameEntry>(MAX_MANAGED_PREVIEW_FRAMES, {
  onEvict: (_sessionId, entry) => destroyEntry(entry),
});
let parkingLot: HTMLDivElement | null = null;

const getParkingLot = (): HTMLDivElement => {
  if (parkingLot?.isConnected) return parkingLot;
  parkingLot = document.createElement('div');
  parkingLot.hidden = true;
  parkingLot.setAttribute('data-lody-managed-preview-parking', 'true');
  document.body.appendChild(parkingLot);
  return parkingLot;
};

const moveFrame = (parent: HTMLElement, entry: ManagedPreviewFrameEntry): void => {
  const statePreservingParent = parent as StatePreservingParent;
  if (
    entry.iframe.isConnected &&
    parent.isConnected &&
    typeof statePreservingParent.moveBefore === 'function'
  ) {
    try {
      statePreservingParent.moveBefore(entry.iframe, null);
      return;
    } catch {
      // Fall through for browser implementations with stricter move constraints.
    }
  }

  // A detach/attach pair rebuilds the nested browsing context, so the page is
  // reloading and whatever it had loaded before no longer counts.
  parent.appendChild(entry.iframe);
  entry.loaded = false;
};

const createEntry = (
  viewerUrl: string,
  title: string,
  documentHtml?: string
): ManagedPreviewFrameEntry => {
  const iframe = document.createElement('iframe');
  const entry: ManagedPreviewFrameEntry = {
    iframe,
    viewerUrl,
    loaded: false,
    evictionTimer: null,
  };
  iframe.className = 'block h-full w-full border-0 bg-white';
  iframe.title = title;
  iframe.setAttribute('data-lody-managed-preview-frame', 'true');
  if (documentHtml !== undefined) {
    // The source document is untrusted. It gets scripts for its own behavior and
    // the annotation runtime, but no same-origin, form, popup, download, modal,
    // storage, clipboard, fullscreen, or top-navigation privileges.
    iframe.setAttribute('sandbox', 'allow-scripts');
    // If source JavaScript navigates the iframe despite the self-contained
    // contract, keep the resulting request in a credentialless context.
    iframe.setAttribute('credentialless', '');
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute(
      'allow',
      "accelerometer 'none'; autoplay 'none'; camera 'none'; clipboard-read 'none'; " +
        "clipboard-write 'none'; display-capture 'none'; encrypted-media 'none'; " +
        "fullscreen 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; midi 'none'"
    );
  } else {
    // The managed application preview runs on an isolated endpoint origin and
    // needs normal app semantics, so the sandbox stays permissive but explicit.
    iframe.setAttribute('sandbox', 'allow-forms allow-modals allow-same-origin allow-scripts');
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
  }
  iframe.addEventListener('load', () => {
    entry.loaded = true;
  });
  if (documentHtml === undefined) {
    iframe.src = viewerUrl;
  } else {
    iframe.srcdoc = documentHtml;
  }
  return entry;
};

export const acquireManagedPreviewFrame = ({
  sessionId,
  viewerUrl,
  title,
  host,
  documentHtml,
}: {
  sessionId: SessionId;
  viewerUrl: string;
  title: string;
  host: HTMLElement;
  documentHtml?: string;
}): { iframe: HTMLIFrameElement; loaded: boolean } => {
  if (documentHtml !== undefined && !supportsCredentiallessManagedPreviewFrames()) {
    throw new Error('Static HTML preview requires credentialless iframe support.');
  }
  // Static documents can execute arbitrary user-authored JavaScript. Never
  // park them in the dormant-frame cache where they could keep running after
  // the file tab or rendered mode is no longer visible.
  if (documentHtml !== undefined || !supportsStatePreservingMove()) {
    const entry = createEntry(viewerUrl, title, documentHtml);
    host.appendChild(entry.iframe);
    return { iframe: entry.iframe, loaded: false };
  }

  let entry = frames.get(sessionId);
  if (!entry) {
    entry = createEntry(viewerUrl, title, documentHtml);
  } else {
    cancelDormantEviction(entry);
    entry.iframe.title = title;
    if (entry.viewerUrl !== viewerUrl) {
      entry.viewerUrl = viewerUrl;
      entry.loaded = false;
      entry.iframe.src = viewerUrl;
    }
  }

  // Re-inserting marks the in-use frame as most recently used, so it can never
  // be the entry evicted to make room for another session.
  frames.set(sessionId, entry);
  moveFrame(host, entry);
  return { iframe: entry.iframe, loaded: entry.loaded };
};

export const releaseManagedPreviewFrame = (
  sessionId: SessionId,
  iframe: HTMLIFrameElement
): void => {
  const entry = frames.get(sessionId);
  if (!entry || entry.iframe !== iframe) {
    // Never cached (no atomic move) or already superseded: nothing to preserve.
    iframe.remove();
    return;
  }
  moveFrame(getParkingLot(), entry);
  entry.evictionTimer = setTimeout(() => {
    entry.evictionTimer = null;
    frames.delete(sessionId);
    entry.iframe.remove();
  }, DORMANT_FRAME_TTL_MS);
};

export const clearManagedPreviewFrame = (sessionId: SessionId): void => {
  const entry = frames.get(sessionId);
  if (!entry) return;
  frames.delete(sessionId);
  destroyEntry(entry);
};
