import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Locale } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, Check, Download, Loader2, RefreshCw, X } from 'lucide-react';
import type { LocalProjectHistoryCatalogItem, LocalProjectHistoryProvider } from '@lody/shared';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { toIntlLocale } from '@/lib/intl-locale';
import { getVisibleLocalProjectHistoryFailures } from '@/lib/local-project-history-catalog';
import { AgentIcon } from '@/components/icons/agent-icon';
import {
  formatHistorySyncSummary,
  formatHistoryUpdatedAt,
  getHistoryProviderLabel,
  parseHistoryUpdatedAt,
  type ProjectHistoryImportState,
  type ProjectSettingsRow,
} from '@/components/settings/project-settings';

export type MobileAcpHistorySheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ProjectSettingsRow;
  state: ProjectHistoryImportState;
  onSyncHistory: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
};

const EMPTY_CATALOG_SESSIONS: LocalProjectHistoryCatalogItem[] = [];

/**
 * Mobile-native bottom sheet for the per-provider ACP history sync /
 * import flow. Replaces the in-place drill in `MobileLocalProjectSettings`
 * (which collided with the surrounding project page's own back chip and
 * showed two back buttons).
 *
 * Layout, top → bottom:
 *   - Header chip: provider icon + name + ⨉ close
 *   - Status row: "Last synced …" + prominent Sync button (icon-only
 *     button with full ring; bigger touch target than the desktop chip)
 *   - Optional error banner (destructive-tinted)
 *   - Optional sync summary (subtle)
 *   - "Select all" toggle row (iOS-style large tap target)
 *   - Session list with iOS-style rows; selected → primary check on
 *     the right, imported / conflict shown as small pill on the right
 *   - Sticky footer: prominent "Import N selected" button (only when
 *     N > 0), safe-area aware
 */
export function MobileAcpHistorySheet({
  open,
  onOpenChange,
  row,
  state,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
}: MobileAcpHistorySheetProps) {
  const { t, i18n } = useTranslation();
  const localeObj: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const intlLocale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language);
  const providerLabel = getHistoryProviderLabel(state.provider);
  const [conflictSessionToResolve, setConflictSessionToResolve] =
    useState<LocalProjectHistoryCatalogItem | null>(null);

  const catalogSessions = state.catalog?.sessions ?? EMPTY_CATALOG_SESSIONS;
  const selectedSet = useMemo(() => new Set(state.selectedSessionIds), [state.selectedSessionIds]);
  const canManageCatalog = state.canSync && !state.isImporting;
  const selectableSessions = useMemo(
    () =>
      state.canSync
        ? catalogSessions.filter(
            (session) => session.status !== 'imported' && session.status !== 'sync_conflict'
          )
        : [],
    [catalogSessions, state.canSync]
  );
  const allSelectableSelected =
    selectableSessions.length > 0 &&
    selectableSessions.every((session) => selectedSet.has(session.acpSessionId));
  const lastListedAtDate =
    typeof state.catalog?.lastListedAt === 'number' ? new Date(state.catalog.lastListedAt) : null;
  const statusLabel = lastListedAtDate
    ? t('workspace.projects.historyLastSynced', {
        defaultValue: 'Last synced {{relative}}',
        relative: formatDistanceToNow(lastListedAtDate, {
          addSuffix: true,
          locale: localeObj,
        }),
      })
    : t('workspace.projects.historyNotSyncedYet', { defaultValue: 'Not synced yet' });
  const syncFailures = state.syncSummary
    ? getVisibleLocalProjectHistoryFailures(state.syncSummary)
    : null;

  const updateSelection = (selectedIds: string[]) => {
    onHistorySelectionChange(row, state.provider, selectedIds);
  };

  const confirmConflictReplace = () => {
    const session = conflictSessionToResolve;
    if (!session) return;
    setConflictSessionToResolve(null);
    void onResolveHistoryConflict?.(row, state.provider, session);
  };

  const toggleSession = (acpSessionId: string) => {
    const next = new Set(selectedSet);
    if (next.has(acpSessionId)) {
      next.delete(acpSessionId);
    } else {
      next.add(acpSessionId);
    }
    updateSelection([...next]);
  };

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      updateSelection([]);
      return;
    }
    updateSelection(selectableSessions.map((session) => session.acpSessionId));
  };

  const selectedCount = state.selectedSessionIds.length;
  const importEnabled = selectedCount > 0 && canManageCatalog;

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
        <DrawerContent
          className={cn(
            'mobile-acp-history-sheet',
            'h-[88dvh]! max-h-[88dvh]! rounded-t-2xl border-border/60'
          )}
        >
          <div className="flex h-full min-h-0 flex-col">
            {/* Header: provider chip centered, close on right */}
            <header className="relative flex shrink-0 items-center px-4 pb-2 pt-2">
              <DrawerTitle className="mx-auto inline-flex items-center gap-2 text-[0.95rem] font-semibold tracking-tight">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <AgentIcon
                    cliType={state.provider.cliType}
                    agentType={state.provider.agentType}
                    className="h-4 w-4"
                  />
                </span>
                {providerLabel}
              </DrawerTitle>
              <DrawerClose asChild>
                <button
                  type="button"
                  aria-label={t('common.close', 'Close')}
                  className={cn(
                    'absolute right-3 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full',
                    'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'
                  )}
                >
                  <X className="h-5 w-5" aria-hidden="true" strokeWidth={1.8} />
                </button>
              </DrawerClose>
            </header>
            <DrawerDescription className="sr-only">
              {t('workspace.projects.historySyncSection', '对话同步')}
            </DrawerDescription>

            {/* Status + Sync — inline, no card border around just the
             timestamp. The previous card chrome made the timestamp +
             Sync button read as two separate widgets balanced against
             each other (passive muted text vs an outlined control).
             Stripping the card and using a primary-tinted ghost
             button puts the action subordinate to the status it
             refreshes — same iOS pattern where "Refresh" is a text
             action, not a bordered button.

             `syncSummary` slips under the status as a second line so
             the two narrations of "last sync" hang together; the
             error banner sits as its own full-width strip below. */}
            <section className="shrink-0 px-4 pb-3 pt-1">
              <div className="flex items-center justify-between gap-3 py-1">
                <div className="min-w-0 flex-1">
                  <p className="text-[0.8rem] text-muted-foreground">{statusLabel}</p>
                  {state.syncSummary ? (
                    <div className="mt-0.5 text-[0.72rem] leading-relaxed text-muted-foreground/80">
                      <p>{formatHistorySyncSummary(state.syncSummary, t)}</p>
                      {syncFailures && syncFailures.failures.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-destructive">
                          {syncFailures.failures.map((failure) => (
                            <li key={failure.acpSessionId} className="break-words">
                              {failure.acpSessionId}: {failure.message}
                            </li>
                          ))}
                          {syncFailures.remaining > 0 ? (
                            <li>
                              {t('workspace.projects.historySyncMoreFailures', {
                                defaultValue: '{{count}} more failures',
                                count: syncFailures.remaining,
                              })}
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {state.canSync ? (
                  <button
                    type="button"
                    disabled={state.isSyncing || state.isImporting}
                    onClick={() => {
                      void onSyncHistory(row, state.provider);
                    }}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5',
                      'text-[0.8rem] font-medium text-primary',
                      'transition-colors hover:bg-primary/10 active:scale-[0.97]',
                      'disabled:cursor-default disabled:opacity-50'
                    )}
                  >
                    {state.isSyncing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {t('workspace.projects.syncHistory', 'Sync')}
                  </button>
                ) : null}
              </div>

              {state.errorMessage ? (
                <div
                  className={cn(
                    'mt-2 flex items-start gap-2 rounded-xl bg-destructive/8 px-3 py-2',
                    'text-[0.72rem] text-destructive'
                  )}
                >
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 break-words">{state.errorMessage}</span>
                </div>
              ) : null}
            </section>

            {/* Select-all + session list. Checkboxes live on the LEFT
             so they read as a checklist (left → right: pick, then
             title). Imported / conflict rows still show a status
             pill on the right since they aren't user-toggleable. */}
            <section className="flex min-h-0 flex-1 flex-col px-4 pb-3">
              <div className="overflow-hidden rounded-2xl border border-border/40 bg-card">
                {catalogSessions.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (selectableSessions.length > 0 && canManageCatalog) toggleSelectAll();
                    }}
                    disabled={selectableSessions.length === 0 || !canManageCatalog}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-3 text-left',
                      'transition-colors active:bg-muted/40',
                      'disabled:cursor-default disabled:opacity-60'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
                        allSelectableSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border/80'
                      )}
                    >
                      {allSelectableSelected ? (
                        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[0.85rem] font-medium text-foreground">
                      {t('workspace.projects.selectAllHistory', {
                        defaultValue: 'Select all available ({{count}})',
                        count: selectableSessions.length,
                      })}
                    </span>
                  </button>
                ) : null}

                {catalogSessions.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {t('workspace.projects.historyEmpty', {
                      defaultValue: 'No {{provider}} conversations found',
                      provider: providerLabel,
                    })}
                  </div>
                ) : (
                  <ul className="max-h-full divide-y divide-border/40 overflow-y-auto border-t border-border/40">
                    {catalogSessions.map((session) => {
                      const imported = session.status === 'imported';
                      const conflict = session.status === 'sync_conflict';
                      const selectionDisabled = imported || conflict || !canManageCatalog;
                      const selected = imported || selectedSet.has(session.acpSessionId);
                      const resolving = state.resolvingSessionIds.includes(session.acpSessionId);
                      const canResolveConflict =
                        conflict &&
                        state.canSync &&
                        !state.isSyncing &&
                        !state.isImporting &&
                        !resolving &&
                        Boolean(session.importedSessionId) &&
                        Boolean(onResolveHistoryConflict);
                      const updatedAtDate = parseHistoryUpdatedAt(session.updatedAt);
                      const updatedAtLabel = formatHistoryUpdatedAt(
                        session.updatedAt,
                        localeObj,
                        t
                      );
                      const updatedAtTitle = updatedAtDate
                        ? updatedAtDate.toLocaleString(intlLocale)
                        : session.acpSessionId;
                      return (
                        <li key={session.acpSessionId}>
                          <button
                            type="button"
                            disabled={selectionDisabled}
                            onClick={() => {
                              if (!selectionDisabled) toggleSession(session.acpSessionId);
                            }}
                            className={cn(
                              'flex w-full items-center gap-3 px-4 py-3 text-left',
                              'transition-colors',
                              selectionDisabled ? 'cursor-default opacity-70' : 'active:bg-muted/40'
                            )}
                          >
                            <span
                              className={cn(
                                'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
                                selected
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-border/80'
                              )}
                            >
                              {selected ? (
                                <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
                              ) : null}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[0.9rem] font-medium leading-tight text-foreground">
                                {session.title}
                              </p>
                              <p
                                className="mt-0.5 truncate text-[0.72rem] text-muted-foreground"
                                title={updatedAtTitle}
                              >
                                {updatedAtLabel}
                              </p>
                            </div>
                            {imported ? (
                              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                                {t('workspace.projects.historyImported', 'Imported')}
                              </span>
                            ) : conflict ? (
                              <span className="shrink-0 rounded-full bg-destructive/12 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-destructive">
                                {t('workspace.projects.historyConflict', 'Conflict')}
                              </span>
                            ) : null}
                          </button>
                          {conflict ? (
                            <div className="px-4 pb-3 pl-12">
                              <Button
                                type="button"
                                variant="secondary"
                                size="small"
                                shape="pill"
                                disabled={!canResolveConflict}
                                onClick={() => {
                                  if (!canResolveConflict) return;
                                  setConflictSessionToResolve(session);
                                }}
                              >
                                {resolving ? (
                                  <Loader2
                                    className="mr-1.5 h-3.5 w-3.5 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                                )}
                                {t('workspace.projects.resolveHistoryConflict', 'Re-import')}
                              </Button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            {/* Sticky Import action — full-width primary button at the
             bottom. Only mounts when the user has selected something
             so the resting state of the sheet stays minimal. */}
            {selectedCount > 0 ? (
              <div
                className={cn(
                  'shrink-0 border-t border-border/40 px-4 pt-3',
                  'pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)-var(--native-keyboard-height,0px)))]'
                )}
              >
                <Button
                  type="button"
                  size="large"
                  className="w-full"
                  disabled={!importEnabled}
                  onClick={() => {
                    void onImportHistory(row, state.provider);
                  }}
                >
                  {state.isImporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="h-4 w-4" aria-hidden="true" />
                  )}
                  {t('workspace.projects.importSelectedHistoryCount', {
                    defaultValue: 'Import {{count}} selected',
                    count: selectedCount,
                  })}
                </Button>
              </div>
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>
      <AlertDialog
        open={conflictSessionToResolve !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConflictSessionToResolve(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.projects.resolveHistoryConflictTitle', {
                defaultValue: 'Re-import conversation?',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.projects.resolveHistoryConflictConfirm', {
                defaultValue:
                  'Re-import this conversation from {{provider}}? This replaces the current imported history with the latest source history and may discard local-only turns.',
                provider: providerLabel,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmConflictReplace} variant="destructive"
            >
              {t('workspace.projects.resolveHistoryConflict', 'Re-import')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
