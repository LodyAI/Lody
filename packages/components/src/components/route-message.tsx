import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { FailedScreenRecovery, reportRecoveryShown } from '@/components/blocking-wait-placeholder';
import { useWorkspaceDataScopeState } from '@/hooks/use-workspace-data-scope-state';
import { reloadApp } from '@/lib/clear-local-cache';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  page: {
    display: 'flex',
    minHeight: '100dvh',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: themeColors.background,
    padding: themeSpace[6],
    textAlign: 'center',
  },
  column: {
    maxWidth: '24rem',
  },
  /**
   * `space-y-1` on the column: every statement is a step above the one before
   * it, and the last one sits flush with the block's edge. StyleX has no
   * descendant selector, so the step is a margin each statement owns, and the
   * last statement gives it back.
   */
  statement: {
    marginBottom: { default: themeSpace[1], ':last-child': 0 },
  },
  title: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  description: {
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[5],
    color: themeColors.mutedForeground,
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingTop: themeSpace[2],
  },
});

/**
 * A route that could not continue. A failure (`gate` names it in reports)
 * always has a way forward: the caller's retry, or a reload — "refresh the
 * page" means nothing in the mobile app — and a link to the full recovery
 * screen. `gate: null` marks a message that is not a failure, such as a plan
 * limit, which keeps only the caller's actions: a primary one (`onRetry`) and
 * an optional quiet way out (`secondaryAction`) for a route that can leave it.
 */
export function RouteMessage({
  gate,
  title,
  description = '',
  onRetry,
  actionLabel,
  secondaryAction,
  testId,
}: {
  testId?: string;
  gate: string | null;
  title: string;
  description?: string;
  onRetry?: () => void;
  /** Replaces the Retry label for a terminal message's single explicit action. */
  actionLabel?: string;
  /** A terminal message's second exit, e.g. signing out of an account at its limit. */
  secondaryAction?: { label: string; onClick: () => void };
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
    <div data-testid={testId} {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.statement, styles.title)}>{title}</div>
        {description ? (
          <div {...stylex.props(styles.statement, styles.description)}>{description}</div>
        ) : null}
        {gate === null ? (
          onRetry || secondaryAction ? (
            <div {...stylex.props(styles.actions)}>
              {onRetry ? (
                <Button variant="secondary" onClick={onRetry}>
                  {actionLabel ?? t('common.retry')}
                </Button>
              ) : null}
              {secondaryAction ? (
                <Button variant="ghost" size="small" onClick={secondaryAction.onClick}>
                  {secondaryAction.label}
                </Button>
              ) : null}
            </div>
          ) : null
        ) : (
          <div {...stylex.props(styles.actions)}>
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
