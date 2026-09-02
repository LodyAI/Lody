import { useCallback, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2 } from 'lucide-react';
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
import { markCacheClearPending, reloadApp } from '@/lib/clear-local-cache';

/**
 * Shared logic for the "Clear cache" settings action. The actual delete runs at
 * the next boot (see `maybeClearLodyCacheOnBoot`); here we navigate to the
 * conversation page, set the boot flag, and reload — so the user lands back on
 * chat with a freshly rebuilt local cache.
 */
export function useClearCache() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { workspaceName?: string };
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const confirmClear = useCallback(async () => {
    setIsClearing(true);
    try {
      if (params.workspaceName) {
        // Land on the conversation page after the reload — the URL is preserved
        // across reload on every surface, so navigate first.
        await navigate({
          to: '/$workspaceName/chat',
          params: { workspaceName: params.workspaceName },
        });
      }
    } catch {
      // Navigation is best-effort; we reload regardless.
    }
    markCacheClearPending();
    reloadApp();
  }, [navigate, params.workspaceName]);

  return { dialogOpen, setDialogOpen, isClearing, confirmClear };
}

export function ClearCacheConfirmDialog({
  open,
  onOpenChange,
  isClearing,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isClearing: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('settings.cache.clearCache.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.cache.clearCache.confirmDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isClearing}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog open while we navigate + reload so the button can
              // show its in-progress state instead of flashing closed.
              event.preventDefault();
              onConfirm();
            }}
            disabled={isClearing}
            variant="destructive"
          >
            {isClearing ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('settings.cache.clearCache.confirmButton')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
