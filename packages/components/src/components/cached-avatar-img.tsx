import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { Avatar, type AvatarImageProps } from '@lody/ui/avatar';
import { useStableAvatarSrc } from '@/hooks/use-stable-avatar-src';
import {
  hasPersistedAvatar,
  peekAvatarBlobUrl,
  preloadAvatarBlobUrl,
  resolveAvatarBlobUrl,
} from '@/lib/avatar-cache';

export function useCachedAvatarSrc(src?: string | null): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | null>(() => peekAvatarBlobUrl(src) ?? null);
  const cachedNow = peekAvatarBlobUrl(src);
  const effectiveBlobUrl = cachedNow ?? blobUrl;
  const suppressRawWhileHydrating = effectiveBlobUrl == null && hasPersistedAvatar(src);

  useEffect(() => {
    let cancelled = false;

    const cached = peekAvatarBlobUrl(src);
    if (cached != null) {
      preloadAvatarBlobUrl(src);
      setBlobUrl(cached);
      void resolveAvatarBlobUrl(src, {
        onUpdate: (updated) => {
          if (!cancelled) setBlobUrl(updated);
        },
      }).catch(() => {});
    } else {
      setBlobUrl(null);
      if (src != null) {
        void resolveAvatarBlobUrl(src, {
          onUpdate: (updated) => {
            if (!cancelled) setBlobUrl(updated);
          },
        })
          .then((resolved) => {
            preloadAvatarBlobUrl(src);
            if (!cancelled && typeof resolved === 'string') {
              setBlobUrl(resolved);
            }
          })
          .catch(() => {});
      }
    }

    return () => {
      cancelled = true;
    };
  }, [src]);

  if (effectiveBlobUrl != null) return effectiveBlobUrl;
  if (suppressRawWhileHydrating) return undefined;
  return src ?? undefined;
}

export type CachedAvatarImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string | null;
};

export function CachedAvatarImg({
  src,
  referrerPolicy = 'no-referrer',
  ...rest
}: CachedAvatarImgProps) {
  const resolved = useCachedAvatarSrc(src);
  if (resolved == null) return null;
  return <img src={resolved} referrerPolicy={referrerPolicy} {...rest} />;
}

export type CachedAvatarImageProps = Omit<AvatarImageProps, 'src'> & {
  src?: string | null;
};

export function CachedAvatarImage({
  src,
  referrerPolicy = 'no-referrer',
  ...rest
}: CachedAvatarImageProps) {
  const resolved = useStableAvatarSrc(src);
  if (!resolved) return null;
  return <Avatar.Image src={resolved} referrerPolicy={referrerPolicy} {...rest} />;
}
