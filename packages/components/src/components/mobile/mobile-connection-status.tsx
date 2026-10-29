import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, Check } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontWeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import type { LodyConnectionUiState } from '@/atoms/control-connection';

const styles = stylex.create({
  root: { display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'center' },
  pill: {
    pointerEvents: 'none',
    display: 'flex',
    maxWidth: '100%',
    alignItems: 'center',
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: 'hsl(var(--card) / 0.9)',
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[1],
    backdropFilter: 'blur(8px)',
    boxShadow: '0 1px 2px rgba(0,0,0,0.05), 0 10px 28px -14px rgba(0,0,0,0.28)',
  },
  content: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: '0.8rem',
    fontWeight: themeFontWeight.medium,
  },
  muted: { color: themeColors.mutedForeground },
  success: { color: themeColors.statusSuccess },
  danger: { color: themeColors.statusDanger },
  glyph: { width: themeSpace[3.5], height: themeSpace[3.5] },
  pullGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  offlineDot: {
    display: 'inline-block',
    width: themeSpace[1.5],
    height: themeSpace[1.5],
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.statusDanger,
  },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/**
 * Mobile-only home-header status indicator, rendered as a PILL.
 *
 * The home header places this in an absolutely-centered overlay so the
 * pull-to-refresh / connection hint sits at true horizontal center of
 * the screen (see `mobile-home-screen.tsx`). The pill is
 * `pointer-events-none` so it never steals taps from the workspace
 * avatar or trailing glass discs; the caller also caps max-width so a
 * long label truncates instead of covering those controls.
 *
 * The pill keeps its own surface (card background + border + shadow +
 * blur) so it still reads as a distinct floating status rather than bare
 * glyphs loose in the chrome.
 *
 * One pill, every transient home-header status:
 * - connection: loading / reconnecting / offline, plus a green ✓ flash
 *   on a non-online → online recovery.
 * - refresh: a "刷新中…" spinner while a pull-to-refresh sync is in flight.
 * - pull hint: the 下拉刷新 / 释放刷新 arrow during an active pull drag —
 *   reusing the same pill so the user only ever sees one floating surface
 *   handing off between states (the pull hint and connection status can
 *   never double-stack).
 *
 * Behavior:
 * - Renders nothing (the pill animates out) when there is no transient
 *   status to show — i.e. `state === 'online'`, not refreshing, no active
 *   pull, and no recent recovery flash.
 * - The whole pill springs in / out on appear / disappear; while it stays
 *   mounted, its inner content cross-fades between states so e.g. the
 *   loader → ✓ swap reads as a smooth transition rather than a jump.
 *
 * Every leading glyph carries `shrink-0` (the shared `Spinner` wrapper
 * does so itself). The pill is a capped-width flex row whose label
 * truncates, so without it a long label compresses the spinner to a
 * non-square box (measured 14×14 → 13.55×15.43 on the reconnecting label)
 * and the rotation then sweeps an ellipse — the glyph visibly wobbles
 * instead of turning in place. `index.css` also pins
 * `transform-box`/`transform-origin` globally for spinners; both are
 * needed, since that rule fixes the pivot but cannot restore a squished
 * box.
 */

export type MobileConnectionStatusLabels = {
  loading?: string;
  reconnecting?: string;
  offline?: string;
  recovered?: string;
  refreshing?: string;
};

/**
 * Active pull-to-refresh gesture, surfaced through the same floating pill
 * so the pull hint and the connection status share one surface and one
 * enter/exit animation instead of two stacked overlays.
 */
export type MobileConnectionStatusPull = {
  /** A pull gesture is in progress (pullDistance > 0). */
  active: boolean;
  /** Pulled far enough that releasing triggers a refresh (flips the arrow). */
  pastThreshold: boolean;
  /** Resolved hint label ("下拉刷新" / "释放刷新"), chosen by the caller. */
  label: string;
};

const RECOVERY_FLASH_MS = 1200;
/* Cross-fade for the pill's inner content while the pill stays mounted. */
const CONTENT_TRANSITION = { duration: 0.18 };
/* Pill appear/disappear. A snappy spring so the status pops in promptly
   (a flaky link should be noticed) but settles without a bouncy overshoot
   that would read as decorative on chrome. */
const PILL_TRANSITION = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 } as const;

type StatusContent = {
  key: string;
  icon: ReactNode;
  label: string;
  textStyle: stylex.StyleXStyles;
  /** Pull-hint content — not announced to assistive tech (it mirrors the
      visible drag gesture, which a screen-reader user isn't performing). */
  pull?: boolean;
};

/* Background tint is intentionally NOT per-state. Per-state red / green
   pill fills read as alert-level chrome on a screen where users spend most
   of their time. The leading `Loader2` / dot / `Check` glyph plus a
   muted/colored label conveys state without turning the whole pill into a
   banner. */
function contentFor(
  state: LodyConnectionUiState,
  showRecovery: boolean,
  refreshing: boolean,
  pull: MobileConnectionStatusPull | undefined,
  labels: MobileConnectionStatusLabels
): StatusContent | null {
  if (pull?.active) {
    /* An active pull is a physical, right-now gesture, so it takes the
       surface even over an ambient connection status — the user is asking
       for the refresh affordance and expects to see it track their drag. */
    return {
      key: 'pull',
      icon: (
        <ArrowDown
          {...stylex.props(styles.pullGlyph)}
          strokeWidth={2}
          style={{ transform: pull.pastThreshold ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        />
      ),
      label: pull.label,
      textStyle: styles.muted,
      pull: true,
    };
  }
  if (refreshing) {
    /* User-initiated pull-to-refresh sync takes precedence over the ambient
       connection state — the refresh status is "you asked for this",
       whereas the connection status is "fyi the link is flaky". Showing
       both at once would be visual noise. */
    return {
      key: 'refreshing',
      icon: <Spinner diameter="calc(var(--spacing) * 3.5)" aria-hidden="true" />,
      label: labels.refreshing ?? '刷新中…',
      textStyle: styles.muted,
    };
  }
  if (showRecovery) {
    return {
      key: 'recovered',
      icon: <Check {...stylex.props(styles.glyph)} strokeWidth={2.4} aria-hidden="true" />,
      label: labels.recovered ?? '已连接',
      textStyle: styles.success,
    };
  }
  if (state === 'reconnecting') {
    return {
      key: 'reconnecting',
      icon: <Spinner diameter="calc(var(--spacing) * 3.5)" aria-hidden="true" />,
      label: labels.reconnecting ?? '正在重连…',
      textStyle: styles.muted,
    };
  }
  if (state === 'loading') {
    return {
      key: 'loading',
      icon: <Spinner diameter="calc(var(--spacing) * 3.5)" aria-hidden="true" />,
      label: labels.loading ?? '连接中…',
      textStyle: styles.muted,
    };
  }
  if (state === 'offline') {
    return {
      key: 'offline',
      icon: <span {...stylex.props(styles.offlineDot)} aria-hidden="true" />,
      label: labels.offline ?? '离线',
      textStyle: styles.danger,
    };
  }
  return null;
}

export function MobileConnectionStatus({
  state,
  refreshing = false,
  pull,
  labels = {},
  className,
}: {
  state: LodyConnectionUiState;
  /** When true, shows a "刷新中…" spinner, overriding the ambient
     connection state. Hides as soon as the caller flips this back to
     false. */
  refreshing?: boolean;
  /** Active pull-to-refresh gesture; when present it owns the pill. */
  pull?: MobileConnectionStatusPull;
  labels?: MobileConnectionStatusLabels;
  className?: string;
}) {
  /* Track whether we should display the "just-recovered" success flash.
     We compare the latest `state` to the previously-seen value: only
     fire the flash on a non-online → online transition (not on initial
     mount when state already starts as 'online'). */
  const [showRecovery, setShowRecovery] = useState(false);
  const prevStateRef = useRef<LodyConnectionUiState>(state);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (state === 'online' && prev !== 'online') {
      setShowRecovery(true);
      const timer = window.setTimeout(() => setShowRecovery(false), RECOVERY_FLASH_MS);
      return () => window.clearTimeout(timer);
    }
    /* Any non-online state cancels a stale flash (e.g. online → offline
       while a previous recovery flash was still on screen).

       Critically: `showRecovery` is intentionally NOT in the dep array
       below. If it were, React would run THIS effect's cleanup as soon
       as `setShowRecovery(true)` above triggered a re-render — and the
       cleanup is `clearTimeout(timer)`. The flash would be cancelled
       immediately and never show. Letting the effect re-fire only on
       `state` changes keeps the timer alive until either (a) the
       timeout fires naturally, or (b) `state` itself changes (which IS
       the right time to cancel). */
    if (state !== 'online') {
      setShowRecovery(false);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const content = contentFor(state, showRecovery, refreshing, pull, labels);

  return (
    <div {...withClassName(stylex.props(styles.root), className)} role="status" aria-live="polite">
      {/* Outer AnimatePresence mounts/unmounts the pill itself so it
          springs in on appear and out on disappear. */}
      <AnimatePresence initial={false}>
        {content ? (
          <motion.div
            key="pill"
            initial={{ opacity: 0, y: -6, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.9 }}
            transition={PILL_TRANSITION}
            {...stylex.props(styles.pill)}
          >
            {/* Inner cross-fade (`mode="wait"`) so content swaps — loader →
                ✓, or status ⇄ pull hint — read as a smooth transition
                while the pill surface stays put. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={content.key}
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 2 }}
                transition={CONTENT_TRANSITION}
                {...stylex.props(styles.content, content.textStyle)}
                aria-hidden={content.pull ? 'true' : undefined}
              >
                {content.icon}
                <span {...stylex.props(styles.label)}>{content.label}</span>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
