import * as stylex from '@stylexjs/stylex';
import { useEffect, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { scheduleFilePreviewWhenIdle } from '@/lib/session-file-preview-idle';
import {
  OfficePreviewTooLargeError,
  readOfficePreviewBytes,
  type OfficePreviewKind,
} from '@/lib/session-file-office-source';
import { SessionFileNoticeCard } from './session-file-error-state';

export type OfficeRenderer = ComponentType<{
  readonly buffer: ArrayBuffer;
  readonly path: string;
  readonly fileActions?: SessionFileErrorActions;
}>;

const styles = stylex.create({
  root: { position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' },
  loading: {
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    color: colors.secondaryLabel,
  },
});

async function loadRenderer(kind: OfficePreviewKind): Promise<OfficeRenderer> {
  switch (kind) {
    case 'docx':
      return (await import('./session-file-docx-renderer')).SessionFileDocxRenderer;
    case 'xlsx':
      return (await import('./session-file-xlsx-renderer')).SessionFileXlsxRenderer;
    case 'pptx':
      return (await import('./session-file-pptx-renderer')).SessionFilePptxRenderer;
    default:
      throw new Error(`Unsupported office preview: ${kind}`);
  }
}

export function SessionFileOfficePreview({
  kind,
  path,
  bytes,
  url,
  active,
  fileActions,
}: {
  readonly kind: OfficePreviewKind;
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly active: boolean;
  readonly fileActions?: SessionFileErrorActions;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; buffer: ArrayBuffer; Renderer: OfficeRenderer }
    | { status: 'error'; tooLarge: boolean }
  >({ status: 'loading' });

  useEffect(() => {
    if (!active) {
      setState({ status: 'loading' });
      return undefined;
    }
    const controller = new AbortController();
    let disposed = false;
    const start = () => {
      void readOfficePreviewBytes({ bytes, url, signal: controller.signal })
        .then(async (buffer) => ({ buffer, Renderer: await loadRenderer(kind) }))
        .then(
          ({ buffer, Renderer }) => {
            if (!disposed) setState({ status: 'ready', buffer, Renderer });
          },
          (error: unknown) => {
            if (!disposed) {
              setState({ status: 'error', tooLarge: error instanceof OfficePreviewTooLargeError });
            }
          }
        );
    };
    setState({ status: 'loading' });
    const cancelIdle = scheduleFilePreviewWhenIdle(start);
    return () => {
      disposed = true;
      controller.abort();
      cancelIdle();
    };
  }, [active, bytes, kind, url]);

  if (state.status === 'error') {
    return (
      <SessionFileNoticeCard
        presentation={{
          title: t('sessions.fileViewer.office.failedTitle', 'Document preview unavailable'),
          description: state.tooLarge
            ? t(
                'sessions.fileViewer.office.tooLarge',
                'This document exceeds the 25 MB preview limit. Open it in the default app.'
              )
            : t(
                'sessions.fileViewer.office.failedMessage',
                'This document could not be opened. Try opening it in the default app.'
              ),
        }}
        fileActions={fileActions}
      />
    );
  }
  if (!active || state.status === 'loading') {
    return (
      <div {...stylex.props(styles.loading)} role="status">
        <Spinner label={null} />
        {t('sessions.fileViewer.office.loading', 'Loading document…')}
      </div>
    );
  }
  const { Renderer, buffer } = state;
  return (
    <div {...stylex.props(styles.root)}>
      <Renderer buffer={buffer} path={path} fileActions={fileActions} />
    </div>
  );
}
