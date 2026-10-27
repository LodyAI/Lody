import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { toast } from '@/lib/toast';
import { Check, Copy, Download, Eye, EyeClosed, FileWarning, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import type { SessionFilePayload } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { Drawer } from '@lody/ui/drawer';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@lody/ui/button';
import { Tabs } from '@lody/ui/tabs';
import { ReadOnlyHtmlPreview } from '../sessions/read-only-html-preview';
import { formatFileSize, isHtmlSessionFile } from '@/lib/session-file-presentation';
import { MarkdownRenderer } from './markdown-renderer';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const isMarkdownFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ext === 'md' || ext === 'markdown' || ext === 'mdx';
};

export type SessionFilePreviewStatus =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; text: string; truncated: boolean };

export type SessionFilePreviewPanelProps = {
  mobileSheet?: boolean;
  file: SessionFilePayload;
  status: SessionFilePreviewStatus;
  onDownload: (file: SessionFilePayload) => void;
  isDownloading?: boolean;
};

/**
 * Pure preview body: header (name/size + actions), then the rendered/raw text.
 * Stateless w.r.t. fetching — the container feeds it `status`. Markdown files
 * default to the existing sanitized MarkdownRenderer with a Raw toggle. Complete
 * HTML uses the shared script-free sandbox preview. Copy always copies raw source.
 */
export function SessionFilePreviewPanel({
  file,
  status,
  onDownload,
  isDownloading = false,
  mobileSheet = false,
}: SessionFilePreviewPanelProps) {
  const { t } = useTranslation();
  const html = isHtmlSessionFile(file);
  const markdown = !html && isMarkdownFile(file.fileName);
  // Renderable attachments open in preview; original bytes remain one toggle away.
  const [showRaw, setShowRaw] = useState(!markdown && !html);
  const canPreviewHtml = html && status.kind === 'loaded' && !status.truncated;
  const [copied, setCopied] = useState(false);

  const rawText = status.kind === 'loaded' ? status.text : '';

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = () => {
    if (!rawText) return;
    // Always copy the raw source, regardless of rendered/raw view.
    void navigator.clipboard?.writeText(rawText).then(
      () => setCopied(true),
      () => toast.error(t('sessions.fileCopyFailed', 'Failed to copy file content'))
    );
  };

  const renderMarkdown = markdown && !showRaw;
  const renderHtml = canPreviewHtml && !showRaw;
  const Title = mobileSheet ? Drawer.Title : Dialog.Title;
  const Close = mobileSheet ? Drawer.Close : Dialog.Close;

  return (
    // `min-w-0` is load-bearing: this panel is a grid child of Dialog.Content
    // (`display: grid`). Grid/flex items default to `min-width: auto`, so wide
    // content (long code lines, tables, unbreakable tokens) would stretch the
    // panel past the dialog's `width` cap and bleed out of the modal. Capping
    // the min width forces content to wrap/scroll within the modal width.
    <div {...stylex.props(styles.panel, mobileSheet && styles.sheetPanel)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <Title
            className={clsx(
              'text-sm font-semibold leading-tight',
              stylex.props(styles.titleText).className
            )}
          >
            {file.fileName}
          </Title>
          <span {...stylex.props(styles.fileMeta)}>
            {formatFileSize(file.sizeBytes)}
          </span>
        </div>
        <div {...stylex.props(styles.actions)}>
          {canPreviewHtml ? (
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              aria-pressed={renderHtml}
              aria-label={
                renderHtml
                  ? t('sessions.fileViewer.preview.hide', 'Hide preview')
                  : t('sessions.fileViewer.preview.show', 'Preview')
              }
              onClick={() => setShowRaw((raw) => !raw)}
            >
              {renderHtml ? <EyeClosed size={16} /> : <Eye size={16} />}
            </Button>
          ) : null}
          {markdown ? (
            <Tabs.Root
              value={showRaw ? 'raw' : 'rendered'}
              onValueChange={(value) => setShowRaw(value === 'raw')}
              className={stylex.props(styles.tabs).className}
            >
              <Tabs.List size="small">
                <Tabs.Tab value="rendered">
                  {t('sessions.filePreviewRendered', 'Rendered')}
                </Tabs.Tab>
                <Tabs.Tab value="raw">{t('sessions.filePreviewRaw', 'Raw')}</Tabs.Tab>
              </Tabs.List>
            </Tabs.Root>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon
            onClick={handleCopy}
            disabled={status.kind !== 'loaded'}
            aria-label={t('common.copy', 'Copy')}
          >
            {copied ? (
              <Check {...stylex.props(styles.glyph, styles.glyphSuccess)} />
            ) : (
              <Copy {...stylex.props(styles.glyph)} />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon
            onClick={() => onDownload(file)}
            disabled={isDownloading}
            aria-label={t('sessions.fileDownload', 'Download')}
          >
            {isDownloading ? (
              <Spinner size="small" />
            ) : (
              <Download {...stylex.props(styles.glyph)} />
            )}
          </Button>
          {/* Divider separates content actions (copy/download) from the window
              action (close), and the close sits inline in the same row instead
              of floating in the corner over the buttons. */}
          <span {...stylex.props(styles.divider)} aria-hidden="true" />
          <Close
            render={
              <Button
                type="button"
                variant="ghost"
                aria-label={t('common.close', 'Close')}
                size="small"
                icon
              />
            }
          >
            <X {...stylex.props(styles.glyph)} />
          </Close>
        </div>
      </div>

      {status.kind === 'loaded' && status.truncated ? (
        <div
          // The dark half of a hard-coded palette colour has no StyleX
          // equivalent, so it stays a Tailwind class on this element.
          className={clsx('dark:text-amber-300', stylex.props(styles.notice).className)}
        >
          <span {...stylex.props(styles.noticeText)}>
            <FileWarning {...stylex.props(styles.glyph)} aria-hidden="true" />
            {t(
              'sessions.filePreviewTruncated',
              'Preview shows only the start of this file. Download the full file to see everything.'
            )}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="small"
            className={stylex.props(styles.shrink).className}
            onClick={() => onDownload(file)}
            disabled={isDownloading}
          >
            {t('sessions.fileDownloadFull', 'Download full file')}
          </Button>
        </div>
      ) : null}

      {/* Desktop caps the body to its content; the mobile sheet fills its
          remaining height and scrolls below the fixed header. */}
      <div {...stylex.props(styles.body, mobileSheet && styles.sheetBody)}>
        {status.kind === 'loading' ? (
          <div {...stylex.props(styles.loading)}>
            <Spinner size="small" />
            {t('sessions.filePreviewLoading', 'Loading preview…')}
          </div>
        ) : status.kind === 'error' ? (
          <div {...stylex.props(styles.error)}>
            <FileWarning
              {...stylex.props(styles.glyphLarge, styles.glyphFaint)}
              aria-hidden="true"
            />
            <span>{status.message}</span>
            <Button type="button" variant="secondary" size="small" onClick={() => onDownload(file)}>
              {t('sessions.fileDownload', 'Download')}
            </Button>
          </div>
        ) : renderHtml ? (
          <div {...stylex.props(styles.htmlPreview, mobileSheet && styles.sheetHtmlPreview)}>
            <ReadOnlyHtmlPreview text={status.text} />
          </div>
        ) : renderMarkdown ? (
          <div {...stylex.props(styles.markdown)}>
            <MarkdownRenderer text={status.text} size="default" />
          </div>
        ) : (
          <pre {...stylex.props(styles.raw)}>{status.text}</pre>
        )}
      </div>
    </div>
  );
}

export type SessionFilePreviewDialogProps = SessionFilePreviewPanelProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Mobile bottom sheet / desktop dialog around the shared preview panel. */
export function SessionFilePreviewDialog({
  open,
  onOpenChange,
  ...panelProps
}: SessionFilePreviewDialogProps) {
  // Re-key the panel per file so the rendered/raw toggle resets between files.
  const isMobile = useIsMobile();
  const panelKey = useMemo(() => panelProps.file.fileId, [panelProps.file.fileId]);
  if (isMobile) {
    return (
      <Drawer.Root side="bottom" open={open} onOpenChange={onOpenChange}>
        <Drawer.Content
          side="bottom"
          closeButton={false}
          style={{
            maxHeight: 'calc(100dvh - max(6dvh, env(safe-area-inset-top, 0px)))',
            overflow: 'hidden',
          }}
        >
          <SessionFilePreviewPanel key={panelKey} {...panelProps} mobileSheet />
        </Drawer.Content>
      </Drawer.Root>
    );
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content closeButton={false} width="48rem">
        <SessionFilePreviewPanel key={panelKey} {...panelProps} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 },
  sheetPanel: {
    height: `calc(100dvh - max(6dvh, env(safe-area-inset-top, 0px)) - env(safe-area-inset-bottom, 0px) - ${space[4]} * 2)`,
  },
  body: { marginTop: space[3], maxHeight: '55vh', minWidth: 0, overflowY: 'auto' },
  sheetBody: { flex: 1, minHeight: 0, maxHeight: 'none', overscrollBehavior: 'contain' },
  sheetHtmlPreview: { height: '100%' },
  htmlPreview: { display: 'flex', height: '55vh', minWidth: 0, overflow: 'hidden' },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.5)',
    paddingBottom: themeSpace[3],
  },
  headerText: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    gap: themeSpace[0.5],
  },
  /** The title's own size and weight stay with the primitive that owns them. */
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileMeta: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
  },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
  },
  tabs: { marginRight: themeSpace[1] },
  glyph: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  glyphLarge: {
    width: themeSpace[6],
    height: themeSpace[6],
  },
  glyphSuccess: { color: 'var(--color-emerald-500)' },
  glyphFaint: { color: 'hsl(var(--muted-foreground) / 0.6)' },
  shrink: { flexShrink: 0 },
  divider: {
    marginInline: themeSpace[0.5],
    height: themeSpace[4],
    width: '1px',
    backgroundColor: themeColors.border,
  },
  notice: {
    marginTop: themeSpace[3],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, var(--color-amber-500) 25%, transparent)',
    backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 10%, transparent)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: 'var(--color-amber-700)',
  },
  noticeText: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingBlock: themeSpace[12],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  error: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingBlock: themeSpace[12],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  markdown: {
    paddingInline: themeSpace[0.5],
    paddingBottom: themeSpace[1],
  },
  raw: {
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    borderRadius: themeRadius.lg,
    backgroundColor: 'hsl(var(--muted) / 0.4)',
    padding: themeSpace[3],
    fontFamily:
      'JetBrains Mono, SF Mono, Monaco, Inconsolata, Fira Code, Droid Sans Mono, Source Code Pro, monospace',
    fontSize: '13px',
    lineHeight: '1.625',
    color: themeColors.foreground,
  },
});
