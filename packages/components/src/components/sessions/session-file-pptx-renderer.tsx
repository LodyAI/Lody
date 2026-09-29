import '@extend-ai/react-pptx/styles.css';
import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { ReactPptxViewer, setWasmSource, type ViewerZoomLevel } from '@extend-ai/react-pptx';
import wasmUrl from '@extend-ai/react-pptx/pptx_wasm_bg.wasm?url';
import { Button } from '@lody/ui/button';
import { Select } from '@lody/ui/select';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { SessionFileNoticeCard } from './session-file-error-state';
import { OfficeViewerFrame, officeFrameStyles } from './session-file-office-frame';

setWasmSource(wasmUrl);

const styles = stylex.create({
  viewer: { width: '100%', height: '100%', minHeight: 0 },
  loading: {
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    color: colors.secondaryLabel,
  },
});

const ZOOM_LEVELS = ['fit-page', 'fit-width', 'automatic', 50, 75, 100, 125, 150, 200] as const;

export function SessionFilePptxRenderer({
  buffer,
  fileActions,
}: {
  readonly buffer: ArrayBuffer;
  readonly path: string;
  readonly fileActions?: SessionFileErrorActions;
}) {
  const { t } = useTranslation();
  const [slide, setSlide] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [zoom, setZoom] = useState<ViewerZoomLevel>('fit-page');
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <SessionFileNoticeCard
        presentation={{
          title: t('sessions.fileViewer.office.failedTitle', 'Document preview unavailable'),
          description: t(
            'sessions.fileViewer.office.failedMessage',
            'This document could not be opened. Try opening it in the default app.'
          ),
        }}
        fileActions={fileActions}
      />
    );
  }
  const zoomOptions = ZOOM_LEVELS.map((level) => ({
    value: String(level),
    label:
      level === 'fit-page'
        ? t('sessions.fileViewer.pdf.fitPage', 'Fit page')
        : level === 'fit-width'
          ? t('sessions.fileViewer.pdf.fitWidth', 'Fit width')
          : level === 'automatic'
            ? t('sessions.fileViewer.pdf.automaticZoom', 'Automatic')
            : `${level}%`,
  }));
  return (
    <OfficeViewerFrame
      label={t('sessions.fileViewer.office.pptxViewer', 'PowerPoint viewer')}
      toolbar={
        <>
          <div {...stylex.props(officeFrameStyles.group)}>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              aria-label={t('sessions.fileViewer.office.previousSlide', 'Previous slide')}
              disabled={slide <= 0}
              onClick={() => setSlide((current) => current - 1)}
            >
              <ChevronLeft size={16} aria-hidden />
            </Button>
            <span {...stylex.props(officeFrameStyles.label)} aria-live="polite">
              {t('sessions.fileViewer.office.slideCount', '{{current}} of {{count}}', {
                current: slide + 1,
                count: slideCount,
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              aria-label={t('sessions.fileViewer.office.nextSlide', 'Next slide')}
              disabled={slideCount === 0 || slide >= slideCount - 1}
              onClick={() => setSlide((current) => current + 1)}
            >
              <ChevronRight size={16} aria-hidden />
            </Button>
          </div>
          <span {...stylex.props(officeFrameStyles.spacer)} />
          <div {...stylex.props(officeFrameStyles.group)}>
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              aria-label={t('sessions.fileViewer.pdf.zoomOut', 'Zoom out')}
              disabled={slideCount === 0}
              onClick={() =>
                setZoom((current) =>
                  Math.max(25, (typeof current === 'number' ? current : 100) - 25)
                )
              }
            >
              <ZoomOut size={16} aria-hidden />
            </Button>
            <span {...stylex.props(officeFrameStyles.zoom)}>
              <Select.Root
                items={zoomOptions}
                value={String(zoom)}
                onValueChange={(value) => {
                  if (value)
                    setZoom(
                      Number.isNaN(Number(value)) ? (value as ViewerZoomLevel) : Number(value)
                    );
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
              disabled={slideCount === 0}
              onClick={() =>
                setZoom((current) =>
                  Math.min(200, (typeof current === 'number' ? current : 100) + 25)
                )
              }
            >
              <ZoomIn size={16} aria-hidden />
            </Button>
          </div>
        </>
      }
    >
      <div {...stylex.props(styles.viewer)}>
        <ReactPptxViewer
          source={buffer}
          mode="continuous"
          slideIndex={slide}
          zoom={zoom}
          height="100%"
          showToolbar={false}
          showThumbnails
          virtualization
          onLoad={(presentation) => setSlideCount(presentation.document.slides.length)}
          onSlideChange={setSlide}
          onError={() => setFailed(true)}
          renderLoading={() => (
            <div {...stylex.props(styles.loading)} role="status">
              <Spinner label={null} />
              {t('sessions.fileViewer.office.loading', 'Loading document…')}
            </div>
          )}
        />
      </div>
    </OfficeViewerFrame>
  );
}
