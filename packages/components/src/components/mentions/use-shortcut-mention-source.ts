import { useAtomValue } from 'jotai';
import { promptShortcutsFeatureEnabledAtom } from '@/atoms/settings';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PromptShortcutError, type PromptShortcutScope } from '@lody/shared/prompt-shortcuts';
import { usePromptShortcuts } from '../../providers/prompt-shortcut-provider';
import type { MentionCategorySources } from './mention-registry';
import {
  selectPromptShortcutCandidates,
  shortcutAvailabilityMessage,
  type ShortcutMentionContext,
} from './mention-prompt-shortcut-source';
import { prepareShortcutSelection, ShortcutSelectionUnavailable } from './shortcut-selection';

/** Workspace provider owns the runtime. Each composer owns only a cancellable selection. */
export function useShortcutMentionSource(
  scope: PromptShortcutScope | null,
  draftKey?: string
): MentionCategorySources['promptShortcut'] {
  const featureEnabled = useAtomValue(promptShortcutsFeatureEnabledAtom);
  const { t } = useTranslation();
  const { runtime, entries, loading } = usePromptShortcuts();
  const context = useMemo<ShortcutMentionContext | null>(
    () =>
      featureEnabled && runtime && scope
        ? {
            workspaceId: runtime.workspaceId,
            userId: runtime.userId,
            scope,
          }
        : null,
    [featureEnabled, runtime, scope]
  );
  const scopeKey = JSON.stringify([context, draftKey]);
  const current = useRef({ runtime, scopeKey });
  current.current = { runtime, scopeKey };
  const [selection, setSelection] = useState<{
    runtime: typeof runtime;
    scopeKey: string;
    id: string;
    token: object;
    status: 'loading' | 'error';
    message?: string;
  } | null>(null);
  const activeSelection =
    selection && selection.runtime === runtime && selection.scopeKey === scopeKey
      ? selection
      : null;
  return useMemo(
    () => ({
      enabled: context !== null,
      status: loading || !runtime ? 'loading' : 'ready',
      getCandidates: (term, limit) =>
        selectPromptShortcutCandidates({ entries, context, loading }, term, t, limit).map(
          (candidate) => {
            const entry = entries.find((item) => `prompt-shortcut:${item.id}` === candidate.value)!;
            const state = activeSelection?.id === entry.id ? activeSelection : null;
            return {
              ...candidate,
              disabled: candidate.disabled || !runtime || state?.status === 'loading',
              disabledReason:
                state?.status === 'loading'
                  ? t('promptShortcut.loadingBody', 'Loading Shortcut…')
                  : (state?.message ?? candidate.disabledReason),
              onPrepare: async (request) => {
                if (!runtime || !context) return null;
                const token = {};
                const isCurrent = () =>
                  current.current.runtime === runtime && current.current.scopeKey === scopeKey;
                const clear = () =>
                  setSelection((previous) => (previous?.token === token ? null : previous));
                request.signal.addEventListener('abort', clear, { once: true });
                setSelection({ runtime, scopeKey, id: entry.id, token, status: 'loading' });
                try {
                  const result = await prepareShortcutSelection({
                    runtime,
                    entry,
                    context,
                    request,
                    isCurrent,
                    createId: () => crypto.randomUUID(),
                  });
                  clear();
                  return result;
                } catch (error) {
                  if (!request.signal.aborted && isCurrent()) {
                    const message =
                      error instanceof ShortcutSelectionUnavailable
                        ? shortcutAvailabilityMessage(error.availability, t)
                        : error instanceof PromptShortcutError && error.code === 'revision_pending'
                          ? t(
                              'promptShortcut.versionChanged',
                              'Shortcut changed. Select it again to retry.'
                            )
                          : typeof navigator !== 'undefined' && navigator.onLine === false
                            ? t(
                                'promptShortcut.bodyOffline',
                                'Body is not available offline. Reconnect and select again.'
                              )
                            : t(
                                'promptShortcut.loadFailed',
                                'Could not load Shortcut. Select it again to retry.'
                              );
                    setSelection((previous) =>
                      previous?.token === token
                        ? { ...previous, status: 'error', message }
                        : previous
                    );
                  }
                  return null;
                } finally {
                  request.signal.removeEventListener('abort', clear);
                }
              },
            };
          }
        ),
    }),
    [activeSelection, context, entries, loading, runtime, scopeKey, t]
  );
}
