import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './utils';

/* Same base + variant classes as the app's `ui/button`, so replica chrome copied
   from the app keeps its size and hover treatment. Display-only: the landing
   frame is inert, so there is no asChild/Slot support. */
const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&_svg]:shrink-0";

const VARIANTS = {
  default: 'bg-primary text-primary-foreground shadow-sm hover:bg-[hsl(var(--button-hover))]',
  outline:
    'border border-input-border bg-background shadow-xs hover:bg-hover hover:text-hover-foreground',
  secondary:
    'bg-[hsl(var(--button-secondary))] text-[hsl(var(--button-secondary-foreground))] shadow-xs hover:bg-[hsl(var(--button-secondary-hover))]',
  ghost: 'hover:bg-hover hover:text-hover-foreground',
  link: 'text-primary underline-offset-4 hover:underline',
} as const;

const SIZES = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  lg: 'h-10 rounded-md px-8',
  icon: 'h-9 w-9',
} as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
});
