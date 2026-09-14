import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Copy, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { Button } from '@/ui/button';

/**
 * The share reader's foot: the two things a visitor can actually do with a
 * published conversation.
 *
 * It deliberately does not imitate the product composer. A visitor has no
 * session, agent or workspace, so a text field here can only be scenery — and
 * scenery that tall takes a composer's worth of height away from the
 * transcript, which is the only thing this page exists to show. One action row
 * costs a fraction of that and stays honest about what the page offers.
 */
export function SessionShareActions({
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
    <div className="shrink-0 bg-background px-3 py-2">
      <ConversationColumn>
        <div className="flex flex-wrap items-center justify-center gap-2">
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
              <span className="truncate">{t('sharing.copyAgentPrompt', 'Copy Agent Prompt')}</span>
            </Button>
          )}
          <Button type="button" size="sm" disabled={copyDisabled} onClick={onCopyMarkdown}>
            <Copy className="size-3.5" aria-hidden />
            <span className="truncate">{t('sharing.copyMarkdown', 'Copy as Markdown')}</span>
          </Button>
        </div>
        {createAgentPrompt && (
          <p className="mt-1.5 text-center text-[11px] leading-tight text-muted-foreground">
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
