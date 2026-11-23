import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';

const ROW_HEIGHT = 190;
const THUMB_WIDTH = 112;
const THUMB_HEIGHT = 148;
const OVERSCAN = 3;

const styles = stylex.create({
  sidebar: {
    position: 'relative',
    flex: '0 0 172px',
    minWidth: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.separator,
    backgroundColor: colors.secondaryBackground,
  },
  listSpace: (height: number) => ({ position: 'relative', height }),
  row: (top: number) => ({
    position: 'absolute',
    top,
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    padding: space[2],
  }),
  item: {
    display: 'flex',
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radius.medium,
    backgroundColor: 'transparent',
    color: colors.secondaryLabel,
    cursor: 'pointer',
    ':hover': { backgroundColor: colors.hoverFill },
    ':focus-visible': { outlineWidth: '2px', outlineStyle: 'solid', outlineColor: colors.accent },
  },
  selected: {
    borderColor: colors.separator,
    backgroundColor: colors.selectedFill,
    color: colors.label,
  },
  page: {
    display: 'flex',
    width: '120px',
    height: '150px',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: colors.background,
    boxShadow: shadow.card,
  },
  canvas: (width: number, height: number) => ({ display: 'block', width, height }),
  pageNumber: { fontSize: '0.75rem', lineHeight: '1rem' },
});

function PdfThumbnail({
  document,
  pageNumber,
  rotation,
}: {
  readonly document: PDFDocumentProxy;
  readonly pageNumber: number;
  readonly rotation: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: THUMB_WIDTH, height: THUMB_HEIGHT });

  useEffect(() => {
    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null =
      null;

    void (async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (disposed || !canvasRef.current) return;
        const canvas = canvasRef.current;
        const unscaled = page.getViewport({ scale: 1, rotation });
        const displayScale = Math.min(THUMB_WIDTH / unscaled.width, THUMB_HEIGHT / unscaled.height);
        const viewport = page.getViewport({
          scale: displayScale * Math.min(window.devicePixelRatio || 1, 2),
          rotation,
        });
        setDimensions({
          width: Math.round(unscaled.width * displayScale),
          height: Math.round(unscaled.height * displayScale),
        });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) return;
        renderTask = page.render({ canvas, canvasContext: context, viewport });
        await renderTask.promise;
      } catch {
        // A thumbnail may be cancelled as its virtual row leaves view.
      }
    })();

    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, rotation]);

  return (
    <canvas
      ref={canvasRef}
      {...stylex.props(styles.canvas(dimensions.width, dimensions.height))}
      aria-hidden="true"
    />
  );
}

export function SessionFilePdfThumbnails({
  document,
  pageCount,
  currentPage,
  rotation,
  onSelectPage,
}: {
  readonly document: PDFDocumentProxy;
  readonly pageCount: number;
  readonly currentPage: number;
  readonly rotation: number;
  readonly onSelectPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const sidebarRef = useRef<HTMLElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return undefined;
    const observer = new ResizeObserver(() => setHeight(sidebar.clientHeight));
    observer.observe(sidebar);
    setHeight(sidebar.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const top = (currentPage - 1) * ROW_HEIGHT;
    if (top < sidebar.scrollTop || top + ROW_HEIGHT > sidebar.scrollTop + sidebar.clientHeight) {
      sidebar.scrollTop = Math.max(0, top - ROW_HEIGHT);
    }
  }, [currentPage]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(pageCount, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  return (
    <aside
      ref={sidebarRef}
      {...stylex.props(styles.sidebar)}
      aria-label={t('sessions.fileViewer.pdf.pages', 'Pages')}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div {...stylex.props(styles.listSpace(pageCount * ROW_HEIGHT))}>
        {Array.from({ length: last - first }, (_, index) => {
          const page = first + index + 1;
          return (
            <div key={page} {...stylex.props(styles.row((page - 1) * ROW_HEIGHT))}>
              <button
                type="button"
                {...stylex.props(styles.item, page === currentPage && styles.selected)}
                aria-label={t('sessions.fileViewer.pdf.goToPage', 'Go to page {{page}}', { page })}
                aria-current={page === currentPage ? 'page' : undefined}
                onClick={() => onSelectPage(page)}
              >
                <span {...stylex.props(styles.page)}>
                  <PdfThumbnail document={document} pageNumber={page} rotation={rotation} />
                </span>
                <span {...stylex.props(styles.pageNumber)}>{page}</span>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
