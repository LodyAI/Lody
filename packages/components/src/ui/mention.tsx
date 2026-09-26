import * as MentionPrimitive from './mention/index';
import * as React from 'react';
import * as stylex from '@stylexjs/stylex';

import { cn } from '@/lib/utils';
import { withClassName } from '@/lib/stylex';
import { useMentionContext } from './mention/mention-root';
import { mentionSurface as surface } from './mention/mention-surface';

const styles = stylex.create({
  content: {
    position: 'relative',
    zIndex: 'var(--z-popover)',
    minWidth: '8rem',
    overflow: 'hidden',
  },
});

function Mention({ className, ...props }: React.ComponentProps<typeof MentionPrimitive.Root>) {
  return (
    <MentionPrimitive.Root
      data-slot="mention"
      className={cn(
        '**:data-tag:inline-block **:data-tag:rounded **:data-tag:px-0.5 **:data-tag:py-px',
        className
      )}
      {...props}
    />
  );
}

function MentionLabel({
  className,
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Label>) {
  return (
    <MentionPrimitive.Label
      data-slot="mention-label"
      className={cn('px-0.5 py-1.5 font-semibold text-sm', className)}
      {...props}
    />
  );
}

const MentionInput = React.forwardRef<
  React.ElementRef<typeof MentionPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof MentionPrimitive.Input>
>(({ className, ...props }, ref) => {
  return (
    <MentionPrimitive.Input
      ref={ref}
      data-slot="mention-input"
      className={cn(
        'flex w-full resize-none text-input-foreground placeholder:text-input-placeholder focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
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
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Content>) {
  return (
    <MentionPrimitive.Portal>
      <MentionPrimitive.Content
        data-slot="mention-content"
        {...props}
        {...withClassName(stylex.props(surface.surface, styles.content), className)}
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
