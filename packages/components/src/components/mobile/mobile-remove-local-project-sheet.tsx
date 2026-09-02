import { useEffect, useRef, useState } from 'react';
import type { LocalProjectWorktreeCleanupPreflightResult } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';

import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@/ui/checkbox';
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
  /** Whether the owning device can begin processing the durable command now. */
  deviceOnline: boolean;
  /** Number of conversations that will move to Archive. */
  conversationCount: number;
  /** Number of active conversations that will be stopped. */
  runningSessionCount: number;
  canCleanupWorktrees: boolean;
  onPreflightCleanup: () => Promise<LocalProjectWorktreeCleanupPreflightResult>;
  /** Caller's destructive action. The sheet awaits it and shows a spinner on
     the remove button while it's in flight; it closes the sheet on success. */
  onConfirm: (options: { cleanupWorktrees: boolean }) => Promise<boolean>;
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
  deviceOnline,
  conversationCount,
  runningSessionCount,
  canCleanupWorktrees,
  onPreflightCleanup,
  onConfirm,
}: MobileRemoveLocalProjectSheetProps) {
  const { t } = useTranslation();
  const [isRemoving, setIsRemoving] = useState(false);
  const [cleanupWorktrees, setCleanupWorktrees] = useState(false);
  const [preflight, setPreflight] = useState(
    null as LocalProjectWorktreeCleanupPreflightResult | null
  );
  const [preflightError, setPreflightError] = useState(null as string | null);
  const [isPreflighting, setIsPreflighting] = useState(false);
  const preflightGeneration = useRef(0);

  useEffect(() => {
    preflightGeneration.current += 1;
    setCleanupWorktrees(false);
    setPreflight(null);
    setPreflightError(null);
    setIsPreflighting(false);
  }, [open, projectName]);

  const device =
    deviceName?.trim() ||
    t('sidebar.localProjects.remove.remoteFallbackDevice', 'the other device');

  // Render the device name in bold within the translated sentence. We
  // interpolate a sentinel for {{device}} and split on it so the bold span
  // lands in the right spot regardless of the language's word order.
  const sentinel = String.fromCharCode(0);
  const [descBefore, descAfter = ''] = t(
    'sidebar.localProjects.remove.remoteDescription',
    'This removes the project from Lody on {{device}}.',
    { device: sentinel }
  ).split(sentinel);

  const handleRemove = async () => {
    if (isRemoving) return;
    setIsRemoving(true);
    try {
      const removed = await onConfirm({ cleanupWorktrees });
      if (removed) onOpenChange(false);
    } finally {
      setIsRemoving(false);
    }
  };

  const handleCleanupChange = async (checked: boolean) => {
    const generation = ++preflightGeneration.current;
    setCleanupWorktrees(checked);
    setPreflight(null);
    setPreflightError(null);
    if (!checked) return;
    setIsPreflighting(true);
    try {
      const result = await onPreflightCleanup();
      if (preflightGeneration.current === generation) setPreflight(result);
    } catch (error) {
      if (preflightGeneration.current === generation) {
        setPreflightError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (preflightGeneration.current === generation) setIsPreflighting(false);
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
          <header className="relative flex items-center px-12 pb-2 pt-2">
            <DrawerTitle className="w-full text-center text-[0.95rem] font-semibold tracking-tight text-foreground">
              {t('sidebar.localProjects.remove.title', 'Remove “{{name}}” from Lody?', {
                name: projectName,
              })}
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
            {!deviceOnline ? (
              <>
                {' '}
                {t(
                  'sidebar.localProjects.remove.offline',
                  'The device is offline; removal starts when it reconnects.'
                )}
              </>
            ) : null}
          </DrawerDescription>

          <div className="space-y-3 px-4 pb-3 text-[0.78rem] leading-relaxed text-muted-foreground">
            <div className="space-y-1">
              <p className="text-foreground/85">
                {conversationCount > 0
                  ? t('sidebar.localProjects.remove.archiveDescription', {
                      count: conversationCount,
                    })
                  : t(
                      'sidebar.localProjects.remove.archiveDescriptionEmpty',
                      'Any conversations in this project will move to Archive.'
                    )}
              </p>
              {runningSessionCount > 0 ? (
                <p>
                  {t('sidebar.localProjects.remove.runningSessionsSummary', {
                    count: runningSessionCount,
                  })}
                </p>
              ) : null}
            </div>
            <div className="rounded-lg bg-muted/60 px-3 py-2.5">
              <p className="font-medium text-foreground/90">
                {t(
                  'sidebar.localProjects.remove.originalDirectorySafe',
                  'Lody never deletes the original project folder or its files.'
                )}
              </p>
              {pathLabel ? (
                <p className="mt-1 break-all font-mono text-[0.7rem]">{pathLabel}</p>
              ) : null}
            </div>
            <div className="rounded-lg border border-border/70 px-3 py-2.5">
              <label className="flex items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  checked={cleanupWorktrees}
                  disabled={!canCleanupWorktrees || isRemoving}
                  onCheckedChange={(checked) => void handleCleanupChange(checked === true)}
                />
                <span>
                  <span className="block font-medium text-foreground">
                    {t(
                      'sidebar.localProjects.remove.cleanupWorktrees',
                      'Also delete session worktrees created by Lody'
                    )}
                  </span>
                  <span className="mt-1 block">
                    {canCleanupWorktrees
                      ? t(
                          'sidebar.localProjects.remove.cleanupWorktreesHelper',
                          'Only clean worktrees are deleted. Worktrees with changes stay on disk.'
                        )
                      : t(
                          'sidebar.localProjects.remove.cleanupUnavailable',
                          'Connect the device to inspect worktrees. You can still remove the project.'
                        )}
                  </span>
                </span>
              </label>
              {cleanupWorktrees ? (
                <div className="mt-2 border-t pt-2">
                  {isPreflighting
                    ? t(
                        'sidebar.localProjects.remove.checkingWorktrees',
                        'Checking each worktree for changes…'
                      )
                    : null}
                  {preflightError ? <p className="text-destructive">{preflightError}</p> : null}
                  {preflight ? (
                    <div className="space-y-1">
                      <p>
                        {t('sidebar.localProjects.remove.cleanWorktreesSummary', {
                          count: preflight.clean.length,
                        })}
                      </p>
                      {preflight.dirty.length > 0 ? (
                        <p className="text-amber-700 dark:text-amber-300">
                          {t('sidebar.localProjects.remove.dirtyWorktreesSummary', {
                            count: preflight.dirty.length,
                          })}
                          : {preflight.dirty.map((item) => item.title).join(', ')}
                        </p>
                      ) : null}
                      {preflight.failed.length > 0 ? (
                        <p className="text-muted-foreground">
                          {t('sidebar.localProjects.remove.inspectFailedSummary', {
                            count: preflight.failed.length,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div
            className={cn(
              'flex shrink-0 items-center gap-2 border-t border-border/40 px-4 pt-3',
              'pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)))]'
            )}
          >
            <Button
              type="button"
              variant="secondary"
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
              disabled={isRemoving || (cleanupWorktrees && (isPreflighting || !preflight))}
            >
              {isRemoving ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('common.processing', 'Processing...')}
                </>
              ) : (
                t('sidebar.localProjects.remove.confirm', 'Remove project')
              )}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
