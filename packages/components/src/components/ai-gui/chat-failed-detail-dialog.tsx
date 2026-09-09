import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertCircle, Check, Copy } from 'lucide-react';

import { Button } from '@lody/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  buildChatFailedErrorReport,
  type ChatFailedErrorReportInput,
} from './chat-failed-error-report';

export type ChatFailedDetailDialogProps = ChatFailedErrorReportInput & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shortened message rendered above the raw text, when it adds anything. */
  summary?: string;
};

/**
 * Full agent-error surface. Replaces the old hover tooltip: a tooltip is
 * unreachable on touch devices and truncates long upstream payloads, so the
 * whole raw error lives here behind a tap/click, with one-tap copy.
 */
export function ChatFailedDetailDialog({
  open,
  onOpenChange,
  summary,
  ...report
}: ChatFailedDetailDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const { title, action, reason, code, message } = report;
  const reportText = buildChatFailedErrorReport(report);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const handleCopy = () => {
    if (!reportText) return;
    void navigator.clipboard?.writeText(reportText).then(
      () => setCopied(true),
      () => toast.error(t('sessions.systemNotices.chatFailed.copyFailed', 'Failed to copy error'))
    );
  };

  const detailText = message?.trim() || summary?.trim() || '';
  const showSummary = Boolean(
    summary && summary.trim() && summary.trim() !== title.trim() && summary.trim() !== detailText
  );
  const tags: Array<{ label: string; value: string }> = [];
  if (reason) {
    tags.push({
      label: t('sessions.systemNotices.chatFailed.reasonLabel', 'Reason'),
      value: reason,
    });
  }
  if (code) {
    tags.push({ label: t('sessions.systemNotices.chatFailed.codeLabel', 'Code'), value: code });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `w-[calc(100vw-2rem)]` keeps the raw error readable on phones, where the
          shared dialog default reserves 2rem of margin on each side. */}
      <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl gap-3">
        <DialogHeader className="pr-6 text-left sm:text-left">
          <DialogTitle className="flex items-start gap-2 text-base">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">{title}</span>
          </DialogTitle>
          {action ? (
            <DialogDescription className="text-left [overflow-wrap:anywhere]">
              {action}
            </DialogDescription>
          ) : (
            // Radix always wires `aria-describedby`; without a description node
            // the dialog points at a missing id.
            <DialogDescription className="sr-only">
              {t(
                'sessions.systemNotices.chatFailed.detailsDescription',
                'Full agent error details'
              )}
            </DialogDescription>
          )}
        </DialogHeader>

        {showSummary ? (
          <p className="min-w-0 text-sm leading-5 [overflow-wrap:anywhere]">{summary}</p>
        ) : null}

        {tags.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag.label}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]"
              >
                {tag.label}: {tag.value}
              </span>
            ))}
          </div>
        ) : null}

        {detailText ? (
          <div className="min-w-0 overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 max-h-[45vh]">
            <pre className="whitespace-pre-wrap font-mono text-xs leading-5 [overflow-wrap:anywhere]">
              {detailText}
            </pre>
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="small">
              {t('common.close', 'Close')}
            </Button>
          </DialogClose>
          <Button type="button" variant="secondary" size="small" onClick={handleCopy}>
            {copied ? (
              <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            {copied
              ? t('sessions.systemNotices.chatFailed.copied', 'Copied')
              : t('sessions.systemNotices.chatFailed.copyError', 'Copy error')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
