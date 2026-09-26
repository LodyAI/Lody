import { ExternalLink, ShieldAlert } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { AgentConfigCliType, AgentType } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  warningIcon: {
    marginTop: '2px',
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: colors.warning,
  },
  copy: {
    minWidth: 0,
    fontSize: '12px',
    lineHeight: 1.375,
    color: `color-mix(in oklab, ${colors.label} 90%, transparent)`,
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    fontWeight: 500,
    color: colors.warning,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
  },
  linkIcon: { width: '12px', height: '12px', flexShrink: 0 },
});

export const DEEPSEEK_DELEGATION_DISCUSSION_URL =
  'https://github.com/deepseek-ai/deepseek-harness/discussions/4065';

export function shouldShowDeepSeekDelegationWarning({
  cliType,
  agentType,
  modelId,
}: {
  cliType: AgentConfigCliType | null | undefined;
  agentType: AgentType | null | undefined;
  modelId: string | null | undefined;
}): boolean {
  return (
    cliType === 'builtin' &&
    agentType === 'deepseek' &&
    modelId != null &&
    modelId !== 'deepseek-flash'
  );
}

/** Shared contents for the linked warning rendered by desktop and mobile run config. */
export function DeepSeekDelegationWarningContent() {
  const { t } = useTranslation();

  return (
    <>
      <ShieldAlert {...stylex.props(styles.warningIcon)} aria-hidden="true" />
      <span {...stylex.props(styles.copy)}>
        {t(
          'chat.runConfig.deepseek.delegationWarning',
          "Due to a current DSH limitation, delegated subagents may use the session's creation-time model (DeepSeek-V41-Flash) instead of this model, which can cost more."
        )}{' '}
        <span {...stylex.props(styles.link)}>
          {t('chat.runConfig.deepseek.delegationDiscussion', 'Upstream discussion')}
          <ExternalLink {...stylex.props(styles.linkIcon)} aria-hidden="true" />
        </span>
      </span>
    </>
  );
}
