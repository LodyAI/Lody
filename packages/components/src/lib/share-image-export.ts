/**
 * Shared PNG capture for the product's share cards (session conversation,
 * workspace usage). One pipeline so both surfaces get the same font/image
 * readiness, the same Electron save/clipboard bridge, and the same failures.
 */
import { getImagePreviewExportBridge } from './image-preview-export';

function pinOrderedListValues(element: HTMLElement): () => void {
  const originals = new Map<HTMLLIElement, string | null>();
  for (const list of element.querySelectorAll('ol')) {
    const items = Array.from(list.children).filter(
      (child): child is HTMLLIElement => child.tagName === 'LI'
    );
    let value = list.reversed && !list.hasAttribute('start') ? items.length : list.start;
    for (const item of items) {
      const original = item.getAttribute('value');
      originals.set(item, original);
      const explicit = original === null ? NaN : Number.parseInt(original, 10);
      if (Number.isFinite(explicit)) value = explicit;
      item.value = value;
      value += list.reversed ? -1 : 1;
    }
  }
  return () => {
    for (const [item, value] of originals) {
      if (value === null) item.removeAttribute('value');
      else item.setAttribute('value', value);
    }
  };
}

async function captureShareImage(element: HTMLElement): Promise<Blob> {
  await document.fonts.ready;
  await Promise.all(Array.from(element.querySelectorAll('img')).map((image) => image.decode()));
  const { snapdom } = await import('@zumer/snapdom');
  // SnapDOM 2.24 treats absent li[value] as zero when resolving list-item counters.
  const restoreLists = pinOrderedListValues(element);
  let blob: Blob;
  try {
    // Capture the natural-size card inside the scaled preview, without its scroll container.
    blob = await snapdom.toBlob(element, {
      type: 'png',
      scale: 2,
      dpr: 1,
      embedFonts: true,
      compress: false,
      plugins: [
        {
          name: 'lody-share-hide-scrollbars',
          beforeRender(context) {
            // Replace copied scrollbar rules only in the serialized image.
            context.scrollbarCSS =
              '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}';
          },
        },
      ],
    });
  } finally {
    restoreLists();
  }
  if (blob.type !== 'image/png' || blob.size === 0) throw new Error('PNG encoding failed');
  return blob;
}

export async function copyShareImage(element: HTMLElement): Promise<void> {
  const bridge = getImagePreviewExportBridge();
  if (bridge) {
    const blob = await captureShareImage(element);
    const result = await bridge.copyToClipboard({ pngBytes: await blob.arrayBuffer() });
    if (!result.copied) throw new Error(result.error || 'Image copy failed');
    return;
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Image clipboard is unavailable');
  }

  // WebKit revokes transient user activation after an await. Start the clipboard
  // write synchronously and let ClipboardItem await the PNG capture itself.
  const png = captureShareImage(element);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/**
 * Saves the captured PNG. `title` is the user-facing name the card was built
 * from (a session title, a workspace name); `fallback` is the surface's own
 * stem, used when the title is empty or sanitizes away to nothing.
 */
export async function exportShareImage(
  element: HTMLElement,
  title: string | undefined,
  fallback: string
): Promise<void> {
  const blob = await captureShareImage(element);

  const name =
    (title?.trim() || fallback)
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
      .replace(/[. ]+$/g, '')
      .slice(0, 120) || fallback;
  const fileName = `${name}.png`;
  const bridge = getImagePreviewExportBridge();
  if (bridge) {
    const result = await bridge.saveAs({ fileName, bytes: await blob.arrayBuffer() });
    if (!result.saved && !result.canceled) throw new Error(result.error || 'Image save failed');
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the browser consume the download before releasing its bytes.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
