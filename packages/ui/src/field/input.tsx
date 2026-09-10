import { Input as BaseInput } from '@base-ui/react/input';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

export type InputSize = 'small' | 'medium' | 'large';

type BaseProps = ComponentProps<typeof BaseInput>;

export interface InputProps extends Omit<BaseProps, 'className' | 'size'> {
  /** Control height and density. `size` is the token step, not the HTML attribute. */
  size?: InputSize;
  className?: string;
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

const sizeStyles = {
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'medium', className, ...rest },
  ref
) {
  const ariaInvalid = rest['aria-invalid'];
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
