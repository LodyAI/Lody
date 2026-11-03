import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { clsx } from 'clsx';
const enter = stylex.keyframes({
  from: {
    opacity: 0,
    transform: 'translate(var(--crh-tooltip-x,0px),var(--crh-tooltip-y,0px)) scale(.95)',
  },
  to: { opacity: 1, transform: 'translate(0,0) scale(1)' },
});
const exit = stylex.keyframes({
  from: { opacity: 1, transform: 'scale(1)' },
  to: { opacity: 0, transform: 'scale(.95)' },
});
const styles = stylex.create({
  content: {
    zIndex: 50,
    overflow: 'hidden',
    borderRadius: 'var(--radius)',
    borderStyle: 'solid',
    borderWidth: 0.5,
    borderColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--popover))',
    color: 'hsl(var(--foreground))',
    boxShadow: '0 0.5px 1px 1px rgba(0,0,0,0.04)',
    transformOrigin: 'var(--radix-tooltip-content-transform-origin)',
    '--crh-tooltip-x': {
      default: '0px',
      ':is([data-side="left"])': 'calc(var(--spacing) * 2)',
      ':is([data-side="right"])': 'calc(var(--spacing) * -2)',
    },
    '--crh-tooltip-y': {
      default: '0px',
      ':is([data-side="top"])': 'calc(var(--spacing) * 2)',
      ':is([data-side="bottom"])': 'calc(var(--spacing) * -2)',
    },
    animationName: { default: enter, ':is([data-state="closed"])': exit },
    animationDuration: '150ms',
    animationTimingFunction: 'ease',
  },
});
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & { xstyle?: stylex.StyleXStyles }
>(({ className, xstyle, sideOffset = 6, style, ...props }, ref) => {
  const sx = stylex.props(styles.content, xstyle);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        {...sx}
        className={clsx('dark', sx.className, className)}
        style={sx.style ? { ...sx.style, ...style } : style}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
