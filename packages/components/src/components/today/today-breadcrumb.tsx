import * as stylex from '@stylexjs/stylex';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  crumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    minWidth: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    userSelect: 'none',
  },
  link: {
    minWidth: 0,
    maxWidth: 180,
    flexShrink: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingInline: space[1],
    paddingBlock: 2,
    borderWidth: 0,
    borderRadius: radius.mini,
    background: { default: 'none', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    font: 'inherit',
    cursor: 'pointer',
  },
  first: { flexShrink: 0 },
  current: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingInline: space[1],
    color: colors.label,
  },
  separator: { flexShrink: 0, width: 12, height: 12, color: colors.tertiaryLabel },
  more: { flexShrink: 0, color: colors.tertiaryLabel, paddingInline: space[1] },
});

export type TodayCrumb = { key: string; label: string; onSelect?: () => void };

/**
 * Where the focus view is: "Daily notes › date › ancestors", each part a way
 * back. Middle ancestors fold into "…" so the first and the nearest two stay.
 * Behavior: specs/today-outline.md (Focus view).
 */
export function TodayBreadcrumb(props: { crumbs: readonly TodayCrumb[] }) {
  const { t } = useTranslation();
  const { crumbs } = props;
  const folded = crumbs.length > 5;
  const shown = folded ? [...crumbs.slice(0, 2), null, ...crumbs.slice(-2)] : crumbs;
  return (
    <nav aria-label={t('today.breadcrumb', 'Location')} {...stylex.props(styles.crumbs)}>
      {shown.map((crumb, index) => (
        <Fragment key={crumb?.key ?? 'more'}>
          {index > 0 ? <ChevronRight aria-hidden {...stylex.props(styles.separator)} /> : null}
          {crumb === null ? (
            <span {...stylex.props(styles.more)}>…</span>
          ) : crumb.onSelect ? (
            <button
              type="button"
              title={crumb.label}
              {...stylex.props(styles.link, index === 0 && styles.first)}
              onClick={crumb.onSelect}
            >
              {crumb.label}
            </button>
          ) : (
            <span {...stylex.props(styles.current)} aria-current="page" title={crumb.label}>
              {crumb.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
