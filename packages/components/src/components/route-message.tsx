import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { FailedScreenRecovery, reportRecoveryShown } from '@/components/blocking-wait-placeholder';
import { useWorkspaceDataScopeState } from '@/hooks/use-workspace-data-scope-state';
import { reloadApp } from '@/lib/clear-local-cache';

/**
 * A route that could not continue. A failure (`gate` names it in reports)
 * always has a way forward: the caller's retry, or a reload — "refresh the
 * page" means nothing in the mobile app — and a link to the full recovery
 * screen. `gate: null` marks a message that is not a failure, such as a plan
 * limit, which keeps only the caller's retry.
 */
export function RouteMessage({
  gate,
  title,
  description = '',
  onRetry,
  actionLabel,
}: {
  gate: string | null;
  title: string;
  description?: string;
  onRetry?: () => void;
  /** Replaces the Retry label for a terminal message's single explicit action. */
  actionLabel?: string;
}) {
  const { t } = useTranslation();
  const observationRef = useRef(useWorkspaceDataScopeState());
  const [showRecovery, setShowRecovery] = useState(false);

  // One report per screen; the observation at mount is the one that failed.
  useEffect(() => {
    if (gate !== null) reportRecoveryShown(gate, observationRef.current, true);
  }, [gate]);

  if (showRecovery && gate !== null) return <FailedScreenRecovery gate={gate} />;
  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background p-6 text-center">
      <div className="max-w-sm space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        ) : null}
        {gate === null ? (
          onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              {actionLabel ?? t('common.retry')}
            </Button>
          ) : null
        ) : (
          <div className="flex flex-col items-center gap-2 pt-2">
            <Button variant="secondary" onClick={onRetry ?? (() => reloadApp())}>
              {onRetry ? t('common.retry') : t('errorBoundary.reload')}
            </Button>
            <Button variant="ghost" size="small" onClick={() => setShowRecovery(true)}>
              {t('workspace.route.recovery.moreOptions')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
