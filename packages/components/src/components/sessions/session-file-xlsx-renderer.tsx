import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { setWasmSource, XlsxViewer, type XlsxViewerController } from '@extend-ai/react-xlsx';
import wasmUrl from '@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useResolvedTheme } from '@/theme-provider';
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

function XlsxToolbar({ controller }: { readonly controller: XlsxViewerController }) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(officeFrameStyles.group)}>
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
      <div {...stylex.props(styles.viewer)}>
        <XlsxViewer
          file={buffer}
          fileName={path.split('/').pop()}
          height="100%"
          isDark={isDark}
          readOnly
          useWorker
          maxFileSizeBytes={25 * 1024 * 1024}
          showDefaultToolbar={false}
          toolbar={(controller) => <XlsxToolbar controller={controller} />}
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
