import { useEffect, useState } from 'react';
import { peekAvatarBlobUrl, preloadAvatarBlobUrl, resolveAvatarBlobUrl } from '@/lib/avatar-cache';

/**
 * Resolve an avatar URL to a locally-cached blob URL, cache-first, and swap to
 * a fresh copy only when the remote actually changed.
 *
 * This is the "stable" counterpart to `useCachedAvatarSrc`
 * (cached-avatar-img.tsx). Use it for our own long-lived avatars (user image /
 * workspace logo on R2), where the raw `src` URL is itself the current remote:
 *
 *   - Local blob hot (memory hit, e.g. rehydrated at startup): paint it
 *     immediately (instant, offline-safe), then revalidate the remote in the
 *     background and swap only if the bytes changed. No flicker on unchanged.
 *   - No hot blob yet: paint the raw URL now — it IS the current remote, served
 *     from the browser HTTP cache — and fill the blob cache in the background
 *     WITHOUT swapping. The bytes are identical, so a raw→blob swap would only
 *     cause a re-decode flicker; the cache warms the blob for the next mount.
 *
 * `useCachedAvatarSrc` deliberately DOES swap raw→blob on first load — it is
 * tuned for GitHub owner avatars whose short `max-age` makes the raw URL an
 * unreliable paint, so the blob is the first dependable one. Don't conflate.
 */
export function useStableAvatarSrc(src?: string | null): string | undefined {
  const [avatar, setAvatar] = useState(() => ({ src, resolved: peekAvatarBlobUrl(src) ?? src }));
  // A profile/source change must paint its own image in this commit, including
  // undefined → URL after metadata arrives, without showing the previous user.
  const avatarSrc = avatar.src === src ? avatar.resolved : (peekAvatarBlobUrl(src) ?? src);

  useEffect(() => {
    let cancelled = false;
    const setAvatarSrc = (resolved: string | null | undefined) => {
      setAvatar((current) =>
        current.src === src && current.resolved === resolved ? current : { src, resolved }
      );
    };

    if (src == null) {
      setAvatarSrc(src);
    } else {
      const cachedBlobUrl = peekAvatarBlobUrl(src);
      if (cachedBlobUrl != null) {
        // Local copy is hot: paint it now, revalidate the remote, swap on change.
        preloadAvatarBlobUrl(src);
        setAvatarSrc(cachedBlobUrl);
        void resolveAvatarBlobUrl(src, {
          onUpdate: (updated) => {
            if (!cancelled) setAvatarSrc(updated);
          },
        }).catch(() => {
          /* Already showing the cached blob; nothing to do. */
        });
      } else {
        // Memory miss: paint the raw URL (current remote) and hydrate the blob
        // cache in the background; deliberately don't swap, to avoid a re-decode
        // flicker when the bytes are the same.
        setAvatarSrc(src);
        void resolveAvatarBlobUrl(src)
          .then(() => preloadAvatarBlobUrl(src))
          .catch(() => {
            /* Already showing the raw URL; a failed hydration retries next mount. */
          });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [src]);

  return avatarSrc ?? undefined;
}
