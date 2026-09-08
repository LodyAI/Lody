import { getImagePreviewExportBridge } from './image-preview-export';

export async function exportChatShareImage(element: HTMLElement, title?: string): Promise<void> {
  await document.fonts.ready;
  await Promise.all(Array.from(element.querySelectorAll('img')).map((image) => image.decode()));
  const { snapdom } = await import('@zumer/snapdom');
  // Capture the natural-size card inside the scaled preview, without its scroll container.
  const blob = await snapdom.toBlob(element, {
    type: 'png',
    scale: 2,
    dpr: 1,
    embedFonts: true,
    compress: false,
  });
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
