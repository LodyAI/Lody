import type { TFunction } from 'i18next';

type PrPromptTarget = {
  repoFullName: string;
  prNumber: number | null;
  prUrl: string;
};

const prLabel = (args: PrPromptTarget) => (args.prNumber ? `#${args.prNumber}` : args.prUrl);

/** The user's request plus the PR identity; the agent reads the failing checks itself. */
export function buildFixCiErrorsPrompt(args: PrPromptTarget, t: TFunction): string {
  return t('sessions.prompts.fixCiErrors', {
    repoFullName: args.repoFullName,
    prLabel: prLabel(args),
    prUrl: args.prUrl,
  });
}

export function buildResolvePrConflictsPrompt(args: PrPromptTarget, t: TFunction): string {
  return t('sessions.prompts.resolveConflicts', {
    repoFullName: args.repoFullName,
    prLabel: prLabel(args),
    prUrl: args.prUrl,
  });
}
