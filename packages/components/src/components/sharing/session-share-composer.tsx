import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Copy, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
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
  createAgentPrompt,
}: {
  onCopyMarkdown: () => void;
  copyDisabled: boolean;
  createAgentPrompt?: () => Promise<string>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  async function copyAgentPrompt() {
    if (!createAgentPrompt || busy) return;
    setBusy(true);
    setManualPrompt(null);
    try {
      const prompt = await createAgentPrompt();
      try {
        await navigator.clipboard.writeText(prompt);
        toast.success(t('sharing.agentPromptCopied', 'Prompt copied. Paste it into your agent.'));
      } catch {
        setManualPrompt(prompt);
      }
    } catch {
      toast.error(
        t('sharing.agentPromptFailed', 'Could not create agent access. Please try again later.')
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shrink-0 bg-background pb-3 pt-1">
      <ConversationColumn>
        <div className="relative">
          <div aria-hidden className="pointer-events-none select-none">
            <div className={cn(COMPOSER_SESSION_SURFACE_CLASS, 'min-h-[112px] opacity-70')}>
              <div className="px-2 pt-1.5 text-sm text-input-placeholder">
                {t('sharing.agentComposerPlaceholder', 'Continue with your own agent…')}
              </div>
              <div className="mt-auto flex items-center justify-end gap-1.5 pb-0.5 pr-0.5">
                <span className="h-7 w-7 rounded-md bg-muted-foreground/10" />
                <span className="h-7 w-7 rounded-full bg-muted-foreground/10" />
              </div>
            </div>
          </div>
          <div className="absolute inset-0 flex flex-wrap content-center items-center justify-center gap-2 rounded-xl bg-background/72 px-3 py-3 backdrop-blur-[2px] dark:bg-background/65">
            {createAgentPrompt && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || copyDisabled}
                onClick={() => void copyAgentPrompt()}
                title={t(
                  'sharing.agentAccessNotice',
                  'Anyone receiving this prompt can read the shared conversations and images.'
                )}
              >
                <MessageSquare className="size-3.5" aria-hidden />
                <span className="truncate">
                  {t('sharing.copyAgentPrompt', 'Copy Agent Prompt')}
                </span>
              </Button>
            )}
            <Button type="button" size="sm" disabled={copyDisabled} onClick={onCopyMarkdown}>
              <Copy className="size-3.5" aria-hidden />
              <span className="truncate">{t('sharing.copyMarkdown', 'Copy as Markdown')}</span>
            </Button>
          </div>
        </div>
        {createAgentPrompt && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {t(
              'sharing.agentAccessNotice',
              'Anyone receiving this prompt can read the shared conversations and images.'
            )}
          </p>
        )}
        {manualPrompt && (
          <textarea
            readOnly
            value={manualPrompt}
            aria-label={t('sharing.copyAgentPrompt', 'Copy Agent Prompt')}
            className="mt-2 w-full rounded-md border bg-background p-2 text-xs"
            rows={6}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
      </ConversationColumn>
    </div>
  );
}
