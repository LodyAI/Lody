import { Input as BaseInput } from '@base-ui/react/input';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { space, text } from '../tokens/scales.stylex';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

export type InputSize = 'small' | 'medium' | 'large';

type BaseProps = ComponentProps<typeof BaseInput>;

export interface InputProps extends Omit<BaseProps, 'className' | 'size' | 'render'> {
  /** Control height and density. `size` is the token step, not the HTML attribute. */
  size?: InputSize;
  /** Height of the well; density and the leading slot still follow `size`. */
  controlHeight?: CSSProperties['height'];
  /**
   * What the value belongs with, inside the same well at its start: a Role's
   * emoji beside its name. It is part of the control, not a second one beside
   * it, so the field has one edge and one ring. Whatever is put here draws its
   * own content and states no edge: the well rings on `:focus-within`.
   */
  leading?: ReactNode;
  /** Supplementary content at the end of the same well; keeps its intrinsic width. */
  trailing?: ReactNode;
  /** Lands on the control: the input, or the shell when either slot is present. */
  className?: string;
  xstyle?: stylex.StyleXStyles;
  /** Lands on the `<input>` inside the shell, for a constraint only the value takes. */
  inputClassName?: string;
}

const styles = stylex.create({
  input: { display: 'block', lineHeight: text.subheadlineLeading },
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
});

/**
 * Contextual parts share the value's well. The leading square follows the named
 * height less its inset; trailing status content keeps its own width. Each
 * occupied edge takes the inset while an unoccupied value edge keeps its padding.
 */
const INSET = space[1];
const shellStyles = stylex.create({
  // The slot's content and the value are two things in one control: the gap
  // keeps a glyph from touching the first letter without splitting them apart.
  shell: {
    gap: space[1.5],
    fontFamily: 'inherit',
    fontWeight: 500,
    lineHeight: text.subheadlineLeading,
    letterSpacing: text.controlTracking,
  },
  leadingInset: { paddingInlineStart: INSET },
  trailingInset: { paddingInlineEnd: INSET },
  trailing: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    color: field.icon,
  },
  leading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: field.icon,
  },
  leadingSmall: {
    width: `calc(${field.heightSmall} - 2 * ${INSET})`,
    height: `calc(${field.heightSmall} - 2 * ${INSET})`,
  },
  leadingMedium: {
    width: `calc(${field.heightMedium} - 2 * ${INSET})`,
    height: `calc(${field.heightMedium} - 2 * ${INSET})`,
  },
  leadingLarge: {
    width: `calc(${field.heightLarge} - 2 * ${INSET})`,
    height: `calc(${field.heightLarge} - 2 * ${INSET})`,
  },
});

const leadingSizeStyles = {
  small: shellStyles.leadingSmall,
  medium: shellStyles.leadingMedium,
  large: shellStyles.leadingLarge,
};

const sizeStyles = {
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

const dimensions = stylex.create({
  height: (height: string | number) => ({ height }),
});

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'medium',
    controlHeight,
    leading,
    trailing,
    className,
    xstyle,
    inputClassName,
    style,
    ...rest
  },
  ref
) {
  const ariaInvalid = rest['aria-invalid'];
  if (leading != null || trailing != null) {
    // Built from the input's own `render`, as `PasswordInput` builds its shell:
    // the input stays the field's one control, so a `Field.Label` still points
    // at it and its validity and disabled state are what the shell shows.
    return (
      <BaseInput
        ref={ref}
        {...rest}
        style={style}
        render={(props, state) => {
          const shell = stylex.props(
            well.shell,
            sizeStyles[size],
            shellStyles.shell,
            leading != null && shellStyles.leadingInset,
            trailing != null && shellStyles.trailingInset,
            isInvalid(state.valid, ariaInvalid) && well.shellInvalid,
            state.disabled && well.dimmed,
            controlHeight != null && dimensions.height(controlHeight),
            xstyle
          );
          return (
            <div
              data-slot="input-shell"
              data-size={size}
              className={appendClassName(shell.className, className)}
              style={shell.style}
            >
              {leading != null && (
                <span
                  {...stylex.props(shellStyles.leading, leadingSizeStyles[size])}
                  data-slot="input-leading"
                >
                  {leading}
                </span>
              )}
              <input
                {...props}
                className={appendClassName(stylex.props(well.bare).className, inputClassName)}
              />
              {trailing != null && (
                <span {...stylex.props(shellStyles.trailing)} data-slot="input-trailing">
                  {trailing}
                </span>
              )}
            </div>
          );
        }}
      />
    );
  }
  const heightStyle = stylex.props(
    controlHeight != null && dimensions.height(controlHeight),
    xstyle
  ).style;
  return (
    <BaseInput
      ref={ref}
      data-size={size}
      {...rest}
      style={
        heightStyle
          ? (state) => ({
              ...heightStyle,
              ...(typeof style === 'function' ? style(state) : style),
            })
          : style
      }
      className={(state) =>
        appendClassName(
          stylex.props(
            well.base,
            styles.input,
            sizeStyles[size],
            isInvalid(state.valid, ariaInvalid) && well.invalid,
            controlHeight != null && dimensions.height(controlHeight),
            xstyle
          ).className,
          className
        )
      }
    />
  );
});
