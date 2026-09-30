import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut } from 'lucide-react';
import {
  parseDocxForViewer,
  ReactDocxViewer,
  setWasmSource,
  type ParsedDocxDocument,
  type ViewerZoomLevel,
} from '@extend-ai/react-docx';
import wasmUrl from '@extend-ai/react-docx/docx_wasm_bg.wasm?url';
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
  pageHost: { minHeight: '100%', padding: space[4], color: colors.label },
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

export function SessionFileDocxRenderer({
  buffer,
  path,
  fileActions,
}: {
  readonly buffer: ArrayBuffer;
  readonly path: string;
  readonly fileActions?: SessionFileErrorActions;
}) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<ParsedDocxDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<ViewerZoomLevel>('fit-width');

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setDocument(null);
    setFailed(false);
    void parseDocxForViewer(buffer, {
      signal: controller.signal,
      useWorker: 'required',
      loadEmbeddedFonts: 'defer',
      fileName: path.split('/').pop(),
    }).then(
      (parsed) => {
        if (disposed) parsed.dispose();
        else setDocument(parsed);
      },
      () => {
        if (!disposed) setFailed(true);
      }
    );
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [buffer, path]);

  useEffect(() => () => document?.dispose(), [document]);

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
      label={t('sessions.fileViewer.office.docxViewer', 'DOCX viewer')}
      toolbar={
        <div {...stylex.props(officeFrameStyles.group)}>
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            aria-label={t('sessions.fileViewer.pdf.zoomOut', 'Zoom out')}
            disabled={!document}
            onClick={() =>
              setZoom((current) => Math.max(25, (typeof current === 'number' ? current : 100) - 25))
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
                  setZoom(Number.isNaN(Number(value)) ? (value as ViewerZoomLevel) : Number(value));
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
            disabled={!document}
            onClick={() =>
              setZoom((current) =>
                Math.min(200, (typeof current === 'number' ? current : 100) + 25)
              )
            }
          >
            <ZoomIn size={16} aria-hidden />
          </Button>
        </div>
      }
    >
      {document ? (
        <div {...stylex.props(styles.pageHost)} data-native-selection-allow>
          <ReactDocxViewer document={document} zoom={zoom} />
        </div>
      ) : (
        <div {...stylex.props(styles.loading)} role="status">
          <Spinner label={null} />
          {t('sessions.fileViewer.office.loading', 'Loading document…')}
        </div>
      )}
    </OfficeViewerFrame>
  );
}
