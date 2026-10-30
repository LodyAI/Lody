import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as SeparatorPrimitive from '@radix-ui/react-separator';

import { cn } from '@/lib/utils';

const styles = stylex.create({
  base: { flexShrink: 0, backgroundColor: 'hsl(var(--border))' },
  horizontal: { height: 1, width: '100%' },
  vertical: { height: '100%', width: 1 },
});

const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, asChild, ...props }, ref) => (
  <SeparatorPrimitive.Root
    asChild={asChild}
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      // Slot keeps the original unmerged utility cascade of parent and child.
      (asChild ?? false)
        ? 'shrink-0 bg-border'
        : stylex.props(
            styles.base,
            orientation === 'horizontal' ? styles.horizontal : styles.vertical
          ).className,
      (asChild ?? false) && (orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px'),
      className
    )}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
