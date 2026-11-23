import { useFoldAwareSheetHeight } from './use-vertical-division';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type {
  WorktreeCleanupScriptConfig,
  WorktreeSetupScriptConfig,
  WorktreeSetupShell,
} from '@lody/shared';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { cn } from '@/lib/utils';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { WorktreeSetupEditor } from '@/components/settings/project-settings';

export type MobileWorktreeConfigSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /* Local projects pass the machine's detected shell so each editor renders a
     single textarea; GitHub omits it so the editors render Bash / PowerShell
     tabs (a repo can be cloned on either OS). */
  shell?: WorktreeSetupShell;
  setupConfig: WorktreeSetupScriptConfig;
  cleanupConfig: WorktreeCleanupScriptConfig;
  isSetupLoading?: boolean;
  isSetupSaving?: boolean;
  setupError?: string | null;
  isCleanupLoading?: boolean;
  isCleanupSaving?: boolean;
  cleanupError?: string | null;
  onSetupSave: (config: WorktreeSetupScriptConfig) => Promise<void> | void;
  onCleanupSave: (config: WorktreeCleanupScriptConfig) => Promise<void> | void;
};

/**
 * Second-level bottom sheet that holds the worktree setup + cleanup editors.
 * The project Settings tab only shows a single "Worktree setup & cleanup" row;
 * tapping it opens this sheet. Stacking the editors as a sheet (rather than
 * drilling inside the Settings tab) keeps the project page's own back chip as
 * the sole dismiss affordance — the same reason `MobileAcpHistorySheet` exists.
 */
export function MobileWorktreeConfigSheet({
  open,
  onOpenChange,
  shell,
  setupConfig,
  cleanupConfig,
  isSetupLoading,
  isSetupSaving,
  setupError,
  isCleanupLoading,
  isCleanupSaving,
  cleanupError,
  onSetupSave,
  onCleanupSave,
}: MobileWorktreeConfigSheetProps) {
  const { t } = useTranslation();
  const title = t('workspace.projects.worktreeConfigTitle', 'Worktree setup & cleanup');

  /* Both editors are textareas, so this sheet is on screen with the soft
     keyboard up for most of its life. */
  const keyboard = useKeyboardAwareSheet();
  const maxHeight = useFoldAwareSheetHeight(88, true);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        style={{
          maxHeight: `min(${maxHeight}, calc(100dvh - var(--native-keyboard-height, 0px)))`,
        }}
        className={cn(
          'mobile-worktree-config-sheet',
          'h-auto! rounded-t-2xl border-border/60',
          keyboard.contentClassName
        )}
      >
        <div className="flex max-h-full min-h-0 flex-col">
          <header className="relative flex shrink-0 items-center px-4 pb-2 pt-2">
            <DrawerTitle className="mx-auto text-[0.95rem] font-semibold tracking-tight">
              {title}
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
          <DrawerDescription className="sr-only">{title}</DrawerDescription>

          <div
            ref={keyboard.scrollRef}
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-1"
            style={keyboard.scrollStyle}
          >
            <WorktreeSetupEditor
              phase="setup"
              shell={shell}
              config={setupConfig}
              isLoading={isSetupLoading}
              isSaving={isSetupSaving}
              errorMessage={setupError}
              onSave={onSetupSave}
            />
            <div className="border-t border-border/40" />
            <WorktreeSetupEditor
              phase="cleanup"
              shell={shell}
              config={cleanupConfig}
              isLoading={isCleanupLoading}
              isSaving={isCleanupSaving}
              errorMessage={cleanupError}
              onSave={onCleanupSave}
            />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
