import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { clsx } from 'clsx';
const styles = stylex.create({
  base: { flexShrink: 0, backgroundColor: 'hsl(var(--border))' },
  horizontal: { height: 1, width: '100%' },
  vertical: { height: '100%', width: 1 },
});
const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> & { xstyle?: stylex.StyleXStyles }
>(
  (
    { className, xstyle, orientation = 'horizontal', decorative = true, asChild, style, ...props },
    ref
  ) => {
    const sx = stylex.props(
      styles.base,
      orientation === 'horizontal' ? styles.horizontal : styles.vertical,
      xstyle
    );
    return (
      <SeparatorPrimitive.Root
        asChild={asChild}
        ref={ref}
        decorative={decorative}
        orientation={orientation}
        {...sx}
        className={clsx(sx.className, className)}
        style={sx.style ? { ...sx.style, ...style } : style}
        {...props}
      />
    );
  }
);
Separator.displayName = SeparatorPrimitive.Root.displayName;
export { Separator };
