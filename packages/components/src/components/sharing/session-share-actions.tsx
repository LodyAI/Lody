import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Copy, MessageSquare } from 'lucide-react';
import { toast } from '@/lib/toast';
import { ConversationColumn } from '@/components/shared/conversation-column';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { shareSurface } from './surface';

const styles = stylex.create({
  foot: {
    flexShrink: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    backgroundColor: colors.background,
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
  },
  notice: {
    margin: 0,
    marginTop: space[1.5],
    textAlign: 'center',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.secondaryLabel,
  },
  manual: { marginTop: space[2] },
});

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
    <div {...stylex.props(styles.foot)}>
      <ConversationColumn>
        <div {...stylex.props(styles.row)}>
          {createAgentPrompt && (
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={busy || copyDisabled}
              onClick={() => void copyAgentPrompt()}
              title={t(
                'sharing.agentAccessNotice',
                'Anyone receiving this prompt can read the shared conversations and images.'
              )}
            >
              <MessageSquare {...stylex.props(shareSurface.glyphSmall)} aria-hidden />
              <span {...stylex.props(shareSurface.buttonLabel)}>
                {t('sharing.copyAgentPrompt', 'Copy Agent Prompt')}
              </span>
            </Button>
          )}
          <Button type="button" size="small" disabled={copyDisabled} onClick={onCopyMarkdown}>
            <Copy {...stylex.props(shareSurface.glyphSmall)} aria-hidden />
            <span {...stylex.props(shareSurface.buttonLabel)}>
              {t('sharing.copyMarkdown', 'Copy as Markdown')}
            </span>
          </Button>
        </div>
        {createAgentPrompt && (
          <p {...stylex.props(styles.notice)}>
            {t(
              'sharing.agentAccessNotice',
              'Anyone receiving this prompt can read the shared conversations and images.'
            )}
          </p>
        )}
        {manualPrompt && (
          <Textarea
            readOnly
            resize="none"
            value={manualPrompt}
            aria-label={t('sharing.copyAgentPrompt', 'Copy Agent Prompt')}
            rows={6}
            onFocus={(event) => event.currentTarget.select()}
            className={stylex.props(styles.manual).className}
          />
        )}
      </ConversationColumn>
    </div>
  );
}
