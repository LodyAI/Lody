import { Input as BaseInput } from '@base-ui/react/input';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, useState, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { EyeGlyph, EyeOffGlyph } from '../internal/glyphs';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

/** The control sits on the same 28 / 32 / 36 ladder as `Input`. */
export type PasswordInputSize = 'small' | 'medium' | 'large';

export interface PasswordInputLabels {
  /** Names the reveal while the password is masked: pressing it shows. */
  show: string;
  /** And once it is showing. */
  hide: string;
}

type InputBaseProps = ComponentProps<typeof BaseInput>;

export interface PasswordInputProps extends Omit<
  InputBaseProps,
  'className' | 'size' | 'type' | 'render'
> {
  /** Control height and density. `size` is the token step, not the HTML attribute. */
  size?: PasswordInputSize;
  /**
   * What the reveal is called in each of its two states. A surface shown to
   * somebody not reading English states both: this is the only text in the
   * control, and it is never on screen.
   */
  labels?: Partial<PasswordInputLabels>;
  /** Lands on the shell, which is the control: a width or a grid placement. */
  className?: string;
  /** Lands on the `<input>` inside it, for a constraint only the value takes. */
  inputClassName?: string;
}

const DEFAULT_LABELS: PasswordInputLabels = {
  show: 'Show password',
  hide: 'Hide password',
};

const styles = stylex.create({
  /** The reveal keeps the shell's end padding off it. */
  shell: { gap: field.triggerGap },
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

/**
 * A secret, and the control that reveals it. The two share one well the way a
 * Combobox's input and its chevron do: a reveal button beside the control
 * would be a second control, and the ring would then say which of the two has
 * focus rather than that the field does.
 *
 * Base UI has no password primitive and no part that renders a well around one
 * — `Field.Item` looks like it, but it opens a labelable scope of its own, and
 * a `Field.Label` outside it then points at a control that does not exist. So
 * the input stays the field's one control and builds the shell from its own
 * `render`: the state that reaches the shell's ring and the reveal's
 * `disabled` is the input's, which is the only thing either of them can mean.
 *
 * Whether the password is showing is this component's own state, never a prop:
 * it is a glance, not a setting, and a surface that could persist it would be
 * persisting "show me the password".
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ size = 'medium', labels, className, inputClassName, ...rest }, ref) {
    const [visible, setVisible] = useState(false);
    const words = { ...DEFAULT_LABELS, ...labels };
    const ariaInvalid = rest['aria-invalid'];
    return (
      <BaseInput
        ref={ref}
        type={visible ? 'text' : 'password'}
        {...rest}
        render={(props, state) => {
          const shell = stylex.props(
            well.shell,
            styles.shell,
            sizeStyles[size],
            isInvalid(state.valid, ariaInvalid) && well.shellInvalid,
            // `:disabled` cannot reach a `<div>`, so the family's one disabled
            // value is applied from the control's state instead.
            state.disabled && well.dimmed
          );
          return (
            <div
              data-size={size}
              className={appendClassName(shell.className, className)}
              style={shell.style}
            >
              <input
                {...props}
                className={appendClassName(stylex.props(well.bare).className, inputClassName)}
              />
              <button
                type="button"
                onClick={() => setVisible((shown) => !shown)}
                disabled={state.disabled}
                aria-label={visible ? words.hide : words.show}
                aria-pressed={visible}
                aria-controls={props.id}
                {...stylex.props(well.adornment)}
              >
                {visible ? <EyeOffGlyph /> : <EyeGlyph />}
              </button>
            </div>
          );
        }}
      />
    );
  }
);
