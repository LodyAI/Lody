import { useTranslation } from 'react-i18next';
import { Copy, GitFork } from 'lucide-react';
import { COMPOSER_SESSION_SURFACE_CLASS } from '@/components/chat/composer-surface';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

/**
 * The share reader's foot: the product composer's exact resting surface,
 * inert, with the visitor's two real actions floated over it.
 *
 * A visitor cannot write here — the reader has no session, agent or workspace —
 * so the composer is scenery that says what this page would be if it were
 * yours. It is `aria-hidden` and non-focusable: assistive technology reaches
 * only the two buttons, and Tab never lands in a text field that does nothing.
 */
export function SessionShareComposer({
  onCopyMarkdown,
  copyDisabled,
  showFork = true,
}: {
  onCopyMarkdown: () => void;
  copyDisabled: boolean;
  /** Fork takes the whole share, so only the main pane offers it. */
  showFork?: boolean;
}) {
  const { t } = useTranslation();
  const forkLabel = t('sharing.forkComingSoon', 'Fork to my Lody workspace (coming soon)');
  return (
    <div className="shrink-0 bg-background pb-3 pt-1">
      <ConversationColumn>
        <div className="relative">
          <div aria-hidden className="pointer-events-none select-none">
            <div className={cn(COMPOSER_SESSION_SURFACE_CLASS, 'min-h-[112px] opacity-70')}>
              <div className="px-2 pt-1.5 text-sm text-input-placeholder">
                {t('sharing.composerPlaceholder', 'Ask a follow-up in your own workspace…')}
              </div>
              <div className="mt-auto flex items-center justify-end gap-1.5 pb-0.5 pr-0.5">
                <span className="h-7 w-7 rounded-md bg-muted-foreground/10" />
                <span className="h-7 w-7 rounded-full bg-muted-foreground/10" />
              </div>
            </div>
          </div>
          <div className="absolute inset-0 flex flex-wrap content-center items-center justify-center gap-2 rounded-xl bg-background/72 px-3 py-3 backdrop-blur-[2px] dark:bg-background/65">
            {showFork && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled
                title={forkLabel}
                aria-label={forkLabel}
              >
                <GitFork className="size-3.5" aria-hidden />
                <span className="truncate">{t('sharing.fork', 'Fork to my Lody workspace')}</span>
                <span className="rounded-sm bg-muted px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('common.comingSoon', 'Soon')}
                </span>
              </Button>
            )}
            <Button type="button" size="sm" disabled={copyDisabled} onClick={onCopyMarkdown}>
              <Copy className="size-3.5" aria-hidden />
              <span className="truncate">{t('sharing.copyMarkdown', 'Copy as Markdown')}</span>
            </Button>
          </div>
        </div>
      </ConversationColumn>
    </div>
  );
}
