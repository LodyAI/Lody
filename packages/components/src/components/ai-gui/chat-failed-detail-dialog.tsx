import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { toast } from '@/lib/toast';
import { AlertCircle, Check, Copy } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { dialog } from '@lody/ui/dialog/dialog.tokens.stylex';
import { Dialog } from '@/ui/dialog';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeRadius, themeSpace } from '../../style/theme-scale.stylex';
import {
  buildChatFailedErrorReport,
  type ChatFailedErrorReportInput,
} from './chat-failed-error-report';

const MONO_FONT =
  'JetBrains Mono, SF Mono, Monaco, Inconsolata, Fira Code, Droid Sans Mono, Source Code Pro, monospace';

const styles = stylex.create({
  panelSpacing: { [dialog.gap]: 'calc(var(--spacing) * 3)' },
  footerSpacing: { [dialog.footerGap]: 'calc(var(--spacing) * 2)' },
  header: {
    paddingRight: themeSpace[6],
    textAlign: 'left',
  },
  title: {
    [dialog.titleSize]: 'var(--text-base)',
    [dialog.titleLeading]: 'var(--tw-leading, var(--text-base--line-height))',
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2],
  },
  titleGlyph: {
    marginTop: themeSpace[0.5],
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: themeColors.destructive,
  },
  titleText: {
    minWidth: 0,
    overflowWrap: 'break-word',
  },
  description: {
    textAlign: 'left',
    overflowWrap: 'anywhere',
  },
  summary: {
    minWidth: 0,
    fontSize: themeFontSize.sm,
    lineHeight: themeSpace[5],
    overflowWrap: 'anywhere',
  },
  tags: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    gap: themeSpace[1.5],
  },
  tag: {
    borderRadius: themeRadius.sm,
    backgroundColor: themeColors.muted,
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[0.5],
    fontFamily: MONO_FONT,
    fontSize: '11px',
    lineHeight: themeSpace[4],
    color: themeColors.mutedForeground,
    overflowWrap: 'anywhere',
  },
  raw: {
    minWidth: 0,
    overflow: 'auto',
    borderRadius: themeRadius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: 'hsl(var(--muted) / 0.4)',
    padding: themeSpace[3],
    maxHeight: '45vh',
  },
  rawText: {
    whiteSpace: 'pre-wrap',
    fontFamily: MONO_FONT,
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[5],
    overflowWrap: 'anywhere',
  },
  glyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  glyphSuccess: { color: 'var(--color-emerald-500)' },
});

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {/* A wider panel than the modal default keeps the raw error readable; the
          rung's own viewport cap still bounds it on phones. */}
      <Dialog.Content width="42rem" className={stylex.props(styles.panelSpacing).className}>
        <Dialog.Header className={stylex.props(styles.header).className}>
          <Dialog.Title className={stylex.props(styles.title).className}>
            <AlertCircle {...stylex.props(styles.titleGlyph)} aria-hidden="true" />
            <span {...stylex.props(styles.titleText)}>{title}</span>
          </Dialog.Title>
          {action ? (
            <Dialog.Description className={stylex.props(styles.description).className}>
              {action}
            </Dialog.Description>
          ) : (
            // Radix always wires `aria-describedby`; without a description node
            // the dialog points at a missing id.
            <Dialog.Description visuallyHidden>
              {t(
                'sessions.systemNotices.chatFailed.detailsDescription',
                'Full agent error details'
              )}
            </Dialog.Description>
          )}
        </Dialog.Header>

        {showSummary ? <p {...stylex.props(styles.summary)}>{summary}</p> : null}

        {tags.length > 0 ? (
          <div {...stylex.props(styles.tags)}>
            {tags.map((tag) => (
              <span key={tag.label} {...stylex.props(styles.tag)}>
                {tag.label}: {tag.value}
              </span>
            ))}
          </div>
        ) : null}

        {detailText ? (
          <div {...stylex.props(styles.raw)}>
            <pre {...stylex.props(styles.rawText)}>{detailText}</pre>
          </div>
        ) : null}

        <Dialog.Footer className={stylex.props(styles.footerSpacing).className}>
          <Dialog.Close render={<Button type="button" variant="ghost" size="small" />}>
            {t('common.close', 'Close')}
          </Dialog.Close>
          <Button type="button" variant="secondary" size="small" onClick={handleCopy}>
            {copied ? (
              <Check {...stylex.props(styles.glyph, styles.glyphSuccess)} aria-hidden="true" />
            ) : (
              <Copy {...stylex.props(styles.glyph)} aria-hidden="true" />
            )}
            {copied
              ? t('sessions.systemNotices.chatFailed.copied', 'Copied')
              : t('sessions.systemNotices.chatFailed.copyError', 'Copy error')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
