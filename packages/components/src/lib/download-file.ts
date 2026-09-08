/**
 * Saves bytes the client already holds as a file download. This is the REMOTE
 * stand-in for the desktop app's reveal/open actions: when the file lives on a
 * machine this client cannot reach, a copy in the browser's download folder is
 * the only way to get at it.
 */
export function downloadBytesAsFile(filePath: string, bytes: Uint8Array): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = getDownloadFileName(filePath);
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // The click has already started the download; the object URL only has to
    // outlive the synchronous navigation it triggers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function getDownloadFileName(filePath: string): string {
  const segments = filePath.trim().split(/[\\/]+/u);
  return segments[segments.length - 1]?.trim() || 'download';
}
