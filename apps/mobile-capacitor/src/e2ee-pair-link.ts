import { App } from '@capacitor/app';

/** Longest accepted pairing link; anything longer is not a Lody pairing link. */
const MAX_LENGTH = 512;

/** The link itself when it is a `lody://pair/<code>` or `lody://auto-pair?…` link,
 * otherwise `null`. OAuth callbacks and every other `lody://` link pass untouched. */
function pairingLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // The OS may hand over any letter case for the scheme and host.
  if (url.protocol.toLowerCase() !== 'lody:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'pair') return url.pathname.length > 1 ? value : null;
  if (host === 'auto-pair') return url.search.length > 1 ? value : null;
  return null;
}

type PairLinkWindow = typeof window & { __LODY_PENDING_E2EE_PAIR_URL__?: string };

/**
 * Hands a pairing link opened from the OS (for example the Camera app's
 * "Open in Lody") to the shared pairing screen: the latest link is kept on
 * `window.__LODY_PENDING_E2EE_PAIR_URL__` for a screen that mounts later, and
 * `lody:e2ee-pair-url` tells a mounted one. The link carries a pairing secret,
 * so it is never logged or reported.
 */
export function initE2eePairLinks(): () => Promise<void> {
  const target = window as PairLinkWindow;
  let warm = false;
  const publish = (value: unknown) => {
    const url = pairingLink(value);
    if (!url) return false;
    target.__LODY_PENDING_E2EE_PAIR_URL__ = url;
    target.dispatchEvent(new CustomEvent('lody:e2ee-pair-url', { detail: { url } }));
    return true;
  };
  const listener = App.addListener('appUrlOpen', (event) => {
    if (publish(event.url)) warm = true;
  });
  void App.getLaunchUrl()
    .then((launch) => {
      // A link opened since launch is newer than the one that started the app.
      if (!warm) publish(launch?.url);
    })
    .catch(() => {});
  return async () => {
    await (await listener).remove();
  };
}
