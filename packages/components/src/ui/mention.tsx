import { clsx } from 'clsx';
import * as MentionPrimitive from './mention/index';
import * as React from 'react';
import * as stylex from '@stylexjs/stylex';

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
  input: {
    display: 'flex',
    width: '100%',
    resize: 'none',
    color: {
      default: 'hsl(var(--input-foreground) / 1)',
      '::placeholder': 'hsl(var(--input-placeholder) / 1)',
    },
    outlineStyle: { default: null, ':focus-visible': 'none' },
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.5 },
  },
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
  React.ComponentPropsWithoutRef<typeof MentionPrimitive.Input>
>(({ className, xstyle, ...props }, ref) => {
  return (
    <MentionPrimitive.Input
      ref={ref}
      data-slot="mention-input"
      className={className}
      xstyle={[styles.input, xstyle]}
      {...props}
    />
  );
});

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
