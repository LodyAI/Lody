import { NumberField as BaseNumberField } from '@base-ui/react/number-field';
import * as stylex from '@stylexjs/stylex';
import { createContext, forwardRef, useContext, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { MinusGlyph, PlusGlyph } from '../internal/glyphs';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

/** The control sits on the same 28 / 32 / 36 ladder as `Input`. */
export type NumberFieldSize = 'small' | 'medium' | 'large';

type RootBaseProps = ComponentProps<typeof BaseNumberField.Root>;
type GroupBaseProps = ComponentProps<typeof BaseNumberField.Group>;
type InputBaseProps = ComponentProps<typeof BaseNumberField.Input>;
type StepperBaseProps = ComponentProps<typeof BaseNumberField.Increment>;
type ScrubAreaBaseProps = ComponentProps<typeof BaseNumberField.ScrubArea>;

export interface NumberFieldRootProps extends Omit<RootBaseProps, 'className'> {
  className?: string;
}

export interface NumberFieldGroupProps extends Omit<GroupBaseProps, 'className'> {
  /** Control height and density. `size` is the token step, not the HTML attribute. */
  size?: NumberFieldSize;
  className?: string;
}

export interface NumberFieldInputProps extends Omit<
  InputBaseProps,
  'className' | 'size' | 'render'
> {
  size?: NumberFieldSize;
  className?: string;
}

export interface NumberFieldStepperProps extends Omit<StepperBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

export interface NumberFieldScrubAreaProps extends Omit<ScrubAreaBaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  // The root is a wrapper, not a surface: it draws nothing and takes no space
  // of its own, so a caller's width lands on it and reaches the control below.
  root: { minWidth: 0 },
  input: { display: 'block' },
  small: {
    height: field.heightSmall,
    paddingInline: field.paddingXSmall,
    borderRadius: field.radiusSmall,
    fontSize: field.text,
  },
  medium: {
    height: field.heightMedium,
    paddingInline: field.paddingXMedium,
    borderRadius: field.radiusMedium,
    fontSize: field.text,
  },
  large: {
    height: field.heightLarge,
    paddingInline: field.paddingXLarge,
    borderRadius: field.radiusMedium,
    fontSize: field.text,
  },
  /** The steppers beside the value keep the shell's end padding off them. */
  group: { gap: field.triggerGap },
  /**
   * Dragging the label is a pointer gesture over text, so the area says so and
   * nothing inside it can be selected while a drag is under way.
   */
  scrubArea: { cursor: 'ew-resize', userSelect: 'none' },
});

const sizeStyles = {
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

/**
 * Whether a `NumberField.Group` is above the input, read the way Combobox
 * reads its own group: the group is the well when there is one, so the input
 * inside it is bare and the two cannot draw two wells.
 */
const InsideGroup = createContext(false);

/**
 * A number, with the range and the step it moves in. The root owns `value`,
 * `min`, `max` and `step` and hands back a `number | null`, so a surface never
 * parses a string or clamps one itself.
 */
export const NumberFieldRoot = forwardRef<HTMLDivElement, NumberFieldRootProps>(
  function NumberFieldRoot({ className, ...rest }, ref) {
    const sx = stylex.props(styles.root);
    return (
      <BaseNumberField.Root
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/**
 * The shell holding the value and the steppers beside it. It is the well, and
 * the ring follows focus inside it, so a stepper lands inside one control
 * rather than beside a second one.
 */
export const NumberFieldGroup = forwardRef<HTMLDivElement, NumberFieldGroupProps>(
  function NumberFieldGroup({ size = 'medium', className, ...rest }, ref) {
    const ariaInvalid = rest['aria-invalid'];
    return (
      <InsideGroup.Provider value={true}>
        <BaseNumberField.Group
          ref={ref}
          data-size={size}
          {...rest}
          className={(state) =>
            appendClassName(
              stylex.props(
                well.shell,
                styles.group,
                sizeStyles[size],
                isInvalid(state.valid, ariaInvalid) && well.shellInvalid,
                // `:disabled` cannot reach a `<div>`, so the family's one
                // disabled value is applied from Base UI's state instead.
                state.disabled && well.dimmed
              ).className,
              className
            )
          }
        />
      </InsideGroup.Provider>
    );
  }
);

/**
 * The value a person types. On its own it is the whole control, a well on the
 * size ladder; inside a `NumberField.Group` the group is the well and this is
 * bare.
 *
 * It states `aria-invalid` itself. Base UI marks a number field's input
 * `data-invalid` but — unlike its plain `Input` — never `aria-invalid`, so an
 * invalid field would draw the ring while a screen reader announced nothing.
 * This package's rule is that those two are one fact, which is why `render`
 * is not a prop here: the input is the input. Disabled is the one case it is
 * left off, because that is what `Input` does: a control nobody can reach is
 * outside constraint validation, and announcing it invalid is noise.
 */
export const NumberFieldInput = forwardRef<HTMLInputElement, NumberFieldInputProps>(
  function NumberFieldInput({ size = 'medium', className, ...rest }, ref) {
    const insideGroup = useContext(InsideGroup);
    const ariaInvalid = rest['aria-invalid'];
    return (
      <BaseNumberField.Input
        ref={ref}
        data-size={insideGroup ? undefined : size}
        {...rest}
        className={(state) =>
          appendClassName(
            insideGroup
              ? stylex.props(well.bare).className
              : stylex.props(
                  well.base,
                  styles.input,
                  sizeStyles[size],
                  isInvalid(state.valid, ariaInvalid) && well.invalid
                ).className,
            className
          )
        }
        render={(props, state) => (
          <input
            {...props}
            aria-invalid={
              isInvalid(state.valid, ariaInvalid) && !state.disabled ? true : props['aria-invalid']
            }
          />
        )}
      />
    );
  }
);

/**
 * One step down. Base UI keeps both steppers out of the tab order — the input
 * takes the arrow keys — and names them "Decrease" and "Increase" in English,
 * so a localised surface passes its own `aria-label`.
 */
export const NumberFieldDecrement = forwardRef<HTMLButtonElement, NumberFieldStepperProps>(
  function NumberFieldDecrement({ className, children, ...rest }, ref) {
    const sx = stylex.props(well.adornment);
    return (
      <BaseNumberField.Decrement
        ref={ref}
        nativeButton
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      >
        {children ?? <MinusGlyph />}
      </BaseNumberField.Decrement>
    );
  }
);

/** One step up. */
export const NumberFieldIncrement = forwardRef<HTMLButtonElement, NumberFieldStepperProps>(
  function NumberFieldIncrement({ className, children, ...rest }, ref) {
    const sx = stylex.props(well.adornment);
    return (
      <BaseNumberField.Increment
        ref={ref}
        nativeButton
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      >
        {children ?? <PlusGlyph />}
      </BaseNumberField.Increment>
    );
  }
);

/**
 * The label a person can drag sideways to change the value. It is a pointer
 * gesture and nothing else — the steppers and the arrow keys are what a
 * keyboard and a screen reader use — so it wraps text rather than the control.
 */
export const NumberFieldScrubArea = forwardRef<HTMLSpanElement, NumberFieldScrubAreaProps>(
  function NumberFieldScrubArea({ className, ...rest }, ref) {
    const sx = stylex.props(styles.scrubArea);
    return (
      <BaseNumberField.ScrubArea
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/**
 * The number composition. The root owns the range; a group is the well when
 * the value has steppers beside it, and the input is the whole control when it
 * has not.
 */
export const NumberField = {
  Root: NumberFieldRoot,
  Group: NumberFieldGroup,
  Input: NumberFieldInput,
  Decrement: NumberFieldDecrement,
  Increment: NumberFieldIncrement,
  ScrubArea: NumberFieldScrubArea,
};
