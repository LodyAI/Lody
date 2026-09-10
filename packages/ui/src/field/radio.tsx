import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import * as stylex from '@stylexjs/stylex';
import { appendClassName } from '../internal/class-name';
import { corner, radius, space } from '../tokens/scales.stylex';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

export interface RadioProps extends Omit<
  BaseRadio.Root.Props,
  'className' | 'render' | 'nativeButton' | 'style'
> {
  className?: string;
}

export interface RadioGroupProps extends Omit<BaseRadioGroup.Props, 'className' | 'style'> {
  className?: string;
}

const styles = stylex.create({
  group: {
    display: 'flex',
    flexDirection: 'column',
    // Options are rows of their own, not the lines of one field, so they sit a
    // step further apart than `field.gap` stacks a label over its control.
    gap: space[2],
    minWidth: 0,
  },
  box: {
    width: field.boxSize,
    height: field.boxSize,
    borderRadius: radius.full,
    // The well's squircle would make this a squircle rather than a circle, which
    // is the one shape that tells a radio apart from a checkbox.
    cornerShape: corner.round,
  },
  dot: {
    display: 'block',
    width: field.dotSize,
    height: field.dotSize,
    borderRadius: radius.full,
    backgroundColor: 'currentColor',
  },
});

/**
 * A radio in the field family: the same well and ink as a Checkbox, round, with
 * one option of a group selected at a time. It renders a real `<button>` for the
 * same reasons a Checkbox does.
 */
export function Radio({ className, ...rest }: RadioProps) {
  const ariaInvalid = rest['aria-invalid'];
  return (
    <BaseRadio.Root
      nativeButton
      render={<button type="button" />}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            well.box,
            styles.box,
            state.checked && well.checked,
            isInvalid(state.valid, ariaInvalid) &&
              (state.checked ? well.checkedInvalid : well.invalid)
          ).className,
          className
        )
      }
    >
      <BaseRadio.Indicator className={stylex.props(styles.dot).className} />
    </BaseRadio.Root>
  );
}

/**
 * Holds the group's name, value and disabled flag, so a `Radio` inside it takes
 * only the value it stands for.
 */
export function RadioGroup({ className, ...rest }: RadioGroupProps) {
  const sx = stylex.props(styles.group);
  return (
    <BaseRadioGroup
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
}
