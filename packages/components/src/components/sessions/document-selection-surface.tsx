import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { SquareDashedMousePointer, X } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { DocumentSelectionTooltip as Tooltip } from './document-selection-tooltip';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import {
  captureDocumentRegion,
  documentSelectionLocation,
  MAX_SELECTION_TEXT,
  selectionRect,
  type DocumentSelection,
  type SelectionPoint,
  type SelectionRect,
} from '@/lib/document-selection';
import { DocumentSelectionEditor } from './document-selection-editor';

type ReadSelection = (signal: AbortSignal) => Promise<DocumentSelection>;
const SelectionContext = createContext<
  ((read: ReadSelection, anchor?: HTMLElement) => void) | undefined
>(undefined);
const CaptureContext = createContext<{ active: boolean; toggle: () => void } | null>(null);
export const useDocumentSelection = () => useContext(SelectionContext);

/** Occupies the reading toolbar's action slot; never creates another toolbar. */
export function DocumentCaptureButton() {
  const capture = useContext(CaptureContext);
  const { t } = useTranslation();
  if (!capture) return null;
  const label = capture.active
    ? t('common.cancel', 'Cancel')
    : t('sessions.fileViewer.selection.capture', 'Select screenshot area');
  return (
    <Tooltip content={label}>
      <Button
        size="mini"
        variant={capture.active ? 'secondary' : 'ghost'}
        icon
        aria-label={label}
        aria-pressed={capture.active}
        data-document-capture
        onClick={capture.toggle}
      >
        {capture.active ? (
          <X size={16} aria-hidden />
        ) : (
          <SquareDashedMousePointer size={16} aria-hidden />
        )}
      </Button>
    </Tooltip>
  );
}

type Measure = () => readonly DOMRect[];
interface Draft {
  readonly selection: DocumentSelection;
  readonly image?: HTMLCanvasElement;
  readonly measure?: Measure;
  readonly autoFocus: boolean;
}

// Keep the crop attached to the painted page while scrolling or changing zoom.
function regionAnchor(root: HTMLElement, region: SelectionRect): Measure {
  const bounds = root.getBoundingClientRect();
  const x = bounds.left + region.x,
    y = bounds.top + region.y;
  const pages = root.querySelectorAll<HTMLElement>(
    '.page[data-page-number], [data-docx-page-wrapper], [data-page-index][data-page], [data-lody-slide], [role="grid"]'
  );
  const page = Array.from(pages).find((node) => {
    const box = node.getBoundingClientRect();
    return (
      x + region.width / 2 >= box.left &&
      x + region.width / 2 <= box.right &&
      y + region.height / 2 >= box.top &&
      y + region.height / 2 <= box.bottom
    );
  });
  if (page) {
    const box = page.getBoundingClientRect();
    const offset = {
      x: (x - box.left) / box.width,
      y: (y - box.top) / box.height,
      width: region.width / box.width,
      height: region.height / box.height,
    };
    return () => {
      if (!page.isConnected) return [];
      const next = page.getBoundingClientRect();
      return [
        new DOMRect(
          next.left + offset.x * next.width,
          next.top + offset.y * next.height,
          offset.width * next.width,
          offset.height * next.height
        ),
      ];
    };
  }
  const scrollers = Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter((node) => node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
    .map((node) => ({ node, x: node.scrollLeft, y: node.scrollTop }));
  return () => {
    const next = root.getBoundingClientRect();
    const dx = scrollers.reduce((sum, entry) => sum + entry.node.scrollLeft - entry.x, 0);
    const dy = scrollers.reduce((sum, entry) => sum + entry.node.scrollTop - entry.y, 0);
    return [
      new DOMRect(next.left + region.x - dx, next.top + region.y - dy, region.width, region.height),
    ];
  };
}

const styles = stylex.create({
  root: {
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    position: 'relative',
    overflow: 'hidden',
    color: colors.label,
  },
  viewport: { position: 'relative', height: '100%', minHeight: 0, overflow: 'hidden' },
  fallback: {
    position: 'absolute',
    right: space[3],
    top: space[3],
    zIndex: 3,
    borderRadius: radius.small,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.raised,
  },
  overlay: { position: 'absolute', inset: 0, zIndex: 2, cursor: 'crosshair', touchAction: 'none' },
  rectangle: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.accent,
    pointerEvents: 'none',
    boxSizing: 'border-box',
  },
  highlight: {
    position: 'absolute',
    backgroundColor: colors.accent,
    opacity: 0.2,
    pointerEvents: 'none',
  },
  source: { position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', overflow: 'hidden' },
  popup: {
    position: 'absolute',
    zIndex: 3,
    width: 'min(340px, calc(100% - 24px))',
    maxHeight: 'calc(100% - 56px)',
    overflow: 'auto',
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.popover,
  },
  imagePopup: { width: 'min(420px, calc(100% - 24px))' },
  hint: {
    position: 'absolute',
    zIndex: 4,
    bottom: space[4],
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: 'calc(100% - 32px)',
    width: 'max-content',
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.small,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.popover,
    color: colors.secondaryLabel,
    fontSize: '0.75rem',
    pointerEvents: 'none',
  },
});

export function DocumentSelectionSurface({
  path,
  active,
  source,
  onAdd,
  children,
  standaloneCapture = false,
}: {
  readonly path: string;
  readonly active: boolean;
  readonly source: unknown;
  readonly onAdd?: (selection: DocumentSelection) => boolean;
  readonly children: ReactNode;
  readonly standaloneCapture?: boolean;
}) {
  const { t } = useTranslation();
  const locate = (root: HTMLElement, rect: SelectionRect) =>
    documentSelectionLocation(root, rect, {
      page: (page) => t('sessions.fileViewer.selection.page', 'Page {{page}}', { page }),
      slide: (slide) => t('sessions.fileViewer.selection.slide', 'Slide {{slide}}', { slide }),
      visible: t('sessions.fileViewer.selection.visible', 'Visible preview'),
    });
  const viewport = useRef<HTMLDivElement>(null);
  const editorHost = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const start = useRef<SelectionPoint | null>(null);
  const request = useRef<AbortController | null>(null);
  const [mode, setMode] = useState(false);
  const [captureRect, setCaptureRect] = useState<SelectionRect | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState<{
    left: number;
    top: number;
    visible: boolean;
    rects: SelectionRect[];
  }>({ left: 12, top: 48, visible: true, rects: [] });
  const enabled = Boolean(onAdd) && active;
  const cancelCapture = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setMode(false);
    setCaptureRect(null);
    start.current = null;
  }, []);
  const closeEditor = useCallback(() => {
    setDraft(null);
    dirty.current = false;
  }, []);
  const focusCapture = () =>
    viewport.current?.querySelector<HTMLButtonElement>('[data-document-capture]')?.focus();
  const relayout = useCallback(() => {
    const root = viewport.current,
      popup = editorHost.current;
    if (!root || !popup || !draft) return;
    const box = root.getBoundingClientRect();
    const rects = (draft.measure?.() ?? []).filter((rect) => rect.width > 0 && rect.height > 0);
    const visible = rects.filter(
      (rect) =>
        rect.bottom > box.top &&
        rect.top < box.bottom &&
        rect.right > box.left &&
        rect.left < box.right
    );
    const anchor = visible.at(-1);
    const height = popup.offsetHeight,
      width = popup.offsetWidth;
    const minTop = Math.max(
      12,
      (root.querySelector('[data-document-toolbar]')?.getBoundingClientRect().bottom ?? box.top) -
        box.top +
        8
    );
    const below = anchor ? anchor.bottom - box.top + 8 : minTop;
    const above = anchor ? anchor.top - box.top - height - 8 : below;
    let left = anchor ? anchor.left - box.left : 12;
    let top = below + height <= box.height - 12 ? below : above;
    if (
      draft.image &&
      above < minTop &&
      below + height > box.height - 12 &&
      anchor &&
      anchor.right - box.left + width + 20 <= box.width
    ) {
      left = anchor.right - box.left + 8;
      top = anchor.top - box.top;
    }
    setLayout({
      left: Math.max(12, Math.min(left, box.width - width - 12)),
      top: Math.max(minTop, Math.min(top, box.height - height - 12)),
      visible: draft.measure === undefined || visible.length > 0,
      rects: rects.map((rect) => ({
        x: rect.left - box.left,
        y: rect.top - box.top,
        width: rect.width,
        height: rect.height,
      })),
    });
  }, [draft]);
  useLayoutEffect(() => {
    relayout();
    if (!draft || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(relayout);
    if (viewport.current) observer.observe(viewport.current);
    if (editorHost.current) observer.observe(editorHost.current);
    viewport.current
      ?.querySelectorAll(
        '.page[data-page-number], [data-docx-page-wrapper], [data-page-index][data-page], [data-lody-slide]'
      )
      .forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [draft, relayout]);
  useEffect(() => {
    if (mode)
      viewport.current?.querySelector<HTMLElement>('[data-document-selection-overlay]')?.focus();
  }, [mode]);
  useEffect(() => {
    setDraft(null);
    setMode(false);
    setCaptureRect(null);
    setBusy(false);
    setError('');
    start.current = null;
    dirty.current = false;
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [path, source, active]);
  useEffect(() => {
    if (!draft) return undefined;
    const outside = (event: PointerEvent) => {
      if (
        !dirty.current &&
        event.button === 0 &&
        event.target instanceof Node &&
        editorHost.current?.contains(event.target) !== true
      )
        closeEditor();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [draft, closeEditor]);
  const prepare = useCallback(
    async (read: (signal: AbortSignal) => Promise<Draft>) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError('');
      try {
        const result = await read(controller.signal);
        if (!controller.signal.aborted) {
          if ((result.selection.text?.length ?? 0) > MAX_SELECTION_TEXT) throw new RangeError();
          dirty.current = false;
          setDraft(result);
          setMode(false);
          setCaptureRect(null);
        }
      } catch {
        if (!controller.signal.aborted)
          setError(
            t(
              'sessions.fileViewer.selection.captureFailed',
              'Could not prepare the selection. Select a smaller area and try again.'
            )
          );
      } finally {
        if (request.current === controller) {
          request.current = null;
          setBusy(false);
        }
      }
    },
    [t]
  );
  const readText = () => {
    if (!enabled || mode || busy || dirty.current) return;
    const root = viewport.current,
      selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer) ||
      editorHost.current?.contains(range.startContainer) === true ||
      range.startContainer.parentElement?.closest('[data-document-toolbar]')
    )
      return;
    const value = selection.toString().trim();
    if (!value) return;
    if (value.length > MAX_SELECTION_TEXT) {
      setError(
        t(
          'sessions.fileViewer.selection.captureFailed',
          'Could not prepare the selection. Select a smaller area and try again.'
        )
      );
      return;
    }
    const sourceRange = range.cloneRange(),
      box = range.getBoundingClientRect(),
      bounds = root.getBoundingClientRect();
    setDraft({
      selection: {
        path,
        location: locate(root, {
          x: box.left - bounds.left,
          y: box.top - bounds.top,
          width: box.width,
          height: box.height,
        }),
        text: value,
      },
      measure: () =>
        sourceRange.startContainer.isConnected ? Array.from(sourceRange.getClientRects()) : [],
      autoFocus: false,
    });
  };
  const point = (event: React.PointerEvent<HTMLElement>) => {
    const box = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const toolbar = viewport.current?.querySelector<HTMLElement>('[data-document-toolbar]');
  const overlayTop =
    toolbar && viewport.current
      ? toolbar.getBoundingClientRect().bottom - viewport.current.getBoundingClientRect().top
      : 0;
  const select = useCallback(
    (read: ReadSelection, anchor?: HTMLElement) => {
      void prepare(async (signal) => ({
        selection: await read(signal),
        measure: anchor
          ? () => (anchor.isConnected ? [anchor.getBoundingClientRect()] : [])
          : undefined,
        autoFocus: true,
      }));
    },
    [prepare]
  );
  const capture = useMemo(
    () =>
      enabled
        ? {
            active: mode,
            toggle: () => {
              if (mode) cancelCapture();
              else {
                closeEditor();
                window.getSelection()?.removeAllRanges();
                setError('');
                setMode(true);
              }
            },
          }
        : null,
    [enabled, mode, cancelCapture, closeEditor]
  );
  return (
    <SelectionContext.Provider value={enabled ? select : undefined}>
      <CaptureContext.Provider value={capture}>
        <div {...stylex.props(styles.root)}>
          <div
            ref={viewport}
            {...stylex.props(styles.viewport)}
            data-native-selection-allow
            onPointerUp={(event) => {
              if (
                event.target instanceof Node &&
                editorHost.current?.contains(event.target) !== true
              )
                readText();
            }}
            onKeyUp={(event) => {
              if (
                event.target instanceof Node &&
                editorHost.current?.contains(event.target) !== true
              )
                readText();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && (mode || draft)) {
                event.preventDefault();
                event.stopPropagation();
                cancelCapture();
                closeEditor();
                focusCapture();
              }
              if (draft && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
                event.preventDefault();
                editorHost.current?.querySelector('textarea')?.focus();
              }
            }}
            onScrollCapture={(event) => {
              if (
                event.target instanceof Node &&
                editorHost.current?.contains(event.target) === true
              )
                return;
              if (request.current) {
                cancelCapture();
              }
              relayout();
            }}
          >
            {children}
            {standaloneCapture && enabled ? (
              <div {...stylex.props(styles.fallback)}>
                <DocumentCaptureButton />
              </div>
            ) : null}
            {draft && enabled ? (
              <>
                <div {...stylex.props(styles.source)} data-document-selection-overlay aria-hidden>
                  {layout.rects.map((rect, index) => (
                    <div
                      key={index}
                      data-document-selection-highlight
                      {...stylex.props(draft.image ? styles.rectangle : styles.highlight)}
                      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
                    />
                  ))}
                </div>
                <div
                  ref={editorHost}
                  {...stylex.props(styles.popup, Boolean(draft.image) && styles.imagePopup)}
                  style={{
                    left: layout.left,
                    top: layout.top,
                    visibility: layout.visible ? 'visible' : 'hidden',
                  }}
                  data-document-selection-overlay
                >
                  <DocumentSelectionEditor
                    key={draft.selection.location + (draft.selection.text ?? '')}
                    selection={draft.selection}
                    image={draft.image}
                    allowMarkup={false}
                    autoFocus={draft.autoFocus}
                    onDirtyChange={(value) => {
                      dirty.current = value;
                    }}
                    onCancel={() => {
                      closeEditor();
                      focusCapture();
                    }}
                    onAdd={(selection) => {
                      const accepted = onAdd?.(selection) ?? false;
                      if (accepted) {
                        closeEditor();
                        window.getSelection()?.removeAllRanges();
                        focusCapture();
                      }
                      return accepted;
                    }}
                  />
                </div>
              </>
            ) : null}
            {enabled && mode ? (
              <div
                {...stylex.props(styles.overlay)}
                style={{ top: overlayTop }}
                data-document-selection-overlay
                tabIndex={0}
                role="region"
                aria-label={t('sessions.fileViewer.selection.area', 'Screenshot area selection')}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !event.isPrimary || busy) return;
                  event.preventDefault();
                  start.current = point(event);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setCaptureRect(null);
                }}
                onPointerMove={(event) => {
                  if (start.current && !busy)
                    setCaptureRect(
                      selectionRect(
                        start.current,
                        point(event),
                        viewport.current!.getBoundingClientRect()
                      )
                    );
                }}
                onPointerUp={(event) => {
                  const origin = start.current,
                    root = viewport.current;
                  start.current = null;
                  if (!origin || !root || busy) return;
                  const region = selectionRect(origin, point(event), root.getBoundingClientRect());
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  if (region.width < 4 || region.height < 4) {
                    setCaptureRect(null);
                    return;
                  }
                  const selection = { path, location: locate(root, region), region };
                  const measure = regionAnchor(root, region);
                  void prepare(async (signal) => ({
                    selection,
                    measure,
                    image: await captureDocumentRegion(root, region, signal),
                    autoFocus: true,
                  }));
                }}
                onPointerCancel={() => {
                  start.current = null;
                  setCaptureRect(null);
                }}
              >
                {captureRect ? (
                  <div
                    {...stylex.props(styles.rectangle)}
                    style={{
                      left: captureRect.x,
                      top: captureRect.y - overlayTop,
                      width: captureRect.width,
                      height: captureRect.height,
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          {mode || busy || error ? (
            <div
              {...stylex.props(styles.hint)}
              data-document-selection-overlay
              role={error ? 'alert' : 'status'}
            >
              {error ||
                (busy
                  ? t('sessions.fileViewer.selection.preparing', 'Preparing selection…')
                  : t(
                      'sessions.fileViewer.selection.dragHint',
                      'Drag an area to annotate. Escape cancels.'
                    ))}
            </div>
          ) : null}
        </div>
      </CaptureContext.Provider>
    </SelectionContext.Provider>
  );
}
