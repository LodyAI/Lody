import { Input as BaseInput } from '@base-ui/react/input';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { space } from '../tokens/scales.stylex';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

export type InputSize = 'small' | 'medium' | 'large';

type BaseProps = ComponentProps<typeof BaseInput>;

export interface InputProps extends Omit<BaseProps, 'className' | 'size' | 'render'> {
  /** Control height and density. `size` is the token step, not the HTML attribute. */
  size?: InputSize;
  /**
   * What the value belongs with, inside the same well at its start: a Role's
   * emoji beside its name. It is part of the control, not a second one beside
   * it, so the field has one edge and one ring. Whatever is put here draws its
   * own content and states no edge: the well rings on `:focus-within`.
   */
  leading?: ReactNode;
  /**
   * The same slot at the well's end, for a control that acts on the value — a
   * toggle that changes what the field searches by. It draws no edge either.
   */
  trailing?: ReactNode;
  /** Lands on the control: the input, or the shell once there is a slot. */
  className?: string;
  /** Lands on the `<input>` inside the shell, for a constraint only the value takes. */
  inputClassName?: string;
}

const styles = stylex.create({
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
});

/**
 * A well holding something before or after the value. A slot is a square as tall as
 * the well less the inset a nested part keeps from its container, so a pressable
 * thing in it sits as far from the well's edge as a tab sits from its track, and
 * a character in it — a `/` — is centred where the value's padding would be.
 */
const INSET = space[1];
const shellStyles = stylex.create({
  // The slot's content and the value are two things in one control: the gap
  // keeps a glyph from touching the first letter without splitting them apart.
  shell: { gap: space[1.5] },
  leadingInset: { paddingInlineStart: INSET },
  trailingInset: { paddingInlineEnd: INSET },
  slot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: field.icon,
  },
  slotSmall: {
    width: `calc(${field.heightSmall} - 2 * ${INSET})`,
    height: `calc(${field.heightSmall} - 2 * ${INSET})`,
  },
  slotMedium: {
    width: `calc(${field.heightMedium} - 2 * ${INSET})`,
    height: `calc(${field.heightMedium} - 2 * ${INSET})`,
  },
  slotLarge: {
    width: `calc(${field.heightLarge} - 2 * ${INSET})`,
    height: `calc(${field.heightLarge} - 2 * ${INSET})`,
  },
});

const slotSizeStyles = {
  small: shellStyles.slotSmall,
  medium: shellStyles.slotMedium,
  large: shellStyles.slotLarge,
};

const sizeStyles = {
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

function shellProps(
  size: InputSize,
  leading: ReactNode,
  trailing: ReactNode,
  { invalid = false, disabled = false }: { invalid?: boolean; disabled?: boolean } = {}
) {
  return stylex.props(
    well.shell,
    sizeStyles[size],
    shellStyles.shell,
    leading != null && shellStyles.leadingInset,
    trailing != null && shellStyles.trailingInset,
    invalid && well.shellInvalid,
    disabled && well.dimmed
  );
}

function Slot({ size, children }: { size: InputSize; children: ReactNode }) {
  return <span {...stylex.props(shellStyles.slot, slotSizeStyles[size])}>{children}</span>;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'medium', leading, trailing, className, inputClassName, ...rest },
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
        render={(props, state) => {
          const shell = shellProps(size, leading, trailing, {
            invalid: isInvalid(state.valid, ariaInvalid),
            disabled: state.disabled,
          });
          return (
            <div
              data-size={size}
              className={appendClassName(shell.className, className)}
              style={shell.style}
            >
              {leading != null && <Slot size={size}>{leading}</Slot>}
              <input
                {...props}
                className={appendClassName(stylex.props(well.bare).className, inputClassName)}
              />
              {trailing != null && <Slot size={size}>{trailing}</Slot>}
            </div>
          );
        }}
      />
    );
  }
  return (
    <BaseInput
      ref={ref}
      data-size={size}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            well.base,
            styles.input,
            sizeStyles[size],
            isInvalid(state.valid, ariaInvalid) && well.invalid
          ).className,
          className
        )
      }
    />
  );
});

export interface InputShellProps extends Omit<ComponentProps<'div'>, 'className'> {
  size?: InputSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Lands on the shell, which is the well: a width or a grid placement. */
  className?: string;
}

/**
 * The well an `Input` with a slot draws, around a value that is not typed: a
 * recorded key combo shown as caps. It lays out exactly as `Input` does, so a
 * surface can swap one for the other in place without the edge moving. The
 * children are the value: they grow, state no edge and take focus themselves,
 * and the well rings on `:focus-within`.
 */
export const InputShell = forwardRef<HTMLDivElement, InputShellProps>(function InputShell(
  { size = 'medium', leading, trailing, className, children, ...rest },
  ref
) {
  const shell = shellProps(size, leading, trailing);
  return (
    <div
      ref={ref}
      data-size={size}
      {...rest}
      className={appendClassName(shell.className, className)}
      style={shell.style}
    >
      {leading != null && <Slot size={size}>{leading}</Slot>}
      {children}
      {trailing != null && <Slot size={size}>{trailing}</Slot>}
    </div>
  );
});
