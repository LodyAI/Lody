import { ExternalLink, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentConfigCliType, AgentType } from '@lody/shared';

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
    modelId !== 'deepseek-v4-pro'
  );
}

/** Shared contents for the linked warning rendered by desktop and mobile run config. */
export function DeepSeekDelegationWarningContent() {
  const { t } = useTranslation();

  return (
    <>
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
      <span className="min-w-0 text-xs leading-snug text-foreground/90">
        {t(
          'chat.runConfig.deepseek.delegationWarning',
          "Due to a current DSH limitation, delegated subagents may use the session's creation-time model (DeepSeek-V4-Pro) instead of this model, which can cost more."
        )}{' '}
        <span className="inline-flex items-center gap-1 font-medium text-status-warning underline underline-offset-2">
          {t('chat.runConfig.deepseek.delegationDiscussion', 'Upstream discussion')}
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
        </span>
      </span>
    </>
  );
}
