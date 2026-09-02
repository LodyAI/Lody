import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, X } from 'lucide-react';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { cn } from '@/lib/utils';

export type MobileDeleteWorkspaceSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace name — used both for the "type to confirm" guard and
     for the destructive copy in the title / body. */
  workspaceName: string;
  /** Caller's destructive action. The sheet awaits this and shows
     a spinner on the delete button while it's in flight. */
  onConfirm: () => Promise<void>;
  /** Extra billing warning (e.g. deleting ends a cancel-scheduled
     subscription immediately). Rendered above the type-to-confirm card. */
  warningText?: string | null;
};

/**
 * Mobile-native bottom-sheet replacement for the centered `Dialog`
 * the desktop delete-workspace flow uses. Keeps the same
 * confirmation pattern (type the workspace name to enable the
 * destructive button) but presents it as a Drawer that matches the
 * rest of the mobile sheet family (new-chat, workspace-switcher,
 * create-workspace, filter-drawer).
 *
 * Destructive visual treatment:
 *  - Header has a destructive-tinted warning chip + icon so the
 *    destructive intent is unmissable before the user reads any
 *    body copy.
 *  - "Type to confirm" sub-card has a destructive top-border
 *    accent — a low-contrast danger marker that doesn't shout but
 *    keeps the visual hierarchy weighted toward caution.
 *  - The confirm button uses the `destructive` variant.
 */
export function MobileDeleteWorkspaceSheet({
  open,
  onOpenChange,
  workspaceName,
  onConfirm,
  warningText = null,
}: MobileDeleteWorkspaceSheetProps) {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  /* Reset typed confirmation whenever the sheet closes — opening
     again on a different workspace shouldn't carry the old typed
     name forward. */
  useEffect(() => {
    if (!open) {
      setConfirmText('');
      setIsDeleting(false);
    }
  }, [open]);

  const canDelete = confirmText === workspaceName && !isDeleting;

  const handleDelete = async () => {
    if (!canDelete) return;
    setIsDeleting(true);
    try {
      await onConfirm();
    } finally {
      setIsDeleting(false);
      onOpenChange(false);
      setConfirmText('');
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className={cn(
          'mobile-delete-workspace-sheet',
          'h-auto! max-h-[92dvh]! rounded-t-2xl border-border/60',
          'bottom-[var(--native-keyboard-height,0px)]!'
        )}
        style={{
          transition: 'bottom 320ms cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: 'bottom',
        }}
      >
        <div className="flex max-h-full min-h-0 flex-col">
          <header className="relative flex items-center px-4 pb-2 pt-2">
            <DrawerTitle className="mx-auto inline-flex items-center gap-1.5 text-[0.95rem] font-semibold tracking-tight text-destructive">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" strokeWidth={2} />
              {t('workspace.danger.deleteWorkspace.confirmTitle', 'Delete workspace?')}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                disabled={isDeleting}
                className={cn(
                  'absolute right-3 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full',
                  'text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                <X className="h-5 w-5" aria-hidden="true" strokeWidth={1.8} />
              </button>
            </DrawerClose>
          </header>
          <DrawerDescription className="px-4 pb-3 text-[0.78rem] leading-relaxed text-muted-foreground">
            {t('workspace.danger.deleteWorkspace.confirmDescription', {
              workspace: workspaceName,
              defaultValue: 'Permanently delete "{{workspace}}". This action cannot be undone.',
            })}
          </DrawerDescription>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
            {warningText ? (
              <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[0.72rem] font-medium leading-relaxed text-amber-950 dark:text-amber-100">
                {warningText}
              </p>
            ) : null}
            <div
              className={cn(
                'rounded-xl border border-destructive/30 bg-destructive/[0.04] p-3',
                'shadow-[0_0_0_3px_hsl(var(--destructive)/0.04)]'
              )}
            >
              <Label
                htmlFor="mobile-delete-workspace-confirm"
                className="text-[0.78rem] font-medium text-foreground"
              >
                {t('workspace.danger.deleteWorkspace.typeToConfirm', {
                  workspace: workspaceName,
                  defaultValue: 'Type "{{workspace}}" to confirm',
                })}
              </Label>
              <Input
                id="mobile-delete-workspace-confirm"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                placeholder={t(
                  'workspace.danger.deleteWorkspace.inputPlaceholder',
                  'Enter workspace name'
                )}
                disabled={isDeleting}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                className="mt-2"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canDelete) {
                    event.preventDefault();
                    void handleDelete();
                  }
                }}
              />
            </div>
          </div>

          <div
            className={cn(
              'flex shrink-0 items-center gap-2 border-t border-border/40 px-4 pt-3',
              /* Same keyboard-aware bottom padding trick as the rest
                 of the mobile sheet family — collapse the safe-area
                 inset when the keyboard is up (it would otherwise be
                 wasted space behind the keyboard). */
              'pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)-var(--native-keyboard-height,0px)))]'
            )}
          >
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={isDeleting}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="flex-1"
              onClick={() => void handleDelete()}
              disabled={!canDelete}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('common.processing', 'Processing...')}
                </>
              ) : (
                t('workspace.danger.deleteWorkspace.confirmButton', 'Delete')
              )}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
