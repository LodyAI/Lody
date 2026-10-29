import { useEffect, useRef, useState } from 'react';
import { atom, useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { usePlatform } from '@lody/platform/react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { useStuckConnectionHint } from '@/hooks/use-stuck-connection';
import { useWorkspaceDataScopeState } from '@/hooks/use-workspace-data-scope-state';
import { RecoveryPage, reportRecoveryShown } from './blocking-wait-placeholder';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  connectionSpinner: { color: 'hsl(var(--muted-foreground) / 1)' },
  /** The sheet's place: pinned above the mobile dock, letting the pointer through. */
  sheet: {
    pointerEvents: 'none',
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 'calc(var(--k-safe-area-bottom,0px) + 5.25rem)',
    zIndex: 40,
    display: 'flex',
    justifyContent: 'center',
    paddingInline: themeSpace[4],
  },
  card: {
    pointerEvents: 'auto',
    width: '100%',
    maxWidth: '28rem',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.7)',
    backgroundColor: 'hsl(var(--card) / 0.95)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2.5],
    boxShadow: themeShadow.lg,
    backdropFilter: 'blur(8px)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  title: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
  },
  dismissIcon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  /** Reason and action share one row: the action alone on its own row
      left a wide empty gutter. */
  reasonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    marginTop: themeSpace[1],
    paddingInlineStart: themeSpace[6],
  },
  reason: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: themeFontSize.xs,
    lineHeight: 1.375,
    color: themeColors.mutedForeground,
  },
  /** The recovery page takes the whole window, over the sheet. */
  recovery: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 50,
    overflowY: 'auto',
    backgroundColor: themeColors.background,
  },
});

/** Names this wait in recovery reports and diagnostics. */
export const STUCK_CONNECTION_RECOVERY_GATE = 'control_connection_loading';

/**
 * Dismissal intentionally lives in a page-load-scoped atom, not storage: the
 * recovery action IS a reload, so a fresh page load should get a fresh verdict.
 */
const stuckConnectionBannerDismissedAtom = atom(false);

export type StuckConnectionBannerLabels = {
  title: string;
  description: string;
  recover: string;
  dismissAriaLabel: string;
};

/**
 * Floating hint shown when the workspace connection has been stuck in
 * `loading` for an extended time (see `useStuckConnectionHint`).
 *
 * Sits at the BOTTOM, above the mobile dock (`bottom-0 z-30`, ~72px tall plus
 * safe area) rather than under the header: the bottom of a list is usually
 * empty space, while the top covers the rows the user came to read, and a
 * bottom sheet is both the platform-conventional place for a recoverable
 * status and within thumb reach. The action opens the same recovery page a
 * long route wait shows (reload, clear cache, diagnostics, full reset): a
 * connection stuck here is as often a sign-in or storage problem as a cache one,
 * and a cache clear alone keeps the credential that may be the cause.
 */
export function StuckConnectionBanner({
  labels,
  onRecover,
  onDismiss,
}: {
  labels: StuckConnectionBannerLabels;
  onRecover: () => void;
  onDismiss: () => void;
}) {
  return (
    <div {...stylex.props(styles.sheet)} role="status">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
        {...stylex.props(styles.card)}
      >
        <div {...stylex.props(styles.row)}>
          <Spinner
            {...stylex.props(styles.connectionSpinner)}
            diameter="calc(var(--spacing) * 4)"
            aria-hidden="true"
          />
          <p {...stylex.props(styles.title)}>{labels.title}</p>
          <Button
            variant="ghost"
            icon
            height="calc(var(--spacing) * 6)"
            width="calc(var(--spacing) * 6)"
            className="-mr-1 text-muted-foreground"
            onClick={onDismiss}
            aria-label={labels.dismissAriaLabel}
          >
            <X {...stylex.props(styles.dismissIcon)} />
          </Button>
        </div>
        {/* Reason and action share one row: the action alone on its own row
            left a wide empty gutter. */}
        <div {...stylex.props(styles.reasonRow)}>
          <p {...stylex.props(styles.reason)}>{labels.description}</p>
          <Button
            size="small"
            height="calc(var(--spacing) * 7)"
            className="rounded-full px-3 text-xs"
            onClick={onRecover}
          >
            {labels.recover}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * Mounted once in `MainLayout`. Renders nothing on the local-only platform
 * (no cloud connection to get stuck), before the hint threshold, or after the
 * user dismissed it for this page load. Reaching the threshold reports once per
 * page load like any other recovery offer, so a stuck connection names its
 * scope blocker and failing request in `workspace/boot_wait_stuck`. The page
 * closes on its own if the connection leaves `loading`.
 */
export function StuckConnectionBannerContainer() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const stuck = useStuckConnectionHint();
  const observation = useWorkspaceDataScopeState();
  const [dismissed, setDismissed] = useAtom(stuckConnectionBannerDismissedAtom);
  const [recoveryOpenedAt, setRecoveryOpenedAt] = useState<number | null>(null);
  const eligible = platform.sync.mode !== 'local' && stuck;
  const observationRef = useRef(observation);
  observationRef.current = observation;
  const reportedRef = useRef(false);

  useEffect(() => {
    if (!eligible || reportedRef.current) return;
    reportedRef.current = true;
    reportRecoveryShown(STUCK_CONNECTION_RECOVERY_GATE, observationRef.current, false);
  }, [eligible]);

  useEffect(() => {
    if (!eligible) setRecoveryOpenedAt(null);
  }, [eligible]);

  if (!eligible) {
    return null;
  }

  if (recoveryOpenedAt !== null) {
    return (
      <div {...stylex.props(styles.recovery)}>
        <RecoveryPage
          layout="window"
          gate={STUCK_CONNECTION_RECOVERY_GATE}
          failed={false}
          observation={observation}
          waitStartedAt={recoveryOpenedAt}
        />
      </div>
    );
  }

  if (dismissed) {
    return null;
  }

  return (
    <StuckConnectionBanner
      labels={{
        title: t('connectionRecovery.title'),
        description: t('connectionRecovery.description'),
        recover: t('connectionRecovery.recover'),
        dismissAriaLabel: t('connectionRecovery.dismiss'),
      }}
      onRecover={() => setRecoveryOpenedAt(Date.now())}
      onDismiss={() => setDismissed(true)}
    />
  );
}
