const VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};

const EXTENDED_VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
  ...VIDEO_MIME_TYPES,
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

const getPathExtension = (path: string): string | undefined =>
  /\.([^./\\]+)$/u.exec(path.split(/[?#]/u)[0] ?? '')?.[1]?.toLowerCase();

/** A container candidate; the browser still decides whether its codecs play. */
export function getVideoMimeTypeForPath(path: string): string | undefined {
  const extension = getPathExtension(path);
  return extension && Object.hasOwn(VIDEO_MIME_TYPES, extension)
    ? VIDEO_MIME_TYPES[extension]
    : undefined;
}

export function resolveVideoMimeType(fileName: string, mimeType?: string): string | undefined {
  const extension = getPathExtension(fileName);
  if (extension && Object.hasOwn(EXTENDED_VIDEO_MIME_TYPES, extension)) {
    return EXTENDED_VIDEO_MIME_TYPES[extension];
  }
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized?.startsWith('video/')) {
    return normalized;
  }
  return undefined;
}
