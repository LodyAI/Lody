import { App } from '@capacitor/app';
import { parseAutoPairLink } from '@lody/shared/e2ee-pair-link';

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
    const url = parseAutoPairLink(value);
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
