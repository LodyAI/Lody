import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type MachinePillItem = {
  id: string;
  label: string;
  /** Online status renders a colored dot; omit for non-machine pills (e.g. GitHub). */
  online?: boolean;
  /** Overrides the status dot (e.g. the GitHub glyph). */
  icon?: ReactNode;
  /** Workspace Agents can include private machines without sharing them. */
  private?: boolean;
};

/**
 * Horizontal pill selector shown under the settings title. One pill per machine
 * (online first, ordered by the caller), optionally led by a non-machine pill
 * (the GitHub pill on the Projects tab) and trailed by per-selection actions.
 * Wraps to at most two rows when collapsed; a "More" toggle reveals the rest.
 */
export function MachinePills({
  pills,
  selectedId,
  onSelect,
  trailing,
}: {
  pills: readonly MachinePillItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [collapsedMaxH, setCollapsedMaxH] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const measure = () => {
      const buttons = Array.from(el.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.dataset.pill === 'true'
      );
      if (buttons.length === 0) {
        setOverflow(false);
        return;
      }
      const tops = Array.from(new Set(buttons.map((b) => b.offsetTop))).sort((a, b) => a - b);
      const rowHeight = tops.length > 1 ? tops[1]! - tops[0]! : buttons[0]!.offsetHeight;
      setOverflow(tops.length > 2);
      setCollapsedMaxH(tops[0]! + rowHeight * 2 + Math.round(rowHeight * 0.25));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pills]);

  const clamp = overflow && !expanded;

  return (
    <div className="flex items-start gap-1.5">
      <div
        ref={listRef}
        className={cn(
          'flex min-w-0 flex-1 flex-wrap items-center gap-1.5',
          clamp && 'overflow-hidden'
        )}
        style={clamp ? { maxHeight: collapsedMaxH } : undefined}
      >
        {pills.map((pill) => {
          const selected = pill.id === selectedId;
          return (
            <button
              key={pill.id}
              type="button"
              data-pill="true"
              aria-pressed={selected}
              onClick={() => onSelect(pill.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors',
                selected
                  ? 'border-transparent bg-secondary font-medium text-secondary-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-hover/50 hover:text-foreground'
              )}
            >
              {pill.icon ? (
                <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                  {pill.icon}
                </span>
              ) : pill.online !== undefined ? (
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    pill.online ? 'bg-status-success' : 'bg-muted-foreground/40'
                  )}
                />
              ) : null}
              <span className="whitespace-nowrap">{pill.label}</span>
              {pill.private ? (
                <span className="text-[10px] font-normal text-muted-foreground/70">
                  {t('workspace.machines.private', 'Private')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {overflow ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-hover/50 hover:text-foreground"
        >
          {expanded ? t('common.showLess', 'Less') : t('common.showMore', 'More')}
        </button>
      ) : null}
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
