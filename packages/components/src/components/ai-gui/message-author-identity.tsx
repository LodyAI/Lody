import { memo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { AgentMessageAuthor, SessionId } from '@lody/shared';
import { Popover } from '@/ui/armed-overlays';
import { AgentIcon, AGENT_BRAND_ICONS } from '@/components/icons/agent-icon';
import { useSessionLinkNavigator } from './session-link-context';

const styles = stylex.create({
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: space[6],
    height: space[6],
    fontSize: text.titleSize,
  },
  glyph: { width: '1em', height: '1em' },
  name: { maxWidth: '12em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  details: { display: 'grid', gap: space[2], maxWidth: '20em', overflowWrap: 'anywhere' },
  muted: { color: colors.secondaryLabel, fontSize: text.captionSize },
});

/** Snapshot-only leaf: no Session, Provider or Role catalog subscriptions. */
export const MessageAuthorIdentity = memo(function MessageAuthorIdentity({
  author,
  compact = false,
}: {
  author: AgentMessageAuthor;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useSessionLinkNavigator();
  const name = author.role?.name ?? author.name;
  const BrandIcon = author.brandId ? AGENT_BRAND_ICONS[author.brandId] : undefined;
  const unknownIcon = <span>{Array.from(author.name)[0] ?? '?'}</span>;
  const icon = author.role?.emoji?.trim() ? (
    author.role.emoji
  ) : BrandIcon ? (
    <BrandIcon className={stylex.props(styles.glyph).className} />
  ) : author.cliType && author.agentType ? (
    <AgentIcon
      cliType={author.cliType}
      agentType={author.agentType}
      brandId={author.brandId}
      fallback={unknownIcon}
      className={stylex.props(styles.glyph).className}
    />
  ) : (
    unknownIcon
  );
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="small"
            icon={!compact}
            aria-label={t('sessions.messageAuthor.details', 'View sender: {{name}}', { name })}
          >
            <span {...stylex.props(styles.icon)} aria-hidden="true">
              {icon}
            </span>
            {compact ? <span {...stylex.props(styles.name)}>{name}</span> : null}
          </Button>
        }
      />
      <Popover.Content>
        <div {...stylex.props(styles.details)}>
          <strong>{name}</strong>
          {author.role ? <span {...stylex.props(styles.muted)}>{author.name}</span> : null}
          {author.model ? (
            <span>
              {t(
                author.model.source === 'runtime'
                  ? 'sessions.messageAuthor.model'
                  : 'sessions.messageAuthor.configuredModel',
                author.model.source === 'runtime'
                  ? 'Model: {{model}}'
                  : 'Configured model: {{model}}',
                { model: author.model.name ?? author.model.id }
              )}
            </span>
          ) : null}
          {author.reasoningEffort ? (
            <span>
              {t('sessions.messageAuthor.reasoning', 'Reasoning: {{value}}', {
                value: author.reasoningEffort,
              })}
            </span>
          ) : null}
          {author.fastMode !== undefined ? (
            <span>
              {t('sessions.messageAuthor.fast', 'Fast mode: {{value}}', {
                value: t(
                  author.fastMode ? 'sessions.messageAuthor.on' : 'sessions.messageAuthor.off',
                  author.fastMode ? 'On' : 'Off'
                ),
              })}
            </span>
          ) : null}
          {author.planMode !== undefined ? (
            <span>
              {t('sessions.messageAuthor.plan', 'Plan mode: {{value}}', {
                value: t(
                  author.planMode ? 'sessions.messageAuthor.on' : 'sessions.messageAuthor.off',
                  author.planMode ? 'On' : 'Off'
                ),
              })}
            </span>
          ) : null}
          {navigate ? (
            <Button
              variant="link"
              size="small"
              onClick={() => navigate({ sessionId: author.sessionId as SessionId })}
            >
              {t('sessions.messageAuthor.source', 'Open source conversation')}
            </Button>
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
});
