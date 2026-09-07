import type { ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Archive, ChevronDown, PanelLeft, Trash2, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { navigationSidebarHiddenAtom, showNavigationSidebarAtom } from '@/atoms/layout-state';
import { isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { useWindowDragRegionClass, useWindowsCaptionPadClass } from '@/ui/window-drag-region';
import { isNativeAppShell } from '@/lib/native-platform';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { TooltipProvider } from '@/ui/tooltip';

type ArchiveScope = 'my' | 'team';

export type WebArchiveScreenProps = {
  archiveScope: ArchiveScope;
  isMultiSelectMode: boolean;
  selectedCount: number;
  isBulkActionBusy: boolean;
  bulkRestoreDisabled?: boolean;
  bulkRestoreDisabledReason?: string;
  onArchiveScopeChange: (scope: ArchiveScope) => void;
  onExitMultiSelect: () => void;
  onBulkRestore: () => void;
  onRequestBulkDelete: () => void;
  dialogs: ReactNode;
  children: ReactNode;
};

export function WebArchiveScreen({
  archiveScope,
  isMultiSelectMode,
  selectedCount,
  isBulkActionBusy,
  bulkRestoreDisabled = false,
  bulkRestoreDisabledReason,
  onArchiveScopeChange,
  onExitMultiSelect,
  onBulkRestore,
  onRequestBulkDelete,
  dialogs,
  children,
}: WebArchiveScreenProps) {
  const { t } = useTranslation();
  const isLeftSidebarHidden = useAtomValue(navigationSidebarHiddenAtom);
  const showNavigationSidebar = useSetAtom(showNavigationSidebarAtom);
  const isElectronFullscreen = useElectronFullscreen();
  const windowDragClass = useWindowDragRegionClass();
  const windowsCaptionPadClass = useWindowsCaptionPadClass();
  // Traffic lights auto-hide in native fullscreen — no inset to reserve then.
  // Mirrors the same derivation in session-detail.tsx.
  const hasMacOSTitlebarInset =
    !isNativeAppShell() && isMacOSElectronRenderer() && !isElectronFullscreen;

  return (
    <TooltipProvider>
      <div className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background">
        {/* h-11 row: matches the session tab-bar header height so the collapse /
            expand affordance sits at the same spot across views. */}
        <header
          className={cn(
            'flex h-[calc(2.75rem+var(--safe-area-top))] w-full shrink-0 items-center gap-3 border-b border-border bg-background pl-[calc(16px+var(--safe-area-left))] pr-[calc(16px+var(--safe-area-right))] pt-[var(--safe-area-top)]',
            isLeftSidebarHidden && hasMacOSTitlebarInset && 'pl-[4.5rem]',
            windowDragClass,
            windowsCaptionPadClass
          )}
        >
          {isLeftSidebarHidden ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => showNavigationSidebar()}
              aria-label={t('sessions.leftSidebar.show', 'Show navigation sidebar')}
              className="-ml-1 h-7 w-7 shrink-0 text-muted-foreground"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          ) : null}
          {isMultiSelectMode ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={onExitMultiSelect}
              >
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
                variant="outline"
                size="sm"
                disabled={selectedCount === 0 || isBulkActionBusy || bulkRestoreDisabled}
                title={bulkRestoreDisabled ? bulkRestoreDisabledReason : undefined}
                onClick={onBulkRestore}
                className="gap-1.5"
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t('archive.multiSelect.restore', 'Restore')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={selectedCount === 0 || isBulkActionBusy}
                onClick={onRequestBulkDelete}
                className="gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('archive.multiSelect.delete', 'Delete')}
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Archive className="h-4 w-4 text-muted-foreground" />
                <h1 className="text-sm font-semibold">{t('archive.title', 'Archive')}</h1>
              </div>
              <div className="ml-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex min-w-0 max-w-full select-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium',
                        'text-muted-foreground hover:bg-hover/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/30'
                      )}
                    >
                      <span className="min-w-0 truncate">
                        {archiveScope === 'my'
                          ? t('sessions.sidebar.my', 'My Tasks')
                          : t('sessions.sidebar.team', 'All Tasks')}
                      </span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    <DropdownMenuRadioGroup
                      value={archiveScope}
                      onValueChange={(value) => {
                        if (value === 'my' || value === 'team') {
                          onArchiveScopeChange(value);
                        }
                      }}
                    >
                      <DropdownMenuRadioItem value="my">
                        {t('sessions.sidebar.my', 'My Tasks')}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="team">
                        {t('sessions.sidebar.team', 'All Tasks')}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          )}
        </header>

        {/* Plain overflow scroller (not Radix ScrollArea): Radix's viewport uses
            display:table which shrink-wraps children and never fills the pane. */}
        <div className="min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          {children}
        </div>
        {dialogs}
      </div>
    </TooltipProvider>
  );
}
