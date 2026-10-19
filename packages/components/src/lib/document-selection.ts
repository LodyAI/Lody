export interface DocumentSelection {
  readonly path: string;
  readonly location: string;
  readonly text?: string;
  /** Coordinates relative to the visible preview, before screenshot encoding. */
  readonly region?: SelectionRect;
  readonly comment?: string;
  readonly image?: File;
}

export interface SelectionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type SelectionPoint = { readonly x: number; readonly y: number };
export type ImageMarkup = {
  readonly tool: 'pen' | 'rectangle' | 'arrow';
  readonly points: readonly SelectionPoint[];
};
export const MAX_SELECTION_TEXT = 50_000;
export const MAX_SELECTION_PIXELS = 4 * 1024 * 1024;

export function selectionRect(
  start: SelectionPoint,
  end: SelectionPoint,
  bounds: { width: number; height: number }
): SelectionRect {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
  const x1 = clamp(start.x, bounds.width),
    y1 = clamp(start.y, bounds.height);
  const x2 = clamp(end.x, bounds.width),
    y2 = clamp(end.y, bounds.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x1 - x2),
    height: Math.abs(y1 - y2),
  };
}

/** Source context is expanded through the existing pasted-text draft on submit. */
export function formatDocumentSelection(selection: DocumentSelection): string {
  const text = selection.text?.trim() ?? '';
  const comment = selection.comment?.trim() ?? '';
  if (
    !selection.path ||
    text.length > MAX_SELECTION_TEXT ||
    (selection.comment?.length ?? 0) > 10_000
  )
    throw new RangeError('Document selection is too large');
  return [
    'Document selection',
    `File: ${selection.path}`,
    `Location: ${selection.location}`,
    ...(selection.region ? [`Visible region: ${JSON.stringify(selection.region)}`] : []),
    ...(text ? ['Selected content:', text] : []),
    ...(selection.image ? [`Annotated image: ${selection.image.name}`] : []),
    ...(comment.length > 0 ? ['Comment:', comment] : []),
  ].join('\n');
}

export function documentSelectionLocation(
  root: HTMLElement,
  rect: SelectionRect,
  labels = {
    page: (number: number) => `Page ${number}`,
    slide: (number: number) => `Slide ${number}`,
    visible: 'Visible preview',
  }
): string {
  const origin = root.getBoundingClientRect();
  const labelsFound = new Set<string>();
  for (const page of root.querySelectorAll<HTMLElement>(
    '.page[data-page-number], [data-docx-page-wrapper="true"][data-index], [data-page-index][data-page], [data-lody-slide]'
  )) {
    const box = page.getBoundingClientRect();
    if (
      box.right <= origin.left + rect.x ||
      box.left >= origin.left + rect.x + rect.width ||
      box.bottom <= origin.top + rect.y ||
      box.top >= origin.top + rect.y + rect.height
    )
      continue;
    const pdf = page.dataset.pageNumber ?? page.dataset.page,
      docx = page.dataset.index,
      slide = page.dataset.lodySlide;
    labelsFound.add(
      slide !== undefined
        ? labels.slide(Number(slide) + 1)
        : labels.page(Number(pdf ?? Number(docx) + 1))
    );
  }
  return [...labelsFound].join(', ') || labels.visible;
}

export async function captureDocumentRegion(
  root: HTMLElement,
  rect: SelectionRect,
  signal: AbortSignal
): Promise<HTMLCanvasElement> {
  signal.throwIfAborted();
  if (rect.width < 2 || rect.height < 2 || rect.width * rect.height > MAX_SELECTION_PIXELS)
    throw new RangeError('Invalid capture dimensions');
  const bounds = root.getBoundingClientRect();
  const density = root.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  const pixelRatio = Math.min(
    Number.isFinite(density) ? Math.max(1, density) : 1,
    Math.sqrt(MAX_SELECTION_PIXELS / (rect.width * rect.height))
  );
  const { snapdom } = await import('@zumer/snapdom');
  signal.throwIfAborted();
  const view = root.ownerDocument.defaultView;
  const clip = {
    x: bounds.left + (view?.scrollX ?? 0) + rect.x,
    y: bounds.top + (view?.scrollY ?? 0) + rect.y,
    width: rect.width,
    height: rect.height,
  };
  const capture = (target: HTMLElement, area: SelectionRect) =>
    snapdom.toCanvas(target, {
      clip: area,
      scale: 1,
      dpr: pixelRatio,
      compress: false,
      cache: 'disabled',
      embedFonts: true,
      exclude: ['[data-document-selection-overlay]'],
    });
  // Cloning the surrounding auto-centered reader can reflow page margins. Keep
  // each PDF page in its own fixed coordinate system, including its DOM layers.
  const pages = Array.from(root.querySelectorAll<HTMLElement>('.page[data-page-number]')).flatMap(
    (page) => {
      const box = page.getBoundingClientRect();
      const x = Math.max(clip.x, box.left + (view?.scrollX ?? 0));
      const y = Math.max(clip.y, box.top + (view?.scrollY ?? 0));
      const right = Math.min(clip.x + clip.width, box.right + (view?.scrollX ?? 0));
      const bottom = Math.min(clip.y + clip.height, box.bottom + (view?.scrollY ?? 0));
      return right > x && bottom > y
        ? [{ page, area: { x, y, width: right - x, height: bottom - y } }]
        : [];
    }
  );
  const singlePage =
    pages.length === 1 && pages[0].area.width === clip.width && pages[0].area.height === clip.height
      ? pages[0]
      : undefined;
  const canvas = await capture(singlePage?.page ?? root, clip);
  signal.throwIfAborted();
  if (!singlePage && pages.length > 0) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not compose document pages');
    context.resetTransform();
    for (const { page, area } of pages) {
      const patch = await capture(page, area);
      signal.throwIfAborted();
      context.drawImage(
        patch,
        ((area.x - clip.x) * canvas.width) / clip.width,
        ((area.y - clip.y) * canvas.height) / clip.height,
        (area.width * canvas.width) / clip.width,
        (area.height * canvas.height) / clip.height
      );
    }
  }
  signal.throwIfAborted();
  if (
    !root.isConnected ||
    !canvas.width ||
    !canvas.height ||
    canvas.width * canvas.height > MAX_SELECTION_PIXELS
  )
    throw new Error('Preview changed during capture');
  // Bitmap density must not change the size of the selection in the editor.
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  return canvas;
}

export function drawImageMarkup(
  context: CanvasRenderingContext2D,
  marks: readonly ImageMarkup[],
  pixelRatio = 1
): void {
  context.save();
  context.strokeStyle = '#dc2626';
  context.lineWidth = 3 * pixelRatio;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const mark of marks) {
    const start = mark.points.at(0),
      end = mark.points.at(-1);
    if (start === undefined || end === undefined) continue;
    context.beginPath();
    if (mark.tool === 'rectangle') context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
    else {
      context.moveTo(start.x, start.y);
      if (mark.tool === 'pen') for (const point of mark.points) context.lineTo(point.x, point.y);
      else {
        context.lineTo(end.x, end.y);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        for (const delta of [-Math.PI / 6, Math.PI / 6]) {
          context.moveTo(end.x, end.y);
          context.lineTo(
            end.x - 12 * pixelRatio * Math.cos(angle + delta),
            end.y - 12 * pixelRatio * Math.sin(angle + delta)
          );
        }
      }
    }
    context.stroke();
  }
  context.restore();
}

export async function encodeSelectionImage(canvas: HTMLCanvasElement, path: string): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null || blob.size === 0) throw new Error('Could not encode selection image');
  const basename = path.split(/[\\/]/).at(-1) ?? '';
  return new File([blob], `${basename.length > 0 ? basename : 'document'}-selection.png`, {
    type: 'image/png',
  });
}

/** Existing attachments supply their own bytes; no desktop capture or remote fetch. */
export async function selectionImageCanvas(
  file: File,
  signal: AbortSignal
): Promise<HTMLCanvasElement> {
  signal.throwIfAborted();
  const image = await createImageBitmap(file);
  try {
    signal.throwIfAborted();
    const scale = Math.min(1, Math.sqrt(MAX_SELECTION_PIXELS / (image.width * image.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(image.width * scale));
    canvas.height = Math.max(1, Math.floor(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image markup canvas unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    image.close();
  }
}
