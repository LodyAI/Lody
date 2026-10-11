const VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};

/** A container candidate; the browser still decides whether its codecs play. */
export function getVideoMimeTypeForPath(path: string): string | undefined {
  const extension = /\.([^./\\]+)$/u.exec(path.split(/[?#]/u)[0] ?? '')?.[1]?.toLowerCase();
  return extension && Object.hasOwn(VIDEO_MIME_TYPES, extension)
    ? VIDEO_MIME_TYPES[extension]
    : undefined;
}
