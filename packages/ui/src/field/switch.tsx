import { Switch as BaseSwitch } from '@base-ui/react/switch';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { corner, duration, ease, radius } from '../tokens/scales.stylex';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

type BaseProps = ComponentProps<typeof BaseSwitch.Root>;

export interface SwitchProps extends Omit<
  BaseProps,
  'className' | 'render' | 'nativeButton' | 'style'
> {
  className?: string;
}

/** The distance the thumb travels: the track less the thumb and both insets. */
const TRAVEL = `calc(${field.switchWidth} - ${field.switchThumbSize} - 2 * ${field.switchInset})`;

const styles = stylex.create({
  track: {
    width: field.switchWidth,
    height: field.switchHeight,
    borderRadius: radius.full,
    // The well's squircle would make this a rounded rectangle; a track is a pill.
    cornerShape: corner.round,
    justifyContent: 'flex-start',
    padding: field.switchInset,
  },
  thumb: {
    display: 'block',
    width: field.switchThumbSize,
    height: field.switchThumbSize,
    borderRadius: radius.full,
    backgroundColor: field.thumb,
    boxShadow: field.thumbShadow,
    transform: 'translateX(0)',
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  thumbChecked: { transform: `translateX(${TRAVEL})` },
});

/**
 * A switch in the field family: the well as a track, ink once it is on, with a
 * raised thumb that reads against both. It renders a real `<button>` for the
 * same reasons a Checkbox does.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className, ...rest },
  ref
) {
  const ariaInvalid = rest['aria-invalid'];
  return (
    <BaseSwitch.Root
      ref={ref}
      nativeButton
      render={<button type="button" />}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            well.box,
            styles.track,
            state.checked && well.checked,
            isInvalid(state.valid, ariaInvalid) &&
              (state.checked ? well.checkedInvalid : well.invalid)
          ).className,
          className
        )
      }
    >
      <BaseSwitch.Thumb
        className={(state) =>
          stylex.props(styles.thumb, state.checked && styles.thumbChecked).className
        }
      />
    </BaseSwitch.Root>
  );
});
