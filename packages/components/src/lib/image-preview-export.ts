import type { ImagePreviewMenuAction, ShowImagePreviewMenuInput } from '@lody/shared/electron-ipc';
import { isElectronRenderer } from '@/lib/electron';

/**
 * Copy / save for the image preview's right-click menu.
 *
 * The previewed image lives in this renderer as a `blob:` URL, so the main
 * process cannot fetch or decode it — the split is: main owns the native menu,
 * the clipboard, and the save dialog (`services/image-export-service.ts`), and
 * everything here turns the on-screen image into bytes for exactly the action
 * the user picked.
 */

const PNG_MIME_TYPE = 'image/png';
const FALLBACK_FILE_NAME = 'image.png';

/** Extensions worth trusting from a source name, keyed by the browser's mime type. */
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

export type ImagePreviewExportBridge = NonNullable<NonNullable<Window['api']>['imagePreview']>;

/**
 * Null on web, on mobile, and on an older preload build. Every caller must treat
 * that as "no menu", never as an error: the browser's own context menu already
 * offers copy/save there.
 */
export function getImagePreviewExportBridge(): ImagePreviewExportBridge | null {
  if (typeof window === 'undefined' || !isElectronRenderer()) {
    return null;
  }
  return window.api?.imagePreview ?? null;
}

/**
 * A save-dialog default. Prefers the source name (it is what the user recognizes)
 * and only appends an extension when that name has none, so a `.jpeg` upload is
 * never silently renamed to `.jpg`.
 */
export function resolveExportFileName(
  sourceFileName: string | undefined,
  mimeType: string | undefined
): string {
  const baseName = sourceFileName?.split(/[\\/]/).pop()?.trim() ?? '';
  const extension = mimeType ? EXTENSION_BY_MIME_TYPE[mimeType.toLowerCase()] : undefined;

  if (!baseName) {
    return extension ? `image.${extension}` : FALLBACK_FILE_NAME;
  }
  if (/\.[a-z0-9]{1,8}$/i.test(baseName)) {
    return baseName;
  }
  return extension ? `${baseName}.${extension}` : baseName;
}

async function fetchImageBlob(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`image request failed with ${response.status}`);
  }
  return await response.blob();
}

/**
 * Re-encode to PNG through a canvas, because that is the only raster format the
 * system clipboard reliably takes — a JPEG/WebP/SVG buffer handed to
 * `nativeImage` either fails to decode or decodes to an empty image. A source
 * that is already PNG skips the round trip.
 *
 * The source is a same-origin `blob:`/`data:` URL, so the canvas never taints.
 */
async function encodePngBytes(src: string, blob: Blob): Promise<ArrayBuffer> {
  if (blob.type === PNG_MIME_TYPE) {
    return await blob.arrayBuffer();
  }

  const image = new Image();
  image.src = src;
  await image.decode();

  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) {
    // A vector without an intrinsic size has no pixel dimensions to copy.
    throw new Error('image has no intrinsic size');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('canvas context unavailable');
  }
  context.drawImage(image, 0, 0);

  const pngBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, PNG_MIME_TYPE);
  });
  if (!pngBlob) {
    throw new Error('png encoding failed');
  }
  return await pngBlob.arrayBuffer();
}

export type ImagePreviewMenuItem = { action: ImagePreviewMenuAction; label: string };

/** What the caller should tell the user. `dismissed` covers "no menu selection". */
export type ImagePreviewExportOutcome =
  | { kind: 'dismissed' }
  | { kind: 'copied' }
  | { kind: 'saved' }
  | { kind: 'save-canceled' }
  | { kind: 'copy-failed'; error: string }
  | { kind: 'save-failed'; error: string };

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Show the native menu for a previewed image and run whatever the user picked.
 * Returns `{ kind: 'dismissed' }` when there is no bridge or no selection, so a
 * right-click outside Electron stays a no-op.
 */
export async function runImagePreviewContextMenu(options: {
  readonly src: string;
  readonly fileName?: string | undefined;
  readonly items: ImagePreviewMenuItem[];
}): Promise<ImagePreviewExportOutcome> {
  const bridge = getImagePreviewExportBridge();
  if (!bridge || options.items.length === 0) {
    return { kind: 'dismissed' };
  }

  const menuInput: ShowImagePreviewMenuInput = { items: options.items };
  const { action } = await bridge.showMenu(menuInput);
  if (!action) {
    return { kind: 'dismissed' };
  }

  if (action === 'copy') {
    try {
      const blob = await fetchImageBlob(options.src);
      const pngBytes = await encodePngBytes(options.src, blob);
      const result = await bridge.copyToClipboard({ pngBytes });
      return result.copied
        ? { kind: 'copied' }
        : { kind: 'copy-failed', error: result.error ?? 'copy_failed' };
    } catch (error) {
      return { kind: 'copy-failed', error: describeError(error) };
    }
  }

  try {
    const blob = await fetchImageBlob(options.src);
    // Saved in the ORIGINAL encoding: a re-encode would hand the user a
    // different file than the one they are looking at.
    const bytes = await blob.arrayBuffer();
    const result = await bridge.saveAs({
      fileName: resolveExportFileName(options.fileName, blob.type),
      bytes,
    });
    if (result.saved) {
      return { kind: 'saved' };
    }
    return result.canceled
      ? { kind: 'save-canceled' }
      : { kind: 'save-failed', error: result.error };
  } catch (error) {
    return { kind: 'save-failed', error: describeError(error) };
  }
}
