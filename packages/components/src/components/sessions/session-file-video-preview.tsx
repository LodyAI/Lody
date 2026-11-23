import { useEffect, useState } from 'react';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { getVideoMimeTypeForPath } from '@/lib/video-file-preview';
import { VideoPlayer } from '../shared/video-player';

interface SessionFileVideoPreviewProps {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly active?: boolean;
  readonly fileActions?: SessionFileErrorActions;
}

/** Only consumes provider-authorized sources; never resolves host file paths. */
export function SessionFileVideoPreview({
  path,
  bytes,
  url,
  active = true,
  fileActions,
}: SessionFileVideoPreviewProps) {
  const mimeType = getVideoMimeTypeForPath(path);
  const [source, setSource] = useState<{
    path: string;
    bytes?: Uint8Array;
    url?: string;
    src: string;
  }>();

  useEffect(() => {
    if (!active || !mimeType) return undefined;
    const src =
      url ?? (bytes && URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mimeType })));
    if (!src) return undefined;
    setSource({ path, bytes, url, src });
    return () => {
      setSource(undefined);
      if (!url) URL.revokeObjectURL(src);
    };
  }, [active, path, bytes, url, mimeType]);

  // Never mount a previous file's source while its replacement effect is pending.
  if (!active || !source || source.path !== path || source.bytes !== bytes || source.url !== url) {
    return null;
  }
  return (
    <VideoPlayer key={source.src} src={source.src} active={active} fileActions={fileActions} />
  );
}
