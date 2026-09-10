import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

type BaseProps = ComponentProps<typeof BaseCheckbox.Root>;

export interface CheckboxProps extends Omit<
  BaseProps,
  'className' | 'render' | 'nativeButton' | 'style'
> {
  className?: string;
}

const styles = stylex.create({
  box: {
    width: field.boxSize,
    height: field.boxSize,
    borderRadius: field.boxRadius,
  },
  indicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'inherit',
  },
  mark: {
    display: 'block',
    width: field.markSize,
    height: field.markSize,
  },
});

/**
 * The tick and the mixed-state dash. Drawn here rather than taken from an icon
 * package because this package depends on React, Base UI and StyleX only.
 */
function CheckMark() {
  return (
    <svg {...stylex.props(styles.mark)} viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M1.6 5.2 3.9 7.5 8.4 2.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MixedMark() {
  return (
    <svg {...stylex.props(styles.mark)} viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.2 5h5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A checkbox in the field family: the well as a 16px box, ink once it holds a
 * value. It renders a real `<button>` so the family's `:disabled` and
 * `:focus-visible` rules reach it and a `<label>` can point at it, with Base
 * UI's hidden input beside it carrying the value into a form.
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { className, ...rest },
  ref
) {
  const ariaInvalid = rest['aria-invalid'];
  return (
    <BaseCheckbox.Root
      ref={ref}
      nativeButton
      render={<button type="button" />}
      {...rest}
      className={(state) => {
        const on = state.checked || state.indeterminate;
        return appendClassName(
          stylex.props(
            well.box,
            styles.box,
            on && well.checked,
            isInvalid(state.valid, ariaInvalid) && (on ? well.checkedInvalid : well.invalid)
          ).className,
          className
        );
      }}
    >
      <BaseCheckbox.Indicator
        className={stylex.props(styles.indicator).className}
        render={(props, state) => (
          <span {...props}>{state.indeterminate ? <MixedMark /> : <CheckMark />}</span>
        )}
      />
    </BaseCheckbox.Root>
  );
});
