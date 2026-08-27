import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, X } from 'lucide-react';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

export type MobileRemoveLocalProjectSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project name, shown in the body. */
  projectName: string;
  /** Absolute path, shown under the description when available. */
  pathLabel?: string | null;
  /** Name of the device that owns the project. */
  deviceName?: string | null;
  /** Number of active conversations that will be stopped. */
  runningSessionCount: number;
  /** Caller's destructive action. The sheet awaits it and shows a spinner on
     the remove button while it's in flight; it closes the sheet on success. */
  onConfirm: () => Promise<boolean>;
};

/**
 * Mobile-native bottom-sheet confirm for removing a local project, mirroring
 * `MobileDeleteWorkspaceSheet` but without the type-to-confirm guard: removing a
 * project only takes it out of Lody (the folder's files are not deleted), so a
 * single destructive button is enough.
 *
 * On mobile the project always lives on another device, so the body names that
 * device and the removal command is queued for it.
 */
export function MobileRemoveLocalProjectSheet({
  open,
  onOpenChange,
  projectName,
  pathLabel,
  deviceName,
  runningSessionCount,
  onConfirm,
}: MobileRemoveLocalProjectSheetProps) {
  const { t } = useTranslation();
  const [isRemoving, setIsRemoving] = useState(false);

  const device =
    deviceName?.trim() ||
    t('sidebar.localProjects.remove.remoteFallbackDevice', 'the other device');

  // Render the device name in bold within the translated sentence. We
  // interpolate a sentinel for {{device}} and split on it so the bold span
  // lands in the right spot regardless of the language's word order.
  const sentinel = String.fromCharCode(0);
  const [descBefore, descAfter = ''] = t(
    'sidebar.localProjects.remove.remoteDescription',
    'This removes the project from Lody on {{device}} and archives its conversations. It does not delete the folder or files on disk.',
    { device: sentinel }
  ).split(sentinel);

  const handleRemove = async () => {
    if (isRemoving) return;
    setIsRemoving(true);
    try {
      const removed = await onConfirm();
      if (removed) onOpenChange(false);
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className={cn(
          'mobile-remove-local-project-sheet',
          'h-auto! max-h-[92dvh]! rounded-t-2xl border-border/60'
        )}
      >
        <div className="flex max-h-full min-h-0 flex-col">
          <header className="relative flex items-center px-4 pb-2 pt-2">
            <DrawerTitle className="mx-auto inline-flex items-center gap-1.5 text-[0.95rem] font-semibold tracking-tight text-destructive">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" strokeWidth={2} />
              {t('workspace.projects.deleteConfirmTitle', 'Remove project from Lody?')}
            </DrawerTitle>
            <DrawerClose asChild>
              <button
                type="button"
                aria-label={t('common.close', 'Close')}
                disabled={isRemoving}
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

          <DrawerDescription className="px-4 pb-2 text-[0.78rem] leading-relaxed text-muted-foreground">
            {descBefore}
            <span className="font-semibold text-foreground">{device}</span>
            {descAfter}
          </DrawerDescription>

          <div className="px-4 pb-3">
            <p className="truncate text-[0.85rem] font-medium text-foreground">{projectName}</p>
            {pathLabel ? (
              <p className="mt-0.5 break-all font-mono text-[0.72rem] leading-snug text-muted-foreground">
                {pathLabel}
              </p>
            ) : null}
            {runningSessionCount > 0 ? (
              <p className="mt-2 text-[0.78rem] font-medium leading-relaxed text-destructive">
                {t('sidebar.localProjects.remove.runningSessionsWarning', {
                  count: runningSessionCount,
                })}
              </p>
            ) : null}
          </div>

          <div
            className={cn(
              'flex shrink-0 items-center gap-2 border-t border-border/40 px-4 pt-3',
              'pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)))]'
            )}
          >
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={isRemoving}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="flex-1"
              onClick={() => void handleRemove()}
              disabled={isRemoving}
            >
              {isRemoving ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('common.processing', 'Processing...')}
                </>
              ) : (
                t('common.remove', 'Remove')
              )}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
