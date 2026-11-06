import { clsx } from 'clsx';
import * as MentionPrimitive from './mention/index';
import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, text, duration, ease, corner } from '@lody/ui/tokens/scales.stylex';
import type { TextareaAppearance } from '@lody/ui/textarea';

import { withClassName } from '@/lib/stylex';
import { useMentionContext } from './mention/mention-root';
import { mentionSurface as surface } from './mention/mention-surface';

const styles = stylex.create({
  tags: {
    ':is(*) [data-tag]': {
      display: 'inline-block',
      borderRadius: '0.25rem',
      paddingInline: 'calc(var(--spacing) * 0.5)',
      paddingBlock: '1px',
    },
  },
  label: {
    display: 'block',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    paddingInline: 'calc(var(--spacing) * 0.5)',
    fontWeight: 'var(--font-weight-semibold)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  inputShell: { width: '100%', minWidth: 0 },
  inputWell: {
    '--mention-chip-surface': colors.background,
    '--mention-chip-overlay': `linear-gradient(${field.background},${field.background})`,
    backgroundColor: field.background,
    boxShadow: { default: field.well, ':focus-within': `0 0 0 2px ${field.ring}, ${field.well}` },
    borderRadius: field.radiusMedium,
    cornerShape: corner.round,
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  quietWell: { boxShadow: field.well },
  inputInvalid: {
    boxShadow: {
      default: `0 0 0 2px ${field.invalidRing}, ${field.well}`,
      ':focus-within': `0 0 0 2px ${field.invalidRing}, ${field.well}`,
    },
  },
  inputDisabled: { opacity: control.disabledOpacity },
  input: {
    display: 'block',
    width: '100%',
    minWidth: 0,
    resize: 'none',
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: { default: field.value, '::placeholder': field.placeholder },
    fontFamily: 'inherit',
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    fontSize: field.text,
    lineHeight: text.subheadlineLeading,
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus': 'none', ':focus-visible': 'none' },
    opacity: { default: 1, '::placeholder': 1 },
    cursor: { default: 'text', ':disabled': 'default' },
  },
  wellInput: {
    paddingBlock: field.paddingBlock,
    paddingInline: field.paddingXMedium,
    minHeight: field.textareaMinHeight,
  },
  bareInput: { padding: 0 },
  content: {
    position: 'relative',
    zIndex: 'var(--z-popover)',
    minWidth: '8rem',
    overflow: 'hidden',
  },
});

function Mention({
  className,
  xstyle,
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Root> & { xstyle?: stylex.StyleXStyles }) {
  return (
    <MentionPrimitive.Root
      data-slot="mention"
      {...withClassName(stylex.props(styles.tags, xstyle), className)}
      {...props}
    />
  );
}

function MentionLabel({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Label> & { xstyle?: stylex.StyleXStyles }) {
  const label = stylex.props(styles.label, xstyle);
  return (
    <MentionPrimitive.Label
      data-slot="mention-label"
      className={clsx(label.className, className)}
      style={{ ...label.style, ...style }}
      {...props}
    />
  );
}

const MentionInput = React.forwardRef<
  React.ElementRef<typeof MentionPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof MentionPrimitive.Input> & {
    appearance?: TextareaAppearance;
    focusRing?: boolean;
  }
>(
  (
    { className, xstyle, containerXstyle, appearance = 'well', focusRing = true, ...props },
    ref
  ) => {
    return (
      <MentionPrimitive.Input
        ref={ref}
        data-slot="mention-input"
        className={className}
        containerXstyle={[
          styles.inputShell,
          appearance === 'well' && styles.inputWell,
          appearance === 'well' && !focusRing && styles.quietWell,
          appearance === 'well' &&
            (props['aria-invalid'] === true || props['aria-invalid'] === 'true') &&
            styles.inputInvalid,
          props.disabled && styles.inputDisabled,
          containerXstyle,
        ]}
        xstyle={[styles.input, appearance === 'well' ? styles.wellInput : styles.bareInput, xstyle]}
        {...props}
      />
    );
  }
);

MentionInput.displayName = 'MentionInput';

/**
 * The floating rung the menu opens on. A caller's `className` lays it out (its
 * width against `--mention-input-width`); the surface is this component's.
 */
function MentionContent({
  className,
  children,
  style,
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Content>) {
  const surfaceProps = withClassName(stylex.props(surface.surface, styles.content), className);
  return (
    <MentionPrimitive.Portal>
      <MentionPrimitive.Content
        data-slot="mention-content"
        {...props}
        {...surfaceProps}
        style={{ ...surfaceProps.style, ...style }}
      >
        {children}
      </MentionPrimitive.Content>
    </MentionPrimitive.Portal>
  );
}

/** A row: a 28px control that happens to live in a list. */
function MentionItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Item>) {
  const context = useMentionContext('MentionItem');
  const highlighted = context.highlightedItem?.value === props.value;
  const disabled = props.disabled || context.disabled;
  return (
    <MentionPrimitive.Item
      data-slot="mention-item"
      {...props}
      {...withClassName(
        stylex.props(
          surface.item,
          highlighted && surface.itemHighlighted,
          disabled && surface.itemDisabled
        ),
        className
      )}
    >
      {children}
    </MentionPrimitive.Item>
  );
}

export { Mention, MentionContent, MentionInput, MentionItem, MentionLabel };
export { useMentionContext } from './mention/mention-root';
