import * as MentionPrimitive from './mention/index';
import * as React from 'react';

import { cn } from '@/lib/utils';

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

function MentionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Content>) {
  return (
    <MentionPrimitive.Portal>
      <MentionPrimitive.Content
        data-slot="mention-content"
        className={cn(
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-[var(--z-popover)] min-w-32 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=open]:animate-in',
          className
        )}
        {...props}
      >
        {children}
      </MentionPrimitive.Content>
    </MentionPrimitive.Portal>
  );
}

function MentionItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MentionPrimitive.Item>) {
  return (
    <MentionPrimitive.Item
      data-slot="mention-item"
      className={cn(
        'relative flex w-full cursor-default select-none items-center gap-2 rounded-xs px-2 py-1.5 text-sm outline-hidden data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[highlighted]:text-hover-foreground data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      {children}
    </MentionPrimitive.Item>
  );
}

export { Mention, MentionContent, MentionInput, MentionItem, MentionLabel };
export { useMentionContext } from './mention/mention-root';
