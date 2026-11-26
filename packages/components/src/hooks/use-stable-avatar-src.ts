import { useEffect, useState } from 'react';
import {
  hasPersistedAvatar,
  peekAvatarBlobUrl,
  preloadAvatarBlobUrl,
  resolveAvatarEntry,
} from '@/lib/avatar-cache';

function computeInitialAvatarSrc(src?: string | null): string | null | undefined {
  if (src == null) return src;
  const cachedBlobUrl = peekAvatarBlobUrl(src);
  if (cachedBlobUrl != null) return cachedBlobUrl;
  if (hasPersistedAvatar(src)) return undefined;
  return src;
}

export function useStableAvatarSrc(src?: string | null): string | undefined {
  const [avatar, setAvatar] = useState(() => ({
    src,
    resolved: computeInitialAvatarSrc(src),
  }));
  const avatarSrc = avatar.src === src ? avatar.resolved : computeInitialAvatarSrc(src);

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
        preloadAvatarBlobUrl(src);
        setAvatarSrc(cachedBlobUrl);
        void resolveAvatarEntry(src, {
          onUpdate: (updated) => {
            if (!cancelled) setAvatarSrc(updated);
          },
        }).catch(() => {});
      } else {
        const persistedKnown = hasPersistedAvatar(src);
        setAvatarSrc(persistedKnown ? undefined : src);
        void resolveAvatarEntry(src, {
          onUpdate: (updated) => {
            if (!cancelled) setAvatarSrc(updated);
          },
        })
          .then((entry) => {
            preloadAvatarBlobUrl(src);
            if (!cancelled && entry && (persistedKnown || entry.source !== 'network')) {
              setAvatarSrc(entry.blobUrl);
            }
          })
          .catch(() => {
            if (!cancelled) setAvatarSrc(src);
          });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [src]);

  return avatarSrc ?? undefined;
}
