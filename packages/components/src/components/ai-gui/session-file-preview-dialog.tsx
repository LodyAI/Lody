import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { Check, Copy, Download, Eye, EyeClosed, FileWarning, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import type { SessionFilePayload } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { Drawer } from '@lody/ui/drawer';
import { dialog } from '@lody/ui/dialog/dialog.tokens.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, space, text } from '@lody/ui/tokens/scales.stylex';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@lody/ui/button';
import { Tabs } from '@lody/ui/tabs';
import { ReadOnlyHtmlPreview } from '../sessions/read-only-html-preview';
import { VideoPlayer } from '../shared/video-player';
import {
  formatFileSize,
  isHtmlSessionFile,
  isVideoSessionFile,
} from '@/lib/session-file-presentation';
import { MarkdownRenderer } from './markdown-renderer';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { copyTextToClipboard } from '@/lib/clipboard';

const isMarkdownFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ext === 'md' || ext === 'markdown' || ext === 'mdx';
};

export type SessionFilePreviewStatus =
  | { kind: 'loading'; loadedBytes?: number; totalBytes?: number }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; text: string; truncated: boolean }
  | { kind: 'video'; src: string };

/**
 * Where the preview is mounted:
 * - `pane`: a desktop side-panel tab. The name and actions are one toolbar under
 *   the tab strip and the body fills the panel, with no card, frame or close.
 * - `dialog`: a centred desktop Dialog, for hosts without a side panel.
 * - `sheet`: the mobile bottom Drawer.
 */
export type SessionFilePreviewVariant = 'pane' | 'dialog' | 'sheet';

export type SessionFilePreviewPanelProps = {
  variant?: SessionFilePreviewVariant;
  file: SessionFilePayload;
  status: SessionFilePreviewStatus;
  active?: boolean;
  onDownload?: (file: SessionFilePayload) => void;
  isDownloading?: boolean;
  className?: string;
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
  active = true,
  onDownload,
  isDownloading = false,
  variant = 'dialog',
  className,
}: SessionFilePreviewPanelProps) {
  const { t } = useTranslation();
  const video = isVideoSessionFile(file);
  const html = !video && isHtmlSessionFile(file);
  const markdown = !video && !html && isMarkdownFile(file.fileName);
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
    void copyTextToClipboard(rawText).then(
      () => setCopied(true),
      () => toast.error(t('sessions.fileCopyFailed', 'Failed to copy file content'))
    );
  };

  const pane = variant === 'pane';
  const mobileSheet = variant === 'sheet';
  const renderMarkdown = markdown && !showRaw;
  const renderHtml = canPreviewHtml && !showRaw;
  const Title = mobileSheet ? Drawer.Title : Dialog.Title;
  const Close = mobileSheet ? Drawer.Close : Dialog.Close;

  const actions = (
    <>
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
          xstyle={styles.tabs}
        >
          <Tabs.List size="small">
            <Tabs.Tab value="rendered">{t('sessions.filePreviewRendered', 'Rendered')}</Tabs.Tab>
            <Tabs.Tab value="raw">{t('sessions.filePreviewRaw', 'Raw')}</Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
      ) : null}
      {!video ? (
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
      ) : null}

      {onDownload && (
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon
          onClick={() => onDownload?.(file)}
          disabled={isDownloading}
          aria-label={t('sessions.fileDownload', 'Download')}
        >
          {isDownloading ? <Spinner size="small" /> : <Download {...stylex.props(styles.glyph)} />}
        </Button>
      )}
    </>
  );

  const truncatedNotice =
    status.kind === 'loaded' && status.truncated ? (
      <div {...stylex.props(pane ? styles.paneNotice : styles.notice)}>
        <span {...stylex.props(styles.noticeText)}>
          <FileWarning {...stylex.props(styles.glyph, styles.shrink)} aria-hidden="true" />
          {t(
            'sessions.filePreviewTruncated',
            'Preview shows only the start of this file. Download the full file to see everything.'
          )}
        </span>
        {onDownload && (
          <Button
            type="button"
            variant="secondary"
            size="small"
            xstyle={styles.shrink}
            onClick={() => onDownload?.(file)}
            disabled={isDownloading}
          >
            {t('sessions.fileDownloadFull', 'Download full file')}
          </Button>
        )}
      </div>
    ) : null;

  const renderVideo = status.kind === 'video';
  const loadingMessage = (() => {
    if (status.kind !== 'loading') return '';
    if (video && status.totalBytes && status.totalBytes > 0 && status.loadedBytes !== undefined) {
      const percent = Math.min(100, Math.round((status.loadedBytes / status.totalBytes) * 100));
      return t('sessions.videoPreview.loadingProgress', 'Loading video… {{percent}}%', { percent });
    }
    if (video) {
      return t('sessions.videoPreview.loading', 'Loading video…');
    }
    return t('sessions.filePreviewLoading', 'Loading preview…');
  })();

  let content: React.ReactNode;
  if (status.kind === 'loading') {
    content = (
      <div {...stylex.props(styles.loading)}>
        <Spinner size="small" />
        {loadingMessage}
      </div>
    );
  } else if (status.kind === 'error') {
    content = (
      <div {...stylex.props(styles.error)}>
        <FileWarning {...stylex.props(styles.glyphLarge, styles.glyphFaint)} aria-hidden="true" />

        <span>{status.message}</span>
        {onDownload && (
          <Button type="button" variant="secondary" size="small" onClick={() => onDownload?.(file)}>
            {t('sessions.fileDownload', 'Download')}
          </Button>
        )}
      </div>
    );
  } else if (status.kind === 'video') {
    content = (
      <div
        {...stylex.props(
          styles.videoPreview,
          mobileSheet && styles.fillHtmlPreview,
          pane && styles.fillHtmlPreview
        )}
      >
        <VideoPlayer
          key={status.src}
          src={status.src}
          active={active}
          title={file.fileName}
          onDownload={onDownload ? () => onDownload(file) : undefined}
          isDownloading={isDownloading}
        />
      </div>
    );
  } else if (renderHtml) {
    content = (
      <div
        {...stylex.props(
          styles.htmlPreview,
          mobileSheet && styles.fillHtmlPreview,
          pane && styles.fillHtmlPreview
        )}
      >
        <ReadOnlyHtmlPreview text={status.text} />
      </div>
    );
  } else if (renderMarkdown) {
    content = (
      <div {...stylex.props(pane ? styles.paneMarkdown : styles.markdown)}>
        <MarkdownRenderer text={status.text} size="default" />
      </div>
    );
  } else if (pane) {
    content = <pre {...stylex.props(styles.paneRaw)}>{status.text}</pre>;
  } else {
    content = (
      <pre {...stylex.props(styles.raw)}>
        {status.text}
      </pre>

    );
  }

  if (pane) {
    return (
      <div className={[stylex.props(styles.pane).className, className].filter(Boolean).join(' ')}>
        <div {...stylex.props(styles.paneToolbar)}>
          <span {...stylex.props(styles.paneName)} title={file.fileName}>
            {file.fileName}
          </span>
          <span {...stylex.props(styles.paneSize)}>{formatFileSize(file.sizeBytes)}</span>
          <div {...stylex.props(styles.paneActions)}>{actions}</div>
        </div>
        {truncatedNotice}
        <div {...stylex.props(styles.paneBody, (renderHtml || renderVideo) && styles.paneBodyFill)}>
          {content}
        </div>
      </div>
    );
  }

  return (
    // `min-w-0` is load-bearing: this panel is a grid child of Dialog.Content
    // (`display: grid`). Grid/flex items default to `min-width: auto`, so wide
    // content (long code lines, tables, unbreakable tokens) would stretch the
    // panel past the dialog's `width` cap and bleed out of the modal. Capping
    // the min width forces content to wrap/scroll within the modal width.
    <div {...stylex.props(styles.panel, mobileSheet && styles.sheetPanel)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <Title fontWeight="var(--font-weight-semibold)" xstyle={styles.titleText}>
            {file.fileName}
          </Title>
          <span {...stylex.props(styles.fileMeta)}>{formatFileSize(file.sizeBytes)}</span>
        </div>
        <div {...stylex.props(styles.actions)}>
          {actions}
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

      {truncatedNotice}

      {/* Desktop caps the body to its content; the mobile sheet fills its
          remaining height and scrolls below the fixed header. */}
      <div {...stylex.props(styles.body, mobileSheet && styles.sheetBody)}>{content}</div>
    </div>
  );
}

export type SessionFilePreviewDialogProps = Omit<SessionFilePreviewPanelProps, 'variant'> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Mobile bottom sheet, or a desktop Dialog for hosts that have no session side
 * panel (history readers). A desktop Session opens attachments as a side-panel
 * tab instead (`SessionFileAttachmentPane`).
 */
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
          <SessionFilePreviewPanel key={panelKey} {...panelProps} variant="sheet" />
        </Drawer.Content>
      </Drawer.Root>
    );
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content closeButton={false} width="48rem">
        <SessionFilePreviewPanel key={panelKey} {...panelProps} variant="dialog" />
      </Dialog.Content>
    </Dialog.Root>
  );
}

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 },
  sheetPanel: {
    height: `calc(100dvh - max(6dvh, env(safe-area-inset-top, 0px)) - env(safe-area-inset-bottom, 0px) - ${space[4]} * 2)`,
  },
  body: { marginTop: space[3], maxHeight: '55vh', minWidth: 0, overflowY: 'auto' },
  sheetBody: { flex: 1, minHeight: 0, maxHeight: 'none', overscrollBehavior: 'contain' },
  fillHtmlPreview: { flexGrow: 1, width: '100%', height: '100%' },
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
    lineHeight: 1.25,
    [dialog.titleSize]: 'var(--text-sm)',
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
    color: {
      default: 'var(--color-amber-700)',
      [DARK_SCOPE]: 'var(--color-amber-300)',
    },
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
  videoPreview: { display: 'flex', height: '55vh', minWidth: 0, overflow: 'hidden' },

  pane: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    backgroundColor: colors.background,
  },
  /* The tab strip above already draws the panel's only edge; this bar is the
     same surface, so it carries no border, fill or radius of its own. */
  paneToolbar: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: space[2],
    minWidth: 0,
    minHeight: `calc(${control.medium} + ${space[2]})`,
    paddingInlineStart: space[3],
    paddingInlineEnd: space[1.5],
  },
  paneName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    color: colors.label,
  },
  paneSize: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  paneActions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: space[1],
    marginInlineStart: 'auto',
  },
  paneNotice: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space[3],
    paddingBlock: space[2],
    paddingInline: space[3],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
    backgroundColor: `color-mix(in srgb, ${colors.warning} 12%, transparent)`,
  },
  paneBody: { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  paneBodyFill: { display: 'flex', overflow: 'hidden' },
  paneMarkdown: {
    width: '100%',
    maxWidth: '48rem',
    marginInline: 'auto',
    paddingBlock: space[2],
    paddingInline: space[4],
    userSelect: 'text',
  },
  paneRaw: {
    margin: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    lineHeight: 1.6,
    color: colors.label,
  },
});
