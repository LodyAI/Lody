import '@/lib/pdfjs-viewer-global';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDataRangeTransport,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  RotateCcw,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Select } from '@lody/ui/select';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { createLocalPdfRangeTransport, PDF_RANGE_CHUNK_BYTES } from '@/lib/pdf-file-preview';
import { SessionFileNoticeCard } from './session-file-error-state';
import { SessionFilePdfThumbnails } from './session-file-pdf-thumbnails';

const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const ZOOM_PRESETS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const FIT_MODES = ['page-fit', 'page-width', 'auto'] as const;

function isFitMode(value: string): value is (typeof FIT_MODES)[number] {
  return FIT_MODES.some((mode) => mode === value);
}

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    color: colors.label,
    backgroundColor: colors.background,
  },
  toolbar: {
    display: 'flex',
    flex: '0 0 auto',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  group: { display: 'inline-flex', alignItems: 'center', gap: space[1], flexShrink: 0 },
  spacer: { flex: '1 1 auto' },
  pageInputWell: { width: '3.5rem' },
  zoomSelect: { minWidth: '6rem' },
  pageCount: { flexShrink: 0, color: colors.secondaryLabel, fontSize: '0.75rem' },
  findGroup: {
    display: 'flex',
    flex: '1 1 100%',
    minWidth: 0,
    alignItems: 'center',
    gap: space[1],
  },
  findInputWell: { minWidth: '8rem', flex: '1 1 auto' },
  matches: {
    minWidth: '2rem',
    color: colors.secondaryLabel,
    fontSize: '0.75rem',
    textAlign: 'center',
  },
  body: { display: 'flex', flex: '1 1 auto', minHeight: 0, minWidth: 0 },
  documentArea: { position: 'relative', flex: '1 1 auto', minHeight: 0, minWidth: 0 },
  canvas: {
    position: 'absolute',
    inset: 0,
    overflow: 'auto',
    backgroundColor: colors.secondaryBackground,
  },
  viewer: { minHeight: '100%' },
  loading: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    color: colors.secondaryLabel,
    fontSize: '0.875rem',
    backgroundColor: colors.secondaryBackground,
  },
  spinner: { width: '1rem', height: '1rem' },
});

interface SessionFilePdfPreviewProps {
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly fileActions?: SessionFileErrorActions;
}

interface PageChangingEvent {
  readonly pageNumber: number;
}

interface ScaleChangingEvent {
  readonly scale: number;
  readonly presetValue?: string;
}

interface RotationChangingEvent {
  readonly pagesRotation: number;
}

interface FindMatchesCountEvent {
  readonly matchesCount: { readonly current: number; readonly total: number };
}

export function SessionFilePdfPreview({ bytes, url, fileActions }: SessionFilePdfPreviewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElementRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [zoomValue, setZoomValue] = useState('page-width');
  const [rotation, setRotation] = useState(0);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [matchesCount, setMatchesCount] = useState({ current: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const hasSource = url !== undefined || bytes !== undefined;

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerElementRef.current;
    if (!container || !viewerElement || !hasSource) return undefined;

    let disposed = false;
    let rangeTransport: PDFDataRangeTransport | undefined;
    let loadingTask: ReturnType<typeof getDocument> | undefined;
    const abortController = new AbortController();
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
    });
    const findController = new PDFFindController({ eventBus, linkService });
    const pdfViewer = new PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
      textLayerMode: 1,
    });
    linkService.setViewer(pdfViewer);
    viewerRef.current = pdfViewer;
    eventBusRef.current = eventBus;

    const handlePageChanging = (event: PageChangingEvent) => {
      setPageNumber(event.pageNumber);
      setPageInput(String(event.pageNumber));
    };
    const handleScaleChanging = (event: ScaleChangingEvent) => {
      setZoom(event.scale);
      setZoomValue(
        event.presetValue !== undefined && isFitMode(event.presetValue)
          ? event.presetValue
          : String(Math.round(event.scale * 100))
      );
    };
    const handleRotationChanging = (event: RotationChangingEvent) =>
      setRotation(event.pagesRotation);
    const handlePagesInit = () => {
      pdfViewer.currentScaleValue = 'page-width';
      setPageCount(pdfViewer.pagesCount);
    };
    const handleFindMatchesCount = (event: FindMatchesCountEvent) =>
      setMatchesCount(event.matchesCount);

    eventBus.on('pagechanging', handlePageChanging);
    eventBus.on('scalechanging', handleScaleChanging);
    eventBus.on('rotationchanging', handleRotationChanging);
    eventBus.on('pagesinit', handlePagesInit);
    eventBus.on('updatefindmatchescount', handleFindMatchesCount);
    eventBus.on('updatefindcontrolstate', handleFindMatchesCount);

    setLoading(true);
    setLoadError(false);
    setPageNumber(1);
    setPageInput('1');
    setPageCount(0);
    setZoom(null);
    setZoomValue('page-width');
    setRotation(0);
    setPdfDocument(null);
    setMatchesCount({ current: 0, total: 0 });

    void (async () => {
      try {
        let source: { data: Uint8Array } | { range: PDFDataRangeTransport } | { url: string };
        if (bytes !== undefined) {
          source = { data: bytes.slice() };
        } else if (url !== undefined && url.startsWith('lody-resource://')) {
          rangeTransport = await createLocalPdfRangeTransport({
            url,
            signal: abortController.signal,
          });
          source = { range: rangeTransport };
        } else if (url !== undefined) {
          source = { url };
        } else {
          throw new Error('PDF source is missing.');
        }
        if (disposed) {
          rangeTransport?.abort();
          return;
        }

        loadingTask = getDocument({
          ...source,
          disableStream: true,
          disableAutoFetch: true,
          rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
        });
        const loadedDocument = await loadingTask.promise;
        if (disposed) {
          return;
        }
        linkService.setDocument(loadedDocument);
        pdfViewer.setDocument(loadedDocument);
        setPdfDocument(loadedDocument);
        setLoading(false);
      } catch {
        if (!disposed) {
          setLoading(false);
          setLoadError(true);
        }
      }
    })();

    return () => {
      disposed = true;
      abortController.abort();
      rangeTransport?.abort();
      eventBus.off('pagechanging', handlePageChanging);
      eventBus.off('scalechanging', handleScaleChanging);
      eventBus.off('rotationchanging', handleRotationChanging);
      eventBus.off('pagesinit', handlePagesInit);
      eventBus.off('updatefindmatchescount', handleFindMatchesCount);
      eventBus.off('updatefindcontrolstate', handleFindMatchesCount);
      pdfViewer.cleanup();
      viewerElement.replaceChildren();
      viewerRef.current = null;
      eventBusRef.current = null;
      if (loadingTask) void loadingTask.destroy().catch(() => {});
    };
  }, [bytes, hasSource, url]);

  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && isFitMode(zoomValue)) {
      viewer.currentScaleValue = zoomValue;
    }
  }, [pagesOpen, zoomValue]);

  useEffect(() => {
    if (searchOpen) findInputRef.current?.focus();
  }, [searchOpen]);

  const commitPageInput = () => {
    const nextPage = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(nextPage) || pageCount === 0) {
      setPageInput(String(pageNumber));
      return;
    }
    const boundedPage = Math.min(pageCount, Math.max(1, nextPage));
    if (viewerRef.current) viewerRef.current.currentPageNumber = boundedPage;
    setPageInput(String(boundedPage));
  };

  const changeZoom = (amount: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.currentScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewer.currentScale + amount));
  };

  const selectZoom = (value: string) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.currentScaleValue = isFitMode(value) ? value : String(Number(value) / 100);
  };

  const rotate = (degrees: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const currentPage = viewer.currentPageNumber;
    viewer.pagesRotation = (viewer.pagesRotation + degrees + 360) % 360;
    viewer.currentPageNumber = currentPage;
  };

  const dispatchFind = (type: 'find' | 'again', findPrevious = false) => {
    const query = findInputRef.current?.value.trim() ?? '';
    const eventBus = eventBusRef.current;
    if (!eventBus || (type === 'again' && query.length === 0)) return;
    eventBus.dispatch('find', {
      source: findInputRef.current,
      type,
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
    });
  };

  const closeSearch = () => {
    if (findInputRef.current) findInputRef.current.value = '';
    dispatchFind('find');
    setMatchesCount({ current: 0, total: 0 });
    setSearchOpen(false);
  };

  if (!hasSource || loadError) {
    return (
      <SessionFileNoticeCard
        presentation={{
          title: t('sessions.fileViewer.pdf.failedTitle', 'PDF preview unavailable'),
          description: t(
            'sessions.fileViewer.pdf.failedMessage',
            'This PDF could not be opened. Try opening it in the default app.'
          ),
        }}
        fileActions={fileActions}
      />
    );
  }

  const zoomOptions = [
    { value: 'page-fit', label: t('sessions.fileViewer.pdf.fitPage', 'Fit page') },
    { value: 'page-width', label: t('sessions.fileViewer.pdf.fitWidth', 'Fit width') },
    { value: 'auto', label: t('sessions.fileViewer.pdf.automaticZoom', 'Automatic') },
    ...ZOOM_PRESETS.map((value) => ({ value: String(value * 100), label: `${value * 100}%` })),
  ];
  if (zoom !== null && !zoomOptions.some((option) => option.value === zoomValue)) {
    zoomOptions.push({ value: zoomValue, label: `${zoomValue}%` });
  }

  return (
    <section
      {...stylex.props(styles.root)}
      aria-label={t('sessions.fileViewer.pdf.viewer', 'PDF viewer')}
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          setSearchOpen(true);
        }
      }}
    >
      <div {...stylex.props(styles.toolbar)}>
        <div {...stylex.props(styles.group)}>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.pagesSidebar', 'Pages sidebar')}
            title={t('sessions.fileViewer.pdf.pagesSidebar', 'Pages sidebar')}
            aria-pressed={pagesOpen}
            disabled={pageCount === 0}
            onClick={() => setPagesOpen((open) => !open)}
          >
            <PanelLeft size={16} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.previousPage', 'Previous page')}
            title={t('sessions.fileViewer.pdf.previousPage', 'Previous page')}
            disabled={pageCount === 0 || pageNumber <= 1}
            onClick={() => {
              if (viewerRef.current) viewerRef.current.currentPageNumber = pageNumber - 1;
            }}
          >
            <ChevronLeft size={16} aria-hidden />
          </Button>
          <span {...stylex.props(styles.pageInputWell)}>
            <Input
              type="number"
              size="small"
              min={1}
              max={pageCount || undefined}
              value={pageInput}
              disabled={pageCount === 0}
              aria-label={t('sessions.fileViewer.pdf.pageNumber', 'Page number')}
              onChange={(event) => setPageInput(event.currentTarget.value)}
              onBlur={commitPageInput}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitPageInput();
              }}
            />
          </span>
          <span {...stylex.props(styles.pageCount)} aria-live="polite">
            {pageCount === 0
              ? t('sessions.fileViewer.pdf.pageCountUnknown', 'of —')
              : t('sessions.fileViewer.pdf.pageCount', 'of {{count}}', { count: pageCount })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.nextPage', 'Next page')}
            title={t('sessions.fileViewer.pdf.nextPage', 'Next page')}
            disabled={pageCount === 0 || pageNumber >= pageCount}
            onClick={() => {
              if (viewerRef.current) viewerRef.current.currentPageNumber = pageNumber + 1;
            }}
          >
            <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
        <div {...stylex.props(styles.group)}>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.rotateLeft', 'Rotate counterclockwise')}
            title={t('sessions.fileViewer.pdf.rotateLeft', 'Rotate counterclockwise')}
            disabled={pageCount === 0}
            onClick={() => rotate(-90)}
          >
            <RotateCcw size={16} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.rotateRight', 'Rotate clockwise')}
            title={t('sessions.fileViewer.pdf.rotateRight', 'Rotate clockwise')}
            disabled={pageCount === 0}
            onClick={() => rotate(90)}
          >
            <RotateCw size={16} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.zoomOut', 'Zoom out')}
            title={t('sessions.fileViewer.pdf.zoomOut', 'Zoom out')}
            disabled={zoom === null || zoom <= MIN_ZOOM}
            onClick={() => changeZoom(-ZOOM_STEP)}
          >
            <ZoomOut size={16} aria-hidden />
          </Button>
          <span {...stylex.props(styles.zoomSelect)}>
            <Select.Root
              items={zoomOptions}
              value={zoomValue}
              disabled={zoom === null}
              onValueChange={(value) => {
                if (value != null) selectZoom(value);
              }}
            >
              <Select.Trigger
                size="small"
                aria-label={t('sessions.fileViewer.pdf.zoomLevel', 'Zoom level')}
              >
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {zoomOptions.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.zoomIn', 'Zoom in')}
            title={t('sessions.fileViewer.pdf.zoomIn', 'Zoom in')}
            disabled={zoom === null || zoom >= MAX_ZOOM}
            onClick={() => changeZoom(ZOOM_STEP)}
          >
            <ZoomIn size={16} aria-hidden />
          </Button>
        </div>
        <span {...stylex.props(styles.spacer)} />
        <Button
          type="button"
          variant="ghost"
          size="mini"
          icon
          aria-label={t('sessions.fileViewer.pdf.search', 'Search document')}
          title={t('sessions.fileViewer.pdf.search', 'Search document')}
          aria-expanded={searchOpen}
          disabled={pageCount === 0}
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        >
          <Search size={16} aria-hidden />
        </Button>
        {searchOpen ? (
          <form
            {...stylex.props(styles.findGroup)}
            onSubmit={(event) => {
              event.preventDefault();
              dispatchFind('find');
            }}
          >
            <span {...stylex.props(styles.findInputWell)}>
              <Input
                ref={findInputRef}
                type="search"
                size="small"
                placeholder={t('sessions.fileViewer.pdf.find', 'Find in document')}
                aria-label={t('sessions.fileViewer.pdf.find', 'Find in document')}
                disabled={pageCount === 0}
                onChange={() => dispatchFind('find')}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
              />
            </span>
            <span {...stylex.props(styles.matches)} aria-live="polite">
              {matchesCount.total > 0 ? `${matchesCount.current}/${matchesCount.total}` : ''}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              aria-label={t('sessions.fileViewer.pdf.previousMatch', 'Previous match')}
              disabled={matchesCount.total === 0}
              onClick={() => dispatchFind('again', true)}
            >
              <ArrowUp size={16} aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              aria-label={t('sessions.fileViewer.pdf.nextMatch', 'Next match')}
              disabled={matchesCount.total === 0}
              onClick={() => dispatchFind('again')}
            >
              <ArrowDown size={16} aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              aria-label={t('sessions.fileViewer.pdf.closeSearch', 'Close search')}
              onClick={closeSearch}
            >
              <X size={16} aria-hidden />
            </Button>
          </form>
        ) : null}
      </div>
      <div {...stylex.props(styles.body)}>
        {pagesOpen && pdfDocument && pageCount > 0 ? (
          <SessionFilePdfThumbnails
            document={pdfDocument}
            pageCount={pageCount}
            currentPage={pageNumber}
            rotation={rotation}
            onSelectPage={(page) => {
              if (viewerRef.current) viewerRef.current.currentPageNumber = page;
            }}
          />
        ) : null}
        <div {...stylex.props(styles.documentArea)}>
          <div ref={containerRef} {...stylex.props(styles.canvas)}>
            <div
              ref={viewerElementRef}
              {...withClassName(stylex.props(styles.viewer), 'pdfViewer')}
            />
          </div>
          {loading ? (
            <div {...stylex.props(styles.loading)} role="status">
              <span {...stylex.props(styles.spinner)}>
                <Spinner label={null} />
              </span>
              <span>{t('sessions.fileViewer.pdf.loading', 'Loading PDF…')}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
