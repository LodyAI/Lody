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

/**
 * On is a colour the thumb uncovers, not a colour the track turns. The accent is
 * a layer over the well that grows from the start edge as the thumb travels, on
 * the thumb's own duration and easing: half-way, its edge is under the thumb's
 * centre, so the colour reads as what the thumb has passed over — the way a
 * physical switch shows its "on" side — rather than the whole track flipping at
 * once. The sheen rides the same layer so it never lights the empty well.
 */
const FILL = `${field.checkedSheen}, linear-gradient(${field.checkedFill}, ${field.checkedFill})`;

const styles = stylex.create({
  track: {
    width: field.switchWidth,
    height: field.switchHeight,
    borderRadius: radius.full,
    // The well's squircle would make this a rounded rectangle; a track is a pill.
    cornerShape: corner.round,
    justifyContent: 'flex-start',
    padding: field.switchInset,
    backgroundImage: FILL,
    backgroundRepeat: 'no-repeat',
    backgroundSize: '0% 100%, 0% 100%',
    transitionProperty: 'background-size, box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** On: the well stays the well; the layer over it has reached the far end. */
  trackOn: {
    backgroundColor: field.background,
    backgroundImage: FILL,
    backgroundSize: '100% 100%, 100% 100%',
  },
  thumb: {
    display: 'block',
    width: field.switchThumbSize,
    height: field.switchThumbSize,
    borderRadius: radius.full,
    backgroundColor: field.thumb,
    backgroundImage: field.thumbSheen,
    boxShadow: field.thumbShadow,
    transform: 'translateX(0)',
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  thumbChecked: { transform: `translateX(${TRAVEL})` },
});

/**
 * A switch in the field family: the well as a track, the accent fill once it
 * is on, with a raised thumb that reads against both. It renders a real `<button>` for the
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
            // `well.checked` for its edge and its ring; `trackOn` then puts the
            // fill back on the layer instead of the whole track.
            state.checked && well.checked,
            state.checked && styles.trackOn,
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
