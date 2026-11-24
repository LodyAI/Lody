import { getImageMimeTypeForPath } from '@lody/shared/image-file-types';
import { getVideoMimeTypeForPath } from '../lib/video-file-preview';
import type { VerifiedBundle } from './bundle-cache';

const audio = new Map(
  Object.entries({
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    aac: 'audio/aac',
  })
);

/** Object URLs live only as long as this installation, even when another uses the same bytes. */
export function createPluginAssets(
  declared: readonly string[],
  files: VerifiedBundle,
  signal: AbortSignal
) {
  const assets = new Set(declared);
  const urls = new Map<string, string>();
  signal.addEventListener(
    'abort',
    () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
    { once: true }
  );
  return {
    url(relativePath: string) {
      signal.throwIfAborted();
      const path = relativePath.replace(/^\.\//, '');
      if (!assets.has(path)) throw new Error('Undeclared plugin asset');
      const cached = urls.get(path);
      if (cached) return cached;
      const extension = path.split('.').pop()?.toLowerCase() ?? '';
      const type =
        audio.get(extension) ??
        getImageMimeTypeForPath(path) ??
        getVideoMimeTypeForPath(path) ??
        'application/octet-stream';
      const url = URL.createObjectURL(new Blob([Uint8Array.from(files(path))], { type }));
      urls.set(path, url);
      return url;
    },
  };
}
