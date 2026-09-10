import { useAtomValue } from 'jotai';
import { Info, ScanEye, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionId, SessionMeta } from '@lody/shared';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { Switch } from '@lody/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { reviewAgentFeatureEnabledAtom } from '@/atoms/settings';
import { useAutoReview } from '@/hooks/use-auto-review';
import { AutoReviewConfirmDialog, AutoReviewContract } from './auto-review-info';

export type AutoReviewMenuItemProps = {
  sessionId: SessionId | undefined;
  meta: SessionMeta | undefined;
  onConfigurationRequired?: () => void;
};

/**
 * "Auto review and merge" in the session menu.
 *
 * A checkbox rather than a button because this is a standing mode, not an
 * action: it survives restarts, and the user must be able to take it back at any
 * point. Turning it ON goes through a confirmation, turning it OFF does not —
 * stopping an automation should never be the harder direction.
 */
export function AutoReviewMenuItem({
  sessionId,
  meta,
  onConfigurationRequired,
}: AutoReviewMenuItemProps) {
  const { t } = useTranslation();
  const featureEnabled = useAtomValue(reviewAgentFeatureEnabledAtom);
  const {
    active,
    enabled,
    policy,
    reviewerConfigurationLoading,
    reviewerConfigurationReady,
    enable,
    reviewOnce,
    disable,
  } = useAutoReview(sessionId, meta);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!featureEnabled || !sessionId) {
    return null;
  }

  return (
    <>
      <DropdownMenuSeparator />

      {/* The low-stakes action comes first. Someone meeting the review agent for
          the first time should be able to see what it says before handing it a
          branch — the standing mode is then an informed upgrade rather than the
          only way in. */}
      <DropdownMenuItem
        className="gap-2"
        disabled={active || reviewerConfigurationLoading}
        onSelect={() => {
          if (!reviewerConfigurationReady) {
            onConfigurationRequired?.();
            return;
          }
          void reviewOnce().then((result) => {
            if (result === 'configuration_required') {
              onConfigurationRequired?.();
            }
          });
        }}
      >
        <ScanEye className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {t('sessions.autoReview.reviewOnce', 'Review this branch')}
        </span>
      </DropdownMenuItem>

      <DropdownMenuItem
        className="gap-2"
        disabled={!enabled && reviewerConfigurationLoading}
        onSelect={(event) => {
          if (!enabled && !reviewerConfigurationReady) {
            // This is navigation to a prerequisite, not a toggle. Let the
            // actions menu close before the setup dialog takes focus.
            onConfigurationRequired?.();
            return;
          }
          // The row is a toggle: closing the menu on every flip would make
          // turning it off feel like navigating away.
          event.preventDefault();
          if (enabled) {
            void disable();
          } else {
            setConfirmOpen(true);
          }
        }}
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {t('sessions.autoReview.menuLabel', 'Auto review and merge')}
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('sessions.autoReview.whatThisDoes', 'What this does')}
              onClick={(event) => {
                // Reading what it does must not toggle it.
                event.stopPropagation();
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="left"
            className="w-80"
            onClick={(event) => event.stopPropagation()}
          >
            <AutoReviewContract budget={policy.budget} />
          </PopoverContent>
        </Popover>
        <Switch
          checked={enabled}
          className="pointer-events-none"
          aria-label={t('sessions.autoReview.menuLabel', 'Auto review and merge')}
        />
      </DropdownMenuItem>

      <AutoReviewConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        budget={policy.budget}
        onConfirm={() => {
          void enable().then((result) => {
            if (result === 'configuration_required') {
              onConfigurationRequired?.();
            }
          });
        }}
      />
    </>
  );
}
