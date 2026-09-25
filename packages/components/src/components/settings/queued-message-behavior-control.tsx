import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow, sheen } from '@lody/ui/tokens/colors.stylex';
import {
  control,
  corner,
  duration,
  ease,
  focus,
  radius,
  space,
  text,
} from '@lody/ui/tokens/scales.stylex';
import type { QueuedMessageBehavior } from '@/atoms';
import { withClassName } from '@/lib/stylex';

const RING = `0 0 0 ${focus.ringWidth} ${colors.accent}`;

/**
 * A two-way choice is a segmented strip, as `@lody/ui`'s Tabs draw one: a flat
 * tray, and the choice that holds is the one thing standing on it.
 */
const styles = stylex.create({
  track: {
    boxSizing: 'border-box',
    display: 'inline-grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    height: control.small,
    padding: '2px',
    backgroundColor: colors.trayBackground,
    borderRadius: radius.small,
    cornerShape: corner.shape,
  },
  option: {
    minWidth: '64px',
    margin: 0,
    paddingBlock: 0,
    paddingInline: space[3],
    borderWidth: 0,
    borderRadius: `calc(${radius.small} - 2px)`,
    cornerShape: corner.round,
    backgroundColor: 'transparent',
    boxShadow: { default: 'none', ':focus-visible': RING },
    outlineStyle: 'none',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontFamily: 'inherit',
    // A control in a settings row: the size and weight every @lody/ui control takes.
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'color, background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  optionSelected: {
    backgroundColor: colors.trayRaised,
    backgroundImage: sheen.raised,
    boxShadow: { default: shadow.raised, ':focus-visible': `${RING}, ${shadow.raised}` },
    color: { default: colors.label, ':hover': colors.label },
  },
});

export type QueuedMessageBehaviorControlProps = {
  value: QueuedMessageBehavior;
  onChange: (value: QueuedMessageBehavior) => void;
  className?: string;
};

export function QueuedMessageBehaviorControl({
  value,
  onChange,
  className,
}: QueuedMessageBehaviorControlProps) {
  const { t } = useTranslation();
  const options: Array<{ value: QueuedMessageBehavior; label: string }> = [
    {
      value: 'queue',
      label: t('settings.general.sessions.queuedMessageBehavior.queue', 'Queue'),
    },
    {
      value: 'guide',
      label: t('settings.general.sessions.queuedMessageBehavior.guide', 'Steer'),
    },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={t(
        'settings.general.sessions.queuedMessageBehavior.label',
        'Queued message behavior'
      )}
      {...withClassName(stylex.props(styles.track), className)}
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            {...stylex.props(styles.option, selected && styles.optionSelected)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
