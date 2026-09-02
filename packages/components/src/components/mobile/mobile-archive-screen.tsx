import type { ReactNode } from 'react';
import { Archive, PanelLeft, Trash2, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { TooltipProvider } from '@/ui/tooltip';

export type MobileArchiveScreenProps = {
  isMultiSelectMode: boolean;
  selectedCount: number;
  isBulkActionBusy: boolean;
  bulkRestoreDisabled?: boolean;
  bulkRestoreDisabledReason?: string;
  onExitMultiSelect: () => void;
  onBulkRestore: () => void;
  onRequestBulkDelete: () => void;
  onOpenMobileDrawer: () => void;
  dialogs: ReactNode;
  children: ReactNode;
};

/**
 * Mobile Archive chrome. Scope / sort / group filters live next to the
 * search field in the page body (see `archive-view.tsx`), not in this
 * header — matching the chat home pattern of filter-after-search.
 */
export function MobileArchiveScreen({
  isMultiSelectMode,
  selectedCount,
  isBulkActionBusy,
  bulkRestoreDisabled = false,
  bulkRestoreDisabledReason,
  onExitMultiSelect,
  onBulkRestore,
  onRequestBulkDelete,
  onOpenMobileDrawer,
  dialogs,
  children,
}: MobileArchiveScreenProps) {
  const { t } = useTranslation();

  return (
    <TooltipProvider>
      <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background">
        <header className="flex h-[calc(56px+var(--safe-area-top))] w-full shrink-0 items-center gap-3 border-b border-border bg-background pl-[calc(16px+var(--safe-area-left))] pr-[calc(16px+var(--safe-area-right))] pt-[var(--safe-area-top)]">
          {isMultiSelectMode ? (
            <>
              <Button variant="ghost" size="large" icon onClick={onExitMultiSelect}>
                <X className="h-4 w-4" />
                <span className="sr-only">{t('archive.multiSelect.exit', 'Exit selection')}</span>
              </Button>
              <span className="text-sm text-muted-foreground">
                {t('archive.multiSelect.selected', '{{count}} selected', {
                  count: selectedCount,
                })}
              </span>
              <div className="flex-1" />
              <Button
                variant="secondary"
                size="small"
                disabled={selectedCount === 0 || isBulkActionBusy || bulkRestoreDisabled}
                title={bulkRestoreDisabled ? bulkRestoreDisabledReason : undefined}
                onClick={onBulkRestore}
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t('archive.multiSelect.restore', 'Restore')}
              </Button>
              <Button
                variant="destructive"
                size="small"
                disabled={selectedCount === 0 || isBulkActionBusy}
                onClick={onRequestBulkDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('archive.multiSelect.delete', 'Delete')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="large" icon onClick={onOpenMobileDrawer}>
                <PanelLeft className="h-4 w-4" />
                <span className="sr-only">Open sidebar</span>
              </Button>
              <div className="flex items-center gap-2">
                <Archive className="h-4 w-4 text-muted-foreground" />
                <h1 className="text-sm font-semibold">{t('archive.title', 'Archive')}</h1>
              </div>
            </>
          )}
        </header>

        <div className="min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          {children}
        </div>
        {dialogs}
      </div>
    </TooltipProvider>
  );
}
