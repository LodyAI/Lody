import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, Copy, Download, ExternalLink, FileWarning, Loader2, X } from 'lucide-react';
import type { SessionFilePayload } from '@lody/shared';
import { Dialog, DialogClose, DialogContentWithoutClose, DialogTitle } from '@/ui/dialog';
import { Button } from '@/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { formatFileSize } from '@/lib/session-file-presentation';
import { MarkdownRenderer } from './markdown-renderer';

const isMarkdownFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ext === 'md' || ext === 'markdown' || ext === 'mdx';
};

export type SessionFilePreviewStatus =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; text: string; truncated: boolean };

export type SessionFilePreviewPanelProps = {
  file: SessionFilePayload;
  status: SessionFilePreviewStatus;
  onDownload: (file: SessionFilePayload) => void;
  isDownloading?: boolean;
  onOpenLivePreview?: (file: SessionFilePayload) => void;
};

/**
 * Pure preview body: header (name/size + actions), then the rendered/raw text.
 * Stateless w.r.t. fetching — the container feeds it `status`. Markdown files
 * default to the sanitized rendered view (reusing the chat MarkdownRenderer; a
 * bespoke HTML path is forbidden) with a Raw toggle. Copy always copies the
 * raw source text.
 */
export function SessionFilePreviewPanel({
  file,
  status,
  onDownload,
  isDownloading = false,
  onOpenLivePreview,
}: SessionFilePreviewPanelProps) {
  const { t } = useTranslation();
  const markdown = isMarkdownFile(file.fileName);
  // Markdown → rendered by default; plain text has no rendered view.
  const [showRaw, setShowRaw] = useState(!markdown);
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

  return (
    // `min-w-0` is load-bearing: this panel is a grid child of DialogContent
    // (`display: grid`). Grid/flex items default to `min-width: auto`, so wide
    // content (long code lines, tables, unbreakable tokens) would stretch the
    // panel past the dialog's `max-w-3xl` and bleed out of the modal. Capping
    // the min width forces content to wrap/scroll within the modal width.
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <DialogTitle className="truncate text-sm font-semibold leading-tight">
            {file.fileName}
          </DialogTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatFileSize(file.sizeBytes)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {markdown ? (
            <Tabs
              value={showRaw ? 'raw' : 'rendered'}
              onValueChange={(v) => setShowRaw(v === 'raw')}
              className="mr-1"
            >
              <TabsList className="h-7 p-0.5">
                <TabsTrigger value="rendered" className="h-6 px-2.5 text-xs">
                  {t('sessions.filePreviewRendered', 'Rendered')}
                </TabsTrigger>
                <TabsTrigger value="raw" className="h-6 px-2.5 text-xs">
                  {t('sessions.filePreviewRaw', 'Raw')}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={handleCopy}
            disabled={status.kind !== 'loaded'}
            aria-label={t('common.copy', 'Copy')}
          >
            {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={() => onDownload(file)}
            disabled={isDownloading}
            aria-label={t('sessions.fileDownload', 'Download')}
          >
            {isDownloading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
          </Button>
          {onOpenLivePreview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={() => onOpenLivePreview(file)}
              aria-label={t('sessions.openLivePreview', 'Open live preview')}
              title={t('sessions.openLivePreview', 'Open live preview')}
            >
              <ExternalLink className="size-4" />
            </Button>
          ) : null}
          {/* Divider separates content actions (copy/download/live-preview) from the window
              action (close), and the close sits inline in the same row instead
              of floating in the corner over the buttons. */}
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={t('common.close', 'Close')}
            >
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
      </div>

      {status.kind === 'loaded' && status.truncated ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span className="flex items-center gap-2">
            <FileWarning className="size-4 shrink-0" aria-hidden="true" />
            {t(
              'sessions.filePreviewTruncated',
              'Preview shows only the start of this file. Download the full file to see everything.'
            )}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-6 shrink-0 px-2.5 text-xs"
            onClick={() => onDownload(file)}
            disabled={isDownloading}
          >
            {t('sessions.fileDownloadFull', 'Download full file')}
          </Button>
        </div>
      ) : null}

      {/* Body sizes to its content (no flex-1 stretch, so short files leave no
          dead space) and caps itself with its own scroll. Rendered markdown
          breathes on the dialog surface; raw text sits on a subtle code
          surface. The header's border-b is the only separator. */}
      <div className="mt-3 max-h-[55vh] min-w-0 overflow-y-auto">
        {status.kind === 'loading' ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('sessions.filePreviewLoading', 'Loading preview…')}
          </div>
        ) : status.kind === 'error' ? (
          <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
            <FileWarning className="size-6 text-muted-foreground/60" aria-hidden="true" />
            <span>{status.message}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => onDownload(file)}>
              {t('sessions.fileDownload', 'Download')}
            </Button>
          </div>
        ) : renderMarkdown ? (
          <div className="px-0.5 pb-1">
            <MarkdownRenderer text={status.text} size="default" />
          </div>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-[13px] leading-relaxed text-foreground">
            {status.text}
          </pre>
        )}
      </div>
    </div>
  );
}

export type SessionFilePreviewDialogProps = SessionFilePreviewPanelProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Modal wrapper around the preview panel, matching the app dialog system. */
export function SessionFilePreviewDialog({
  open,
  onOpenChange,
  onOpenLivePreview,
  ...panelProps
}: SessionFilePreviewDialogProps) {
  // Re-key the panel per file so the rendered/raw toggle resets between files.
  const panelKey = useMemo(() => panelProps.file.fileId, [panelProps.file.fileId]);
  const handleOpenLivePreview = useMemo(() => {
    if (!onOpenLivePreview) return undefined;
    return (file: SessionFilePayload) => {
      onOpenChange(false);
      onOpenLivePreview(file);
    };
  }, [onOpenChange, onOpenLivePreview]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContentWithoutClose className="w-[calc(100vw-2rem)] max-w-3xl">
        <SessionFilePreviewPanel
          key={panelKey}
          {...panelProps}
          onOpenLivePreview={handleOpenLivePreview}
        />
      </DialogContentWithoutClose>
    </Dialog>
  );
}
