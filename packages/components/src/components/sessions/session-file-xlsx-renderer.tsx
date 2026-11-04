import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, MessageSquarePlus, ZoomIn, ZoomOut } from 'lucide-react';
import {
  setWasmSource,
  useXlsxViewerController,
  XlsxViewer,
  type XlsxViewerController,
} from '@extend-ai/react-xlsx';
import wasmUrl from '@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url';
import { DocumentSelectionTooltip as Tooltip } from './document-selection-tooltip';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useResolvedTheme } from '@/theme-provider';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { SessionFileNoticeCard } from './session-file-error-state';
import { OfficeViewerFrame, officeFrameStyles } from './session-file-office-frame';
import { writeSpreadsheetClipboard } from './session-file-spreadsheet-clipboard';
import {
  readXlsxSelectionClipboard,
  getXlsxSelectionLocation,
} from './session-file-xlsx-clipboard';
import { DocumentCaptureButton, useDocumentSelection } from './document-selection-surface';

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

function XlsxToolbar({
  controller,
  copyStatus,
  isCopying,
  onCopy,
  path,
}: {
  readonly controller: XlsxViewerController;
  readonly copyStatus: string;
  readonly isCopying: boolean;
  readonly onCopy: () => void;
  readonly path: string;
}) {
  const { t } = useTranslation();
  const select = useDocumentSelection();
  return (
    <div {...stylex.props(officeFrameStyles.toolbar)} data-document-toolbar>
      <Button
        type="button"
        variant="ghost"
        size="mini"
        icon
        aria-label={t('sessions.fileViewer.pdf.zoomOut', 'Zoom out')}
        disabled={!controller.canZoomOut}
        onClick={controller.zoomOut}
      >
        <ZoomOut size={16} aria-hidden />
      </Button>
      <span
        {...stylex.props(officeFrameStyles.label)}
        aria-label={t('sessions.fileViewer.pdf.zoomLevel', 'Zoom level')}
      >
        {Math.round(controller.zoomScale)}%
      </span>
      <Button
        type="button"
        variant="ghost"
        size="mini"
        icon
        aria-label={t('sessions.fileViewer.pdf.zoomIn', 'Zoom in')}
        disabled={!controller.canZoomIn}
        onClick={controller.zoomIn}
      >
        <ZoomIn size={16} aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="mini"
        icon
        aria-label={t('sessions.fileViewer.spreadsheet.copySelection', 'Copy selection')}
        disabled={
          isCopying ||
          controller.isLoading ||
          !controller.activeSheet ||
          (!controller.selection && !controller.activeCell)
        }
        onClick={onCopy}
      >
        <Copy size={16} aria-hidden />
      </Button>
      <span {...stylex.props(officeFrameStyles.label)} role="status">
        {copyStatus}
      </span>
      {select ? (
        <Tooltip
          content={t('sessions.fileViewer.selection.annotateCells', 'Annotate selected cells')}
        >
          <Button
            icon
            aria-label={t('sessions.fileViewer.selection.annotateCells', 'Annotate selected cells')}
            size="mini"
            variant="ghost"
            disabled={
              controller.isLoading ||
              !controller.activeSheet ||
              (!controller.selection && !controller.activeCell)
            }
            onClick={(event) =>
              select(async (signal) => {
                const location = getXlsxSelectionLocation(controller);
                const data = await readXlsxSelectionClipboard(controller, signal);
                return { path, location, text: data.text };
              }, event.currentTarget)
            }
          >
            <MessageSquarePlus size={16} aria-hidden />
          </Button>
        </Tooltip>
      ) : null}
      <DocumentCaptureButton />
      <span {...stylex.props(officeFrameStyles.spacer)} />
      <span {...stylex.props(officeFrameStyles.label)}>
        {controller.tabs.length > 0
          ? controller.tabs.length === 1
            ? t('sessions.fileViewer.office.oneSheet', '1 sheet')
            : t('sessions.fileViewer.office.sheetCount', '{{count}} sheets', {
                count: controller.tabs.length,
              })
          : ''}
      </span>
    </div>
  );
}

export function SessionFileXlsxRenderer({
  buffer,
  path,
  fileActions,
}: {
  readonly buffer: ArrayBuffer;
  readonly path: string;
  readonly fileActions?: SessionFileErrorActions;
}) {
  const { t } = useTranslation();
  const isDark = useResolvedTheme() === 'dark';
  const controller = useXlsxViewerController({
    file: buffer,
    fileName: path.split('/').pop(),
    readOnly: true,
    allowResizeInReadOnly: true,
    useWorker: true,
    maxFileSizeBytes: 25 * 1024 * 1024,
  });
  const copyingRef = useRef<AbortController | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => () => copyingRef.current?.abort(), [buffer]);
  const copySelection = () => {
    if (copyingRef.current || controller.isLoading || !controller.activeSheet) return;
    const request = new AbortController();
    copyingRef.current = request;
    setIsCopying(true);
    setCopyStatus('');
    // Start the clipboard write during the gesture; its data can arrive from the worker later.
    void writeSpreadsheetClipboard(readXlsxSelectionClipboard(controller, request.signal))
      .then(() => {
        if (!request.signal.aborted) {
          setCopyStatus(t('sessions.fileViewer.spreadsheet.copied', 'Selection copied'));
        }
      })
      .catch((error: unknown) => {
        if (request.signal.aborted) return;
        setCopyStatus(
          error instanceof RangeError
            ? t('sessions.fileViewer.spreadsheet.copyTooLarge', 'Select a smaller range to copy')
            : t('sessions.fileViewer.spreadsheet.copyFailed', 'Could not copy the selection')
        );
      })
      .finally(() => {
        copyingRef.current = null;
        setIsCopying(false);
      });
  };
  const isGridCopyTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    target.closest('[role="grid"]') !== null &&
    target.closest('input, textarea, [contenteditable="true"]') === null;
  const unavailable = (
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
  return (
    <OfficeViewerFrame
      label={t('sessions.fileViewer.office.xlsxViewer', 'XLSX viewer')}
      toolbar={null}
    >
      <div
        {...stylex.props(styles.viewer)}
        onKeyDownCapture={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            event.key.toLowerCase() === 'c' &&
            isGridCopyTarget(event.target)
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) copySelection();
          }
        }}
        onCopyCapture={(event) => {
          if (!isGridCopyTarget(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          copySelection();
        }}
      >
        <XlsxViewer
          controller={controller}
          height="100%"
          isDark={isDark}
          readOnly
          allowResizeInReadOnly
          showDefaultToolbar={false}
          toolbar={() => (
            <XlsxToolbar
              controller={controller}
              copyStatus={copyStatus}
              isCopying={isCopying}
              onCopy={copySelection}
              path={path}
            />
          )}
          loadingState={
            <div {...stylex.props(styles.loading)} role="status">
              <Spinner label={null} />
              {t('sessions.fileViewer.office.loading', 'Loading document…')}
            </div>
          }
          errorState={unavailable}
          fileTooLargeState={unavailable}
        />
      </div>
    </OfficeViewerFrame>
  );
}
