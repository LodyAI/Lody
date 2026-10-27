import { useRef, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { ArrowUpRight } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { Popover } from '@lody/ui/popover';
import { INFO_BAR_TEXT_CLASS } from './info-bar-type';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

export type InfoChipIcon = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

/**
 * Primitives for the session info bar's "canonical cluster + fixed stage"
 * model (see SessionInfoBar):
 *
 *   [cluster: collapsed items, fixed order] │ [stage: THE active item]
 *
 * Click semantics:
 *   - cluster chip click      → promote the item onto the stage
 *   - stage ICON              → inert marker (NOT a button). The rightmost
 *                               item is always the expanded one and clicking
 *                               it must never relayout or collapse anything.
 *                               The cluster│stage divider conveys which item
 *                               is active — no persistent highlight bg.
 *   - stage SUMMARY/↗ click   → the item's detail surface (popover or
 *                               navigation); the ↗ affordance is visible at
 *                               rest, never hover-only
 *
 * Uniform chrome: every chip button shares height, padding, radius, and
 * hover treatment; width varies only by the glanceable short `value`
 * ("12m", "#2857", "2/5") that some items keep while collapsed.
 */
const styles = stylex.create({
  /** The chrome every chip button shares. */
  chipButton: {
    display: 'flex',
    height: themeSpace[6],
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1],
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  anchoredPopover: {
    width: 'var(--anchor-width)',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
  },
  stagePopover: {
    width: 'calc(var(--spacing) * 96)',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
  },
  chipTextMuted: { color: themeColors.mutedForeground },
  chipTextForeground: { color: themeColors.foreground },
  /** An open popover chip keeps its well filled and says so in brighter ink. */
  chipButtonOpen: {
    backgroundColor: 'hsl(var(--muted-foreground) / 0.1)',
    color: themeColors.foreground,
  },
  chipIcon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  chipValue: {
    display: { default: 'none', '@container (min-width: 420px)': 'inline' },
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  iconBadge: {
    display: 'flex',
    height: themeSpace[6],
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
    paddingInline: themeSpace[1],
  },
  summary: {
    display: 'flex',
    height: themeSpace[6],
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1],
  },
  /** A summary that opens something answers the pointer like a control. */
  summaryInteractive: {
    userSelect: 'none',
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  summaryOpen: { backgroundColor: 'hsl(var(--muted-foreground) / 0.1)' },
  summaryText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  summaryGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.7)',
  },
  root: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[1],
  },
});

function ChipFace({ icon: Icon, value }: { icon: InfoChipIcon; value?: string }) {
  return (
    <>
      <Icon {...stylex.props(styles.chipIcon)} aria-hidden="true" />
      {value ? <span {...stylex.props(styles.chipValue)}>{value}</span> : null}
    </>
  );
}

/**
 * Plain action chip (e.g. Preview). Shares the cluster chrome but opts out
 * of the promote/stage cycle entirely: one click fires the action.
 */
export function ActionChip({
  icon,
  label,
  textClassName,
  onAction,
}: {
  icon: InfoChipIcon;
  label: string;
  textClassName?: string;
  onAction: () => void;
}) {
  const chipProps = stylex.props(styles.chipButton);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onAction}
      {...chipProps}
      className={clsx(
        chipProps.className,
        INFO_BAR_TEXT_CLASS,
        textClassName ?? stylex.props(styles.chipTextMuted).className
      )}
    >
      <ChipFace icon={icon} />
    </button>
  );
}

/**
 * Action chip whose one click toggles a popover above the bar (e.g. related
 * Sessions). Like {@link ActionChip} it never takes the stage.
 */
export function PopoverActionChip({
  icon,
  label,
  value,
  content,
  defaultOpen = false,
}: {
  icon: InfoChipIcon;
  label: string;
  value?: string;
  /** A render prop receives `close`, so a selection inside the panel can
   *  dismiss it and reveal the surface it just changed. */
  content: ReactNode | ((close: () => void) => ReactNode);
  /** Storybook/testing aid. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const chipProps = stylex.props(styles.chipButton, open && styles.chipButtonOpen);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            ref={buttonRef}
            type="button"
            aria-label={label}
            title={label}
            {...chipProps}
            className={clsx(
              chipProps.className,
              INFO_BAR_TEXT_CLASS,
              stylex.props(open ? styles.chipTextForeground : styles.chipTextMuted).className
            )}
          >
            <ChipFace icon={icon} value={value} />
          </button>
        }
      />
      <Popover.Content
        side="top"
        align="start"
        // Anchor to the enclosing info-bar pill so the panel shares its edges.
        anchor={() => {
          const button = buttonRef.current;
          return button?.closest('[data-info-bar-surface]') ?? button;
        }}
        aria-label={label}
        className={clsx(stylex.props(styles.anchoredPopover).className, 'p-0 shadow-xl')}
      >
        {typeof content === 'function' ? content(() => setOpen(false)) : content}
      </Popover.Content>
    </Popover.Root>
  );
}

/** Collapsed item in the cluster. Click promotes it onto the stage. */
export function ClusterChip({
  icon,
  label,
  value,
  textClassName,
  onPromote,
}: {
  icon: InfoChipIcon;
  label: string;
  value?: string;
  textClassName?: string;
  onPromote: () => void;
}) {
  const chipProps = stylex.props(styles.chipButton);
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={false}
      title={label}
      onClick={onPromote}
      {...chipProps}
      className={clsx(
        chipProps.className,
        INFO_BAR_TEXT_CLASS,
        textClassName ?? stylex.props(styles.chipTextMuted).className
      )}
    >
      <ChipFace icon={icon} value={value} />
    </button>
  );
}

export type StageDetail =
  | { kind: 'popover'; content: ReactNode; ariaLabel: string }
  | { kind: 'action'; onAction: () => void; ariaLabel: string };

/**
 * The active item on the stage: [icon = inert marker] [summary = detail].
 * The icon is deliberately NOT a button — the rightmost item is always the
 * expanded one, and clicking it must never collapse or relayout the bar.
 * The summary region (with its resting ↗) is one large click target; items
 * without a detail surface render the summary as plain text.
 */
export function StageChip({
  icon,
  iconOverride,
  label,
  value,
  textClassName,
  summary,
  detail,
  leading,
  trailing,
}: {
  icon: InfoChipIcon;
  /** Replaces the inert icon badge with a self-contained node (e.g. an
   *  interactive worktree copy button). When set, `icon`/`value` are ignored. */
  iconOverride?: ReactNode;
  label: string;
  value?: string;
  textClassName?: string;
  summary: ReactNode;
  detail?: StageDetail;
  /** Self-contained control pinned right after the icon (e.g. the CI pill). */
  leading?: ReactNode;
  /** Self-contained control pinned after the summary (e.g. Create PR). */
  trailing?: ReactNode;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);

  const iconBadgeProps = stylex.props(styles.iconBadge);
  const iconBadge = iconOverride ?? (
    <span
      {...iconBadgeProps}
      className={clsx(
        iconBadgeProps.className,
        INFO_BAR_TEXT_CLASS,
        textClassName ?? stylex.props(styles.chipTextMuted).className
      )}
    >
      <ChipFace icon={icon} value={value} />
    </span>
  );

  const summaryInner = (
    <>
      <span {...stylex.props(styles.summaryText)}>{summary}</span>
      {detail ? <ArrowUpRight {...stylex.props(styles.summaryGlyph)} aria-hidden="true" /> : null}
    </>
  );

  const isInteractive = detail?.kind === 'action' || detail?.kind === 'popover';
  const summaryStyleProps = stylex.props(
    styles.summary,
    isInteractive && styles.summaryInteractive,
    detail?.kind === 'popover' && popoverOpen && styles.summaryOpen
  );
  const summaryClassName = clsx(
    summaryStyleProps.className,
    INFO_BAR_TEXT_CLASS,
    textClassName ?? stylex.props(styles.chipTextMuted).className
  );

  let summaryNode: ReactNode;
  if (!detail) {
    summaryNode = (
      <span {...summaryStyleProps} className={summaryClassName}>
        {summaryInner}
      </span>
    );
  } else if (detail.kind === 'action') {
    summaryNode = (
      <button
        type="button"
        aria-label={detail.ariaLabel}
        title={detail.ariaLabel}
        onClick={detail.onAction}
        {...summaryStyleProps}
        className={summaryClassName}
      >
        {summaryInner}
      </button>
    );
  } else {
    summaryNode = (
      <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              aria-label={detail.ariaLabel}
              title={detail.ariaLabel}
              {...summaryStyleProps}
              className={summaryClassName}
            >
              {summaryInner}
            </button>
          }
        />
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          aria-label={detail.ariaLabel}
          className={clsx(
            stylex.props(styles.stagePopover).className,
            'max-w-[min(24rem,90vw)] p-0 shadow-xl'
          )}
        >
          {detail.content}
        </Popover.Content>
      </Popover.Root>
    );
  }

  return (
    // No enter animation — the stage remounts on every promotion, so any
    // fade/slide reads as jitter. Content appears instantly.
    <div role="group" aria-label={label} {...stylex.props(styles.root)}>
      {iconBadge}
      {leading}
      {summaryNode}
      {trailing}
    </div>
  );
}
