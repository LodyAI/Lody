import {
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';

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
const CHIP_BUTTON_CLASS =
  'flex h-6 shrink-0 select-none items-center gap-1 rounded-md px-1 text-xs transition-colors hover:bg-muted-foreground/10';

function ChipFace({ icon: Icon, value }: { icon: InfoChipIcon; value?: string }) {
  return (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {value ? <span className="hidden shrink-0 tabular-nums @[420px]:inline">{value}</span> : null}
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
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onAction}
      className={cn(CHIP_BUTTON_CLASS, textClassName ?? 'text-muted-foreground')}
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
  content: ReactNode;
  /** Storybook/testing aid. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Anchor to the enclosing info-bar pill so the panel shares its edges.
  // Radix reads `current` after mount, when `closest` can resolve.
  const surfaceRef = useMemo(
    () => ({
      get current() {
        const button = buttonRef.current!;
        return button.closest('[data-info-bar-surface]') ?? button;
      },
    }),
    []
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor virtualRef={surfaceRef} />
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value_) => !value_)}
        className={cn(
          CHIP_BUTTON_CLASS,
          'text-muted-foreground',
          open && 'bg-muted-foreground/10 text-foreground'
        )}
      >
        <ChipFace icon={icon} value={value} />
      </button>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={4}
        aria-label={label}
        onPointerDownOutside={(event) => {
          const target = event.target as Node | null;
          if (target && buttonRef.current?.contains(target)) {
            event.preventDefault();
          }
        }}
        // The panel spans the pill, edge to edge.
        className="w-[var(--radix-popover-trigger-width)] border-border/60 p-0 shadow-xl"
      >
        {content}
      </PopoverContent>
    </Popover>
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
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={false}
      title={label}
      onClick={onPromote}
      className={cn(CHIP_BUTTON_CLASS, textClassName ?? 'text-muted-foreground')}
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
  const anchorRef = useRef<HTMLButtonElement>(null);

  const iconBadge = iconOverride ?? (
    <span
      className={cn(
        'flex h-6 shrink-0 select-none items-center gap-1 px-1 text-xs',
        textClassName ?? 'text-muted-foreground'
      )}
    >
      <ChipFace icon={icon} value={value} />
    </span>
  );

  const summaryInner = (
    <>
      <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
      {detail ? (
        <ArrowUpRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
          aria-hidden="true"
        />
      ) : null}
    </>
  );

  const summaryClassName = cn(
    'flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-xs',
    textClassName ?? 'text-muted-foreground'
  );

  let summaryNode: ReactNode;
  if (!detail) {
    summaryNode = <span className={summaryClassName}>{summaryInner}</span>;
  } else if (detail.kind === 'action') {
    summaryNode = (
      <button
        type="button"
        aria-label={detail.ariaLabel}
        title={detail.ariaLabel}
        onClick={detail.onAction}
        className={cn(
          summaryClassName,
          'select-none transition-colors hover:bg-muted-foreground/10'
        )}
      >
        {summaryInner}
      </button>
    );
  } else {
    summaryNode = (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverAnchor asChild>
          <button
            ref={anchorRef}
            type="button"
            aria-label={detail.ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={popoverOpen}
            title={detail.ariaLabel}
            onClick={() => setPopoverOpen((value_) => !value_)}
            className={cn(
              summaryClassName,
              'select-none transition-colors hover:bg-muted-foreground/10',
              popoverOpen && 'bg-muted-foreground/10'
            )}
          >
            {summaryInner}
          </button>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          aria-label={detail.ariaLabel}
          onPointerDownOutside={(event) => {
            const target = event.target as Node | null;
            if (target && anchorRef.current?.contains(target)) {
              event.preventDefault();
            }
          }}
          className="w-96 max-w-[min(24rem,90vw)] border-border/60 p-0 shadow-xl"
        >
          {detail.content}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    // No enter animation — the stage remounts on every promotion, so any
    // fade/slide reads as jitter. Content appears instantly.
    <div role="group" aria-label={label} className="flex min-w-0 flex-1 items-center gap-1">
      {iconBadge}
      {leading}
      {summaryNode}
      {trailing}
    </div>
  );
}
