import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Toggle } from '@lody/ui/toggle';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';

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
    <div {...stylex.props(styles.root)}>
      <div
        ref={listRef}
        {...stylex.props(
          styles.list,
          clamp && styles.clamped,
          clamp && collapsedMaxH !== undefined && styles.maxHeight(`${collapsedMaxH}px`)
        )}
      >
        {pills.map((pill) => {
          const selected = pill.id === selectedId;
          return (
            <Toggle
              key={pill.id}
              type="button"
              size="mini"
              shape="pill"
              data-pill="true"
              pressed={selected}
              onClick={() => onSelect(pill.id)}
            >
              {pill.icon ? (
                <span {...stylex.props(styles.glyph)}>{pill.icon}</span>
              ) : pill.online !== undefined ? (
                <span aria-hidden {...stylex.props(styles.dot, pill.online && styles.dotOnline)} />
              ) : null}
              <span {...stylex.props(styles.label)} title={pill.label}>
                {pill.label}
              </span>
              {selected && pill.online === false ? (
                <span {...stylex.props(styles.meta)}>
                  {t('workspace.machines.offline', 'Offline')}
                </span>
              ) : null}
              {pill.private ? (
                <span {...stylex.props(styles.meta)}>
                  {t('workspace.machines.private', 'Private')}
                </span>
              ) : null}
            </Toggle>
          );
        })}
      </div>
      {overflow ? (
        <Button
          type="button"
          variant="ghost"
          size="mini"
          shape="pill"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('common.showLess', 'Less') : t('common.showMore', 'More')}
        </Button>
      ) : null}
      {trailing ? <div {...stylex.props(styles.trailing)}>{trailing}</div> : null}
    </div>
  );
}

const styles = stylex.create({
  root: { display: 'flex', alignItems: 'flex-start', gap: space[1.5] },
  list: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
  },
  clamped: { overflow: 'hidden' },
  maxHeight: (value: string) => ({ maxHeight: value }),
  glyph: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '12px',
    height: '12px',
  },
  dot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  dotOnline: { backgroundColor: colors.success },
  label: {
    maxWidth: '9.5rem',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: { fontSize: '10px', fontWeight: 400, color: colors.secondaryLabel },
  trailing: { flexShrink: 0 },
});
