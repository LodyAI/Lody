import { Field as BaseField } from '@base-ui/react/field';
import { useRender } from '@base-ui/react/use-render';
import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  forwardRef,
  useContext,
  type ComponentProps,
  type ReactElement,
  type Ref,
} from 'react';
import { appendClassName } from '../internal/class-name';
import { text } from '../tokens/scales.stylex';
import { field } from './field.tokens.stylex';

type RootBaseProps = ComponentProps<typeof BaseField.Root>;
type LabelBaseProps = ComponentProps<typeof BaseField.Label>;
type DescriptionBaseProps = ComponentProps<typeof BaseField.Description>;
type ErrorBaseProps = ComponentProps<typeof BaseField.Error>;

/** State every Field part receives from `Field.Root`. */
export type FieldState = BaseField.Root.State;

export interface FieldRootProps extends Omit<RootBaseProps, 'className'> {
  className?: string;
}
export interface FieldLabelProps extends Omit<LabelBaseProps, 'className'> {
  className?: string;
}
export interface FieldDescriptionProps extends Omit<DescriptionBaseProps, 'className'> {
  className?: string;
}
export interface FieldErrorProps extends Omit<ErrorBaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: field.gap,
    minWidth: 0,
  },
  label: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: field.gap,
    color: field.label,
    fontSize: field.labelSize,
    lineHeight: field.labelLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    userSelect: 'none',
  },
  note: {
    margin: 0,
    fontSize: field.labelSize,
    lineHeight: field.labelLeading,
    fontWeight: 400,
  },
  hint: { color: field.hint },
  error: { color: field.error },
  // Disabled is one opacity for the family; the control dims through its own
  // `:disabled`, so nothing here stacks a second layer on top of it.
  dimmed: { opacity: field.disabledOpacity },
});

/**
 * Whether a `Field.Root` is above this part. Base UI's Label, Description and
 * Error throw without one, while its Control does not, so the parts below fall
 * back to the plain element instead of taking the surface down with them. A
 * label with `htmlFor`, or a line of help text, is meaningful on its own; the
 * only thing lost outside a field is the field state, and there is none.
 */
const InsideField = createContext(false);

/** A part rendered outside a field, with `render` still honoured. */
function PlainPart({
  tag,
  sx,
  caller,
  elementRef,
  render,
  props,
}: {
  tag: 'label' | 'p' | 'div';
  sx: ReturnType<typeof stylex.props>;
  caller: string | undefined;
  elementRef: Ref<HTMLElement>;
  render: ReactElement | undefined;
  props: Record<string, unknown>;
}) {
  return useRender({
    render,
    ref: elementRef,
    defaultTagName: tag,
    props: { ...props, className: appendClassName(sx.className, caller), style: sx.style },
  });
}

export const FieldRoot = forwardRef<HTMLDivElement, FieldRootProps>(function FieldRoot(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(styles.root);
  return (
    <InsideField.Provider value={true}>
      <BaseField.Root
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    </InsideField.Provider>
  );
});

export const FieldLabel = forwardRef<HTMLLabelElement, FieldLabelProps>(function FieldLabel(
  { className, render, ...rest },
  ref
) {
  const insideField = useContext(InsideField);
  if (!insideField) {
    return (
      <PlainPart
        tag="label"
        sx={stylex.props(styles.label)}
        caller={className}
        elementRef={ref as Ref<HTMLElement>}
        render={render as ReactElement | undefined}
        props={rest}
      />
    );
  }
  return (
    <BaseField.Label
      ref={ref}
      render={render}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(styles.label, state.disabled && styles.dimmed).className,
          className
        )
      }
    />
  );
});

export const FieldDescription = forwardRef<HTMLParagraphElement, FieldDescriptionProps>(
  function FieldDescription({ className, render, ...rest }, ref) {
    const insideField = useContext(InsideField);
    if (!insideField) {
      return (
        <PlainPart
          tag="p"
          sx={stylex.props(styles.note, styles.hint)}
          caller={className}
          elementRef={ref as Ref<HTMLElement>}
          render={render as ReactElement | undefined}
          props={rest}
        />
      );
    }
    return (
      <BaseField.Description
        ref={ref}
        render={render}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(styles.note, styles.hint, state.disabled && styles.dimmed).className,
            className
          )
        }
      />
    );
  }
);

export const FieldError = forwardRef<HTMLDivElement, FieldErrorProps>(function FieldError(
  { className, render, match, ...rest },
  ref
) {
  const insideField = useContext(InsideField);
  const sx = stylex.props(styles.note, styles.error);
  // Outside a field there is no validity to match against, so the caller owns
  // whether the message is on screen: rendering it is what they asked for.
  if (!insideField) {
    return (
      <PlainPart
        tag="div"
        sx={sx}
        caller={className}
        elementRef={ref as Ref<HTMLElement>}
        render={render as ReactElement | undefined}
        props={rest}
      />
    );
  }
  return (
    <BaseField.Error
      ref={ref}
      render={render}
      match={match}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * The field composition. `Field.Root` owns name, disabled and validity; the
 * parts read that state instead of taking their own copies of it.
 */
export const Field = {
  Root: FieldRoot,
  Label: FieldLabel,
  Description: FieldDescription,
  Error: FieldError,
  Validity: BaseField.Validity,
};
