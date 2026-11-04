import { Link2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { PublishedGlyph } from './share-motion';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

/** A highlight crossing a bar, for as long as the copy is being made. */
const sweep = stylex.keyframes({
  from: { backgroundPositionX: '200%' },
  to: { backgroundPositionX: '-100%' },
});

const INK = (percent: number) => `color-mix(in oklab, transparent, ${colors.label} ${percent}%)`;

const styles = stylex.create({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: INK(3),
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  title: {
    margin: 0,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  tag: {
    flexShrink: 0,
    paddingInline: space[1.5],
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundColor: INK(6),
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  lines: { display: 'flex', flexDirection: 'column', gap: '5px' },
  bar: {
    height: '6px',
    borderRadius: '3px',
    backgroundColor: INK(9),
    transitionProperty: 'background-color',
    transitionDuration: duration.slow,
    transitionTimingFunction: ease.standard,
  },
  barLong: { width: '92%' },
  barShort: { width: '58%' },
  /** The copy is being made: a soft highlight crosses each bar, the second a beat behind. */
  barBusy: {
    backgroundImage: `linear-gradient(90deg, transparent 0%, ${INK(16)} 50%, transparent 100%)`,
    backgroundSize: '200% 100%',
    animationName: { default: sweep, [REDUCED_MOTION]: 'none' },
    animationDuration: '1.4s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
  },
  barBusyLater: { animationDelay: '0.2s' },
  /** Written, the bars settle a shade darker: there is now something to read. */
  barDone: { backgroundColor: INK(14) },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    height: '28px',
    boxSizing: 'border-box',
    paddingInline: space[2],
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    boxShadow: 'inset 0 0 0 1px transparent',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
    transitionProperty: 'box-shadow, color',
    transitionDuration: duration.slow,
    transitionTimingFunction: ease.standard,
  },
  /** The ring of the finished link, in the outcome colour. */
  chipDone: {
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, transparent, ${colors.success} 40%)`,
    color: colors.label,
  },
  chipIcon: { flexShrink: 0, width: '14px', height: '14px' },
  chipMark: { flexShrink: 0, width: '16px', height: '16px' },
  chipText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

export type ShareCardState = 'setup' | 'publishing' | 'published';

/**
 * What the recipient will get, drawn small and kept on screen through every step:
 * the conversation's title, two bars standing for its text, and the link it will
 * have. The step changes how it looks rather than replacing it, so the panel reads
 * as one object being made instead of three screens. It states no progress of its
 * own; the bar under it is the one honest number.
 */
export function ShareCard({ title, state }: { title: string; state: ShareCardState }) {
  const { t } = useTranslation();
  const busy = state === 'publishing';
  const done = state === 'published';
  return (
    <div {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.head)}>
        <p {...stylex.props(styles.title)}>{title}</p>
        <span {...stylex.props(styles.tag)}>{t('sharing.static.readOnlyTag', 'Read-only')}</span>
      </div>
      <div {...stylex.props(styles.lines)} aria-hidden="true">
        <span
          {...stylex.props(
            styles.bar,
            styles.barLong,
            busy && styles.barBusy,
            done && styles.barDone
          )}
        />
        <span
          {...stylex.props(
            styles.bar,
            styles.barShort,
            busy && styles.barBusy,
            busy && styles.barBusyLater,
            done && styles.barDone
          )}
        />
      </div>
      <div {...stylex.props(styles.chip, done && styles.chipDone)}>
        {done ? (
          <span {...stylex.props(styles.chipMark)}>
            <PublishedGlyph size={16} />
          </span>
        ) : (
          <Link2 {...stylex.props(styles.chipIcon)} aria-hidden="true" />
        )}
        <span {...stylex.props(styles.chipText)}>
          {done
            ? t('sharing.static.cardReady', 'Link ready')
            : t('sharing.static.cardPlaceholder', 'Your link appears here')}
        </span>
      </div>
    </div>
  );
}
