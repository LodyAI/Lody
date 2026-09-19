import { Toaster as Sonner, ToasterProps } from 'sonner';
import { useResolvedTheme } from '@/theme-provider';

const TOASTER_OFFSET = {
  top: 'calc(24px + env(safe-area-inset-top, 0px))',
} satisfies ToasterProps['offset'];

const MOBILE_TOASTER_OFFSET = {
  top: 'calc(16px + env(safe-area-inset-top, 0px))',
} satisfies ToasterProps['mobileOffset'];

/**
 * Compact chip. Sits with the close control on the right; the title stays left.
 */
const TOAST_BUTTON_CLASS_NAME =
  'mt-0! ml-0! mr-0! h-6! w-auto! shrink-0! justify-center! rounded-md! border-0! bg-foreground/[0.06]! px-2! text-xs! font-normal! text-foreground! shadow-none! hover:bg-foreground/[0.1]!';

const Toaster = ({
  closeButton = true,
  position = 'top-center',
  offset = TOASTER_OFFSET,
  mobileOffset = MOBILE_TOASTER_OFFSET,
  style,
  toastOptions,
  ...props
}: ToasterProps) => {
  // The app resolves light/dark itself (`ThemeProvider`), so Sonner must be told
  // the RESOLVED theme rather than being left to re-derive it from the OS. Its
  // own `system` handling reads `prefers-color-scheme`, which disagrees with the
  // app whenever the user picked a theme explicitly — and Sonner hard-codes the
  // description color per theme attribute, so a mismatch rendered near-white
  // description text on the light toast surface.
  const resolvedTheme = useResolvedTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      closeButton={closeButton}
      position={position}
      offset={offset}
      mobileOffset={mobileOffset}
      toastOptions={{
        ...toastOptions,
        classNames: {
          // Title left, action + close right. Close is first in Sonner's DOM,
          // so `order-last` pins it to the far right of the 356px column.
          toast:
            'w-full! min-w-0! flex-nowrap! items-center! justify-start! gap-2! py-2! pl-3.5! pr-2!',
          content: 'min-w-0! flex-1!',
          title: 'min-w-0! truncate! text-left! leading-5!',
          icon: 'mt-0! shrink-0!',
          // Sonner hard-codes description colors per theme; use the app token so
          // it always reads against the toast surface.
          description: 'text-left! text-muted-foreground!',
          actionButton: TOAST_BUTTON_CLASS_NAME,
          cancelButton: TOAST_BUTTON_CLASS_NAME,
          closeButton:
            'relative! inset-auto! left-auto! right-auto! top-auto! order-last! ml-0! size-5! shrink-0! rounded-md! border-transparent! bg-transparent! text-muted-foreground! transition-colors! hover:bg-hover! hover:text-foreground!',
          ...toastOptions?.classNames,
        },
      }}
      style={
        {
          // `--z-toast` is declared in the editor-overlay z-index registry but never
          // injected as a CSS variable, so it resolves to `auto` and toasts can render
          // behind positioned UI (e.g. the session header at top-center). Fall back to
          // the registry's toast layer (100) so toasts always sit on top.
          zIndex: 'var(--z-toast, 100)',
          // Sonner's default column is 356px and top-center. Keep that floor so
          // a one-line toast is a centered card, not a content-hugging sliver.
          '--width': 'min(22.25rem, calc(100vw - 2rem))',
          // These tokens are raw HSL triplets (e.g. `214 32% 91%`), so they must
          // be wrapped in `hsl(...)` to be valid colors — Sonner drops them into
          // bare `background`/`color`/`border` declarations. The background is an
          // elevated `color-mix` (same recipe as the app's dropdown surfaces in
          // `menu-styles.ts`) so the toast stays distinct from the page even in
          // themes where `--popover` equals `--background` (e.g. light mode).
          '--normal-bg': 'color-mix(in oklab, hsl(var(--popover)) 92%, hsl(var(--foreground)) 8%)',
          '--normal-text': 'hsl(var(--popover-foreground))',
          '--normal-border': 'hsl(var(--border))',
          // Cancel Sonner's default corner-float transform so the close button
          // can sit in-flow on the far right (`order-last`).
          '--toast-close-button-transform': 'none',
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
