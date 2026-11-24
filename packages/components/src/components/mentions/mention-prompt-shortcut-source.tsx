import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { compareSlashMatchRanks, rankSlashMatch } from '@/lib/command-slash-search';
import {
  resolveShortcutAvailability,
  type ShortcutAvailability,
} from '@lody/shared/prompt-shortcuts/model';
import type { PromptShortcutIndexEntry } from '@lody/shared/prompt-shortcuts/catalog';
import type { MentionCandidate, MentionCategorySources } from './mention-registry';

export type ShortcutMentionContext = Parameters<typeof resolveShortcutAvailability>[0]['context'];
export type ShortcutDependencyResolver = Parameters<
  typeof resolveShortcutAvailability
>[0]['resolveDependency'];
export const unverifiedShortcutDependency: ShortcutDependencyResolver = () => ({
  kind: 'unknown',
  reason: 'dependencies_unverified',
});

export function shortcutAvailabilityMessage(
  availability: ShortcutAvailability,
  t: TFunction
): string {
  if (availability.kind === 'available') return '';
  if (availability.kind === 'unknown') {
    return availability.reason === 'dependencies_unverified'
      ? t('promptShortcut.unverified', 'Dependencies cannot be verified yet.')
      : t('promptShortcut.checking', 'Checking availability…');
  }
  switch (availability.reason) {
    case 'project_mismatch':
      return t('promptShortcut.projectMismatch', 'Requires a different project.');
    case 'machine_mismatch':
      return t('promptShortcut.machineMismatch', 'Requires a different machine.');
    case 'provider_mismatch':
      return t('promptShortcut.providerMismatch', 'Requires a different agent.');
    case 'machine_offline':
      return t('promptShortcut.machineOffline', 'Required machine is offline.');
    case 'missing_scope':
      return t('promptShortcut.missingScope', 'A reference requires an explicit scope.');
    case 'reference_out_of_scope':
    case 'scope_mismatch':
      return t('promptShortcut.scopeMismatch', 'A reference does not match the saved scope.');
    case 'permission_denied':
      return t('promptShortcut.permissionDenied', 'A required reference is no longer accessible.');
    default:
      return t('promptShortcut.dependencyMissing', 'A required reference is unavailable.');
  }
}

export type PromptShortcutSourceInput = {
  entries: readonly PromptShortcutIndexEntry[];
  context: ShortcutMentionContext | null;
  loading?: boolean;
  resolveDependency?: ShortcutDependencyResolver;
};

/** Index-only discovery. This boundary deliberately has no body loader or runtime. */
export function selectPromptShortcutCandidates(
  input: PromptShortcutSourceInput,
  term: string,
  t: TFunction,
  limit = 50
): MentionCandidate[] {
  const context = input.context;
  if (!context) return [];
  const query = term.trim().toLowerCase();
  return input.entries
    .flatMap((entry): MentionCandidate[] => {
      // Never turn a foreign workspace entry into a diagnostic disclosure.
      if (entry.workspaceId !== context.workspaceId) return [];
      const exact = query !== '' && (entry.slug === query || entry.name.toLowerCase() === query);
      const slashRank = rankSlashMatch(
        { token: entry.slug, name: entry.name, description: entry.description ?? undefined },
        query
      );
      if (!slashRank) return [];
      const availability = input.loading
        ? { kind: 'unknown' as const, reason: 'context_loading' }
        : resolveShortcutAvailability({
            shortcut: entry,
            dependencies: entry.dependencySummary,
            context,
            canRead: true,
            resolveDependency: input.resolveDependency ?? unverifiedShortcutDependency,
          });
      if (availability.kind !== 'available' && !exact) return [];
      return [
        {
          value: `prompt-shortcut:${entry.id}`,
          label: entry.slug,
          insertText: `/${entry.slug}`,
          kind: 'prompt_shortcut',
          icon: 'prompt_shortcut',
          title: `/${entry.slug}`,
          hint: entry.description,
          slashRank,
          disabled: availability.kind !== 'available',
          disabledReason: shortcutAvailabilityMessage(availability, t) || undefined,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) ||
        (query ? compareSlashMatchRanks(a.slashRank!, b.slashRank!) : 0) ||
        a.label.localeCompare(b.label)
    )
    .slice(0, limit);
}

export function usePromptShortcutMentionSource(
  input: PromptShortcutSourceInput
): NonNullable<MentionCategorySources['promptShortcut']> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      enabled: true,
      status: input.loading || !input.context ? 'loading' : 'ready',
      getCandidates: (term, limit) => selectPromptShortcutCandidates(input, term, t, limit),
    }),
    [input, t]
  );
}
