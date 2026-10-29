import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import { formatDistanceToNow } from 'date-fns';
import { AlertCircle, Check, Download, RefreshCw, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Badge } from '@lody/ui/badge';
import type { LocalProjectHistoryCatalogItem, LocalProjectHistoryProvider } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { toIntlLocale } from '@/lib/intl-locale';
import { getVisibleLocalProjectHistoryFailures } from '@/lib/local-project-history-catalog';
import { AgentIcon } from '@/components/icons/agent-icon';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import {
  formatHistorySyncSummary,
  formatHistoryUpdatedAt,
  getHistoryProviderLabel,
  parseHistoryUpdatedAt,
  type ProjectHistoryImportState,
  type ProjectSettingsRow,
} from '@/components/settings/project-settings';
import { sheetSurface } from './sheet-surface';

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

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  pendingSpinnerSpacing: { marginRight: 'calc(var(--spacing) * 1.5)' },
  /** The title, with the provider's mark in front of it. */
  titleRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  /** The provider's mark. */
  providerGlyph: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[7],
    height: themeSpace[7],
    borderRadius: themeRadius.lg,
    backgroundColor: 'hsl(var(--primary) / 0.1)',
    color: themeColors.primary,
  },
  providerIcon: {
    width: themeSpace[4],
    height: themeSpace[4],
  },

  /** The status block, under the header. */
  statusSection: {
    flexShrink: 0,
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[3],
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[1],
  },
  statusText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  statusLabel: {
    fontSize: '0.8rem',
    color: themeColors.mutedForeground,
  },
  statusSummary: {
    marginTop: '0.125rem',
    fontSize: '0.72rem',
    lineHeight: 1.625,
    color: 'hsl(var(--muted-foreground) / 0.8)',
  },
  failureList: {
    marginTop: themeSpace[1],
    color: themeColors.destructive,
  },
  /** One failed conversation. The list's `space-y` lands here. */
  failureItem: {
    wordBreak: 'break-word',
    marginTop: '0px',
    marginBottom: { default: '0px', ':not(:last-child)': '0.125rem' },
  },
  /** The "N more failures" line, spaced like the ones above it. */
  failureTail: {
    marginTop: '0px',
    marginBottom: { default: '0px', ':not(:last-child)': '0.125rem' },
  },

  /** The sync action, beside the status it refreshes. */
  syncButton: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[1.5],
    paddingBottom: themeSpace[1.5],
    borderRadius: themeRadius.full,
    fontSize: '0.8rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.primary,
    backgroundColor: { default: null, ':hover': 'hsl(var(--primary) / 0.1)' },
    scale: { default: null, ':active': '0.97' },
    cursor: { default: null, ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.5 },
    ...TRANSITION_COLORS,
  },
  syncGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },

  /** The error banner, under the status. */
  errorBanner: {
    display: 'flex',
    marginTop: themeSpace[2],
    alignItems: 'flex-start',
    gap: themeSpace[2],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    borderRadius: themeRadius.xl,
    backgroundColor: 'hsl(var(--destructive) / 0.08)',
    fontSize: '0.72rem',
    color: themeColors.destructive,
  },
  errorGlyph: {
    marginTop: '1px',
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  errorText: {
    minWidth: 0,
    wordBreak: 'break-word',
  },

  /** The list of conversations. */
  listSection: {
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[3],
  },
  listCard: {
    overflow: 'hidden',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
  },
  /** The row that selects every conversation. */
  selectAllRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[3],
    paddingBottom: themeSpace[3],
    textAlign: 'left',
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.4)' },
    cursor: { default: null, ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.6 },
    ...TRANSITION_COLORS,
  },
  /** The checkbox in front of a row. */
  checkbox: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[5],
    height: themeSpace[5],
    borderRadius: themeRadius.md,
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.8)',
    ...TRANSITION_COLORS,
  },
  /** The checkbox of a picked row. */
  checkboxChecked: {
    borderColor: themeColors.primary,
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
  },
  checkGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  /** The select-all row's label. */
  selectAllLabel: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.85rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  /** The list's empty state. */
  emptyState: {
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[10],
    paddingBottom: themeSpace[10],
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  /** The list of conversations. */
  list: {
    maxHeight: '100%',
    overflowY: 'auto',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
  },
  /**
   * One conversation. The list's `divide-y` and `space-y` both land here:
   * a hairline under every conversation but the last, and a hair of space
   * between them.
   */
  listItem: {
    borderBottomWidth: { default: '0px', ':not(:last-child)': '1px' },
    borderBottomStyle: { default: 'none', ':not(:last-child)': 'solid' },
    borderBottomColor: 'hsl(var(--border) / 0.4)',
    marginTop: '0px',
    marginBottom: { default: '0px', ':not(:last-child)': '0.125rem' },
  },
  /** One conversation's row. */
  row: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[3],
    paddingBottom: themeSpace[3],
    textAlign: 'left',
    ...TRANSITION_COLORS,
  },
  /** A row that cannot be toggled. */
  rowLocked: {
    cursor: 'default',
    opacity: 0.7,
  },
  /** A row that can be toggled. */
  rowToggleable: {
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.4)' },
  },
  /** The row's text column. */
  rowText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  /** The conversation's title. */
  rowTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.9rem',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.25,
    color: themeColors.foreground,
  },
  /** The conversation's last activity. */
  rowUpdated: {
    marginTop: '0.125rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.72rem',
    color: themeColors.mutedForeground,
  },
  /** The row that resolves a conflict. */
  conflictAction: {
    paddingInlineStart: themeSpace[12],
    paddingInlineEnd: themeSpace[4],
    paddingBottom: themeSpace[3],
  },

  /** The glyph of the re-import action. */
  conflictGlyph: {
    marginRight: themeSpace[1.5],
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  /** The glyph of the import action. */
  importGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  /** The footer's import action. */
  footer: {
    flexShrink: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[3],
    paddingBottom:
      'calc(12px + max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))',
  },
});

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
  const providerLabel = state.providerLabel ?? getHistoryProviderLabel(state.provider);
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
        <DrawerContent className="mobile-acp-history-sheet h-[88dvh]! max-h-[88dvh]! rounded-t-2xl border-border/60">
          <div {...stylex.props(sheetSurface.column)}>
            {/* Header: provider chip centered, close on right */}
            <header {...stylex.props(sheetSurface.header, sheetSurface.headerShrink)}>
              <DrawerTitle
                {...stylex.props(sheetSurface.title, sheetSurface.titleCentered, styles.titleRow)}
              >
                <span {...stylex.props(styles.providerGlyph)}>
                  <AgentIcon
                    cliType={state.provider.cliType}
                    agentType={state.provider.agentType}
                    {...stylex.props(styles.providerIcon)}
                  />
                </span>
                {providerLabel}
              </DrawerTitle>
              <DrawerClose asChild>
                <button
                  type="button"
                  aria-label={t('common.close', 'Close')}
                  {...stylex.props(sheetSurface.iconButton, sheetSurface.iconButtonRight)}
                >
                  <X {...stylex.props(sheetSurface.glyph20)} aria-hidden="true" strokeWidth={1.8} />
                </button>
              </DrawerClose>
            </header>
            <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>
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
            <section {...stylex.props(styles.statusSection)}>
              <div {...stylex.props(styles.statusRow)}>
                <div {...stylex.props(styles.statusText)}>
                  <p {...stylex.props(styles.statusLabel)}>{statusLabel}</p>
                  {state.syncSummary ? (
                    <div {...stylex.props(styles.statusSummary)}>
                      <p>{formatHistorySyncSummary(state.syncSummary, t)}</p>
                      {syncFailures && syncFailures.failures.length > 0 ? (
                        <ul {...stylex.props(styles.failureList)}>
                          {syncFailures.failures.map((failure) => (
                            <li key={failure.acpSessionId} {...stylex.props(styles.failureItem)}>
                              {failure.acpSessionId}: {failure.message}
                            </li>
                          ))}
                          {syncFailures.remaining > 0 ? (
                            <li {...stylex.props(styles.failureTail)}>
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
                    {...stylex.props(styles.syncButton)}
                  >
                    {state.isSyncing ? (
                      <Spinner {...stylex.props(styles.syncGlyph)} aria-hidden="true" />
                    ) : (
                      <RefreshCw {...stylex.props(styles.syncGlyph)} aria-hidden="true" />
                    )}
                    {t('workspace.projects.syncHistory', 'Sync')}
                  </button>
                ) : null}
              </div>

              {state.errorMessage ? (
                <div {...stylex.props(styles.errorBanner)}>
                  <AlertCircle {...stylex.props(styles.errorGlyph)} aria-hidden="true" />
                  <span {...stylex.props(styles.errorText)}>{state.errorMessage}</span>
                </div>
              ) : null}
            </section>

            {/* Select-all + session list. Checkboxes live on the LEFT
             so they read as a checklist (left → right: pick, then
             title). Imported / conflict rows still show a status
             pill on the right since they aren't user-toggleable. */}
            <section {...stylex.props(styles.listSection)}>
              <div {...stylex.props(styles.listCard)}>
                {catalogSessions.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (selectableSessions.length > 0 && canManageCatalog) toggleSelectAll();
                    }}
                    disabled={selectableSessions.length === 0 || !canManageCatalog}
                    {...stylex.props(styles.selectAllRow)}
                  >
                    <span
                      {...stylex.props(
                        styles.checkbox,
                        allSelectableSelected && styles.checkboxChecked
                      )}
                    >
                      {allSelectableSelected ? (
                        <Check
                          {...stylex.props(styles.checkGlyph)}
                          strokeWidth={3}
                          aria-hidden="true"
                        />
                      ) : null}
                    </span>
                    <span {...stylex.props(styles.selectAllLabel)}>
                      {t('workspace.projects.selectAllHistory', {
                        defaultValue: 'Select all available ({{count}})',
                        count: selectableSessions.length,
                      })}
                    </span>
                  </button>
                ) : null}

                {catalogSessions.length === 0 ? (
                  <div {...stylex.props(styles.emptyState)}>
                    {t('workspace.projects.historyEmpty', {
                      defaultValue: 'No {{provider}} conversations found',
                      provider: providerLabel,
                    })}
                  </div>
                ) : (
                  <ul {...stylex.props(styles.list)}>
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
                        <li key={session.acpSessionId} {...stylex.props(styles.listItem)}>
                          <button
                            type="button"
                            disabled={selectionDisabled}
                            onClick={() => {
                              if (!selectionDisabled) toggleSession(session.acpSessionId);
                            }}
                            {...stylex.props(
                              styles.row,
                              selectionDisabled ? styles.rowLocked : styles.rowToggleable
                            )}
                          >
                            <span
                              {...stylex.props(styles.checkbox, selected && styles.checkboxChecked)}
                            >
                              {selected ? (
                                <Check
                                  {...stylex.props(styles.checkGlyph)}
                                  strokeWidth={3}
                                  aria-hidden="true"
                                />
                              ) : null}
                            </span>
                            <div {...stylex.props(styles.rowText)}>
                              <p {...stylex.props(styles.rowTitle)}>{session.title}</p>
                              <p {...stylex.props(styles.rowUpdated)} title={updatedAtTitle}>
                                {updatedAtLabel}
                              </p>
                            </div>
                            {imported ? (
                              <Badge>{t('workspace.projects.historyImported', 'Imported')}</Badge>
                            ) : conflict ? (
                              <Badge tone="danger">
                                {t('workspace.projects.historyConflict', 'Conflict')}
                              </Badge>
                            ) : null}
                          </button>
                          {conflict ? (
                            <div {...stylex.props(styles.conflictAction)}>
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
                                  <Spinner
                                    diameter="calc(var(--spacing) * 3.5)"
                                    className={stylex.props(styles.pendingSpinnerSpacing).className}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <RefreshCw
                                    {...stylex.props(styles.conflictGlyph)}
                                    aria-hidden="true"
                                  />
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
              <div {...stylex.props(styles.footer)}>
                <Button
                  type="button"
                  size="large"
                  width="100%"
                  disabled={!importEnabled}
                  onClick={() => {
                    void onImportHistory(row, state.provider);
                  }}
                >
                  {state.isImporting ? (
                    <Spinner diameter="calc(var(--spacing) * 4)" aria-hidden="true" />
                  ) : (
                    <Download {...stylex.props(styles.importGlyph)} aria-hidden="true" />
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
      <AlertDialog.Root
        open={conflictSessionToResolve !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConflictSessionToResolve(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('workspace.projects.resolveHistoryConflictTitle', {
                defaultValue: 'Re-import conversation?',
              })}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.projects.resolveHistoryConflictConfirm', {
                defaultValue:
                  'Re-import this conversation from {{provider}}? This replaces the current imported history with the latest source history and may discard local-only turns.',
                provider: providerLabel,
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action onClick={confirmConflictReplace} variant="destructive">
              {t('workspace.projects.resolveHistoryConflict', 'Re-import')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
