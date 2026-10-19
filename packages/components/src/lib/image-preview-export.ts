import type { ImagePreviewMenuAction, ShowImagePreviewMenuInput } from '@lody/shared/electron-ipc';
import { isNativeAppShell } from './native-platform';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices, type IpcServices } from '@/lib/electron-ipc-client';

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

export type ImagePreviewExportBridge = {
  showMenu: IpcServices['image']['showPreviewMenu'];
  copyToClipboard: IpcServices['image']['copyToClipboard'];
  saveAs: IpcServices['image']['saveAs'];
};

/**
 * Null on web, on mobile, and on an older preload build. Every caller must treat
 * that as "no menu", never as an error: the browser's own context menu already
 * offers copy/save there.
 */
export function getImagePreviewExportBridge(): ImagePreviewExportBridge | null {
  if (typeof window === 'undefined' || !isElectronRenderer()) {
    return null;
  }
  const services = getIpcServices();
  if (!services) return null;
  return {
    showMenu: services.image.showPreviewMenu.bind(services.image),
    copyToClipboard: services.image.copyToClipboard.bind(services.image),
    saveAs: services.image.saveAs.bind(services.image),
  };
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
  image.crossOrigin = 'anonymous';
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

/** Prepare before the menu action so Web Share keeps the click's user activation. */
export async function prepareImagePreviewFile(
  src: string,
  fileName?: string,
  signal?: AbortSignal
): Promise<File> {
  const response = await fetch(src, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`image request failed with ${response.status}`);
  const blob = await response.blob();
  return new File([blob], resolveExportFileName(fileName, blob.type), { type: blob.type });
}

export function canCopyImagePreview(): boolean {
  return Boolean(
    getImagePreviewExportBridge() ||
    (typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined')
  );
}

export function canShareImagePreview(file: File): boolean {
  if (isNativeAppShell()) return true;
  try {
    return (
      typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] }) === true
    );
  } catch {
    return false;
  }
}

export type TouchImagePreviewOutcome =
  | ImagePreviewExportOutcome
  | { kind: 'shared' | 'download-started' }
  | { kind: 'share-failed'; error: string };

/** No URL/text clipboard substitute: an unsupported bitmap copy is a failure. */
export async function runTouchImagePreviewAction(
  action: 'copy' | 'save' | 'share',
  src: string,
  file: File
): Promise<TouchImagePreviewOutcome> {
  try {
    const bridge = getImagePreviewExportBridge();
    if (action === 'copy') {
      if (bridge) {
        const result = await bridge.copyToClipboard({ pngBytes: await encodePngBytes(src, file) });
        return result.copied
          ? { kind: 'copied' }
          : { kind: 'copy-failed', error: result.error ?? 'copy_failed' };
      }
      if (!canCopyImagePreview()) throw new Error('Image clipboard is unavailable');
      // Start in the click handler; WebKit must not lose transient activation.
      const png = encodePngBytes(src, file).then(
        (bytes) => new Blob([bytes], { type: PNG_MIME_TYPE })
      );
      await navigator.clipboard.write([new ClipboardItem({ [PNG_MIME_TYPE]: png })]);
      return { kind: 'copied' };
    }
    if (action === 'save' && bridge) {
      const result = await bridge.saveAs({ fileName: file.name, bytes: await file.arrayBuffer() });
      if (result.saved) return { kind: 'saved' };
      return result.canceled
        ? { kind: 'save-canceled' }
        : { kind: 'save-failed', error: result.error };
    }
    if (isNativeAppShell()) {
      const { shareFileBytesNatively } = await import('./session-file-native-save');
      const { shared } = await shareFileBytesNatively(
        file.name,
        new Uint8Array(await file.arrayBuffer())
      );
      // Save routes through the same OS sheet; it cannot promise an album write.
      return { kind: shared ? 'shared' : 'dismissed' };
    }
    if (action === 'share') {
      if (!canShareImagePreview(file)) throw new Error('Image sharing is unavailable');
      await navigator.share({ files: [file] });
      return { kind: 'shared' };
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return { kind: 'download-started' };
  } catch (error) {
    if (action === 'share' && error instanceof DOMException && error.name === 'AbortError') {
      return { kind: 'dismissed' };
    }
    return { kind: `${action}-failed`, error: describeError(error) };
  }
}
