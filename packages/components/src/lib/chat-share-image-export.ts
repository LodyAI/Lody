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

export async function exportChatShareImage(element: HTMLElement, title?: string): Promise<void> {
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
    });
  } finally {
    restoreLists();
  }
  if (blob.type !== 'image/png' || blob.size === 0) throw new Error('PNG encoding failed');

  const name =
    (title?.trim() || 'lody-conversation')
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
      .replace(/[. ]+$/g, '')
      .slice(0, 120) || 'lody-conversation';
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
