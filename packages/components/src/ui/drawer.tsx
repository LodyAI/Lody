import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import * as stylex from '@stylexjs/stylex';
import { ModalContainerProvider, PopupContainerProvider } from '@lody/ui/popup-container';

import { cn } from '@/lib/utils';
import { isNativeAppShell, isNativeIOSAppShell } from '@/lib/native-platform';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../style/theme-scale.stylex';

const styles = stylex.create({
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    backgroundColor: 'color-mix(in oklab, var(--color-black, #000) 50%, transparent)',
  },
  content: {
    backgroundColor: themeColors.background,
    position: 'fixed',
    zIndex: 50,
    display: 'flex',
    height: 'auto',
    flexDirection: 'column',
  },
  fullWidth: { width: '100%', maxWidth: 'none' },
  grabber: {
    backgroundColor: `color-mix(in oklab, ${themeColors.mutedForeground} 40%, transparent)`,
    marginInline: 'auto',
    marginTop: themeSpace[3],
    display: 'none',
    height: themeSpace[1.5],
    width: themeSpace[10],
    flexShrink: 0,
    borderRadius: 'calc(infinity * 1px)',
  },
  popupHost: { display: 'contents' },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[0.5],
    padding: themeSpace[4],
  },
  footer: {
    marginTop: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    padding: themeSpace[4],
  },
  title: { color: themeColors.foreground, fontWeight: themeFontWeight.semibold },
  description: {
    color: themeColors.mutedForeground,
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
});

const DrawerViewportContext = React.createContext(false);

function Drawer({ repositionInputs, ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  // Android-compatible shells can resize the layout viewport along with the
  // keyboard. Vaul captures that already-shrunk drawer as its initial height
  // and can restore it on hide (e.g. HarmonyOS / Zhuoyi). Side drawers instead
  // keep their CSS height and track only the currently occluded bottom edge.
  const followViewport =
    (props.direction === 'right' || props.direction === 'left') &&
    !props.snapPoints &&
    repositionInputs !== false &&
    (isNativeAppShell() || repositionInputs === true) &&
    !isNativeIOSAppShell();

  return (
    <DrawerViewportContext.Provider value={followViewport}>
      <DrawerPrimitive.Root
        data-slot="drawer"
        {...props}
        repositionInputs={followViewport ? false : repositionInputs}
      />
    </DrawerViewportContext.Provider>
  );
}

function useDrawerViewportBottom() {
  const enabled = React.useContext(DrawerViewportContext);
  const [bottom, setBottom] = React.useState(0);

  React.useLayoutEffect(() => {
    if (!enabled) return undefined;
    const viewport = window.visualViewport;
    const measure = () => {
      // A resized WebView needs no extra inset; an overlay keyboard does.
      // Never infer keyboard visibility from focus or resize-event counts:
      // Android's Back button can hide the keyboard while retaining focus.
      setBottom(
        // Allow small scale-reporting errors while excluding pinch zoom.
        viewport && Math.abs(viewport.scale - 1) < 0.01
          ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
          : 0
      );
    };
    measure();
    window.addEventListener('resize', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
    };
  }, [enabled]);

  return enabled ? bottom : undefined;
}

function DrawerTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

const DrawerOverlay = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Overlay
    ref={ref}
    data-slot="drawer-overlay"
    className={cn(
      stylex.props(styles.overlay).className,
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DrawerOverlay.displayName = 'DrawerOverlay';

export type DrawerContentProps = Omit<
  React.ComponentProps<typeof DrawerPrimitive.Content>,
  'width'
> & {
  /** Fill the available width without directional caps. Omission preserves defaults.
   * Regular class and inline-style precedence still applies. */
  width?: 'full';
};

function DrawerContent({ width, className, children, style, ...props }: DrawerContentProps) {
  const viewportBottom = useDrawerViewportBottom();
  const [popupContainer, setPopupContainer] = React.useState<HTMLDivElement | null>(null);
  const mergedStyle = {
    '--lody-drawer-width': '256px',
    ...style,
    ...(viewportBottom === undefined ? {} : { bottom: viewportBottom }),
  } as React.CSSProperties;

  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          stylex.props(styles.content, width === 'full' && styles.fullWidth).className,
          'group/drawer-content',
          // Directional variants outrank ordinary caller classes in the original
          // utilities layer. Keep that public override order during coexistence.
          'data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80dvh] data-[vaul-drawer-direction=top]:rounded-b-lg data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=top]:border-border',
          'data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80dvh] data-[vaul-drawer-direction=bottom]:rounded-t-lg data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=bottom]:border-border',
          'data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0',
          width !== 'full' && 'data-[vaul-drawer-direction=right]:w-3/4',
          'data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=right]:border-border',
          width !== 'full' && 'data-[vaul-drawer-direction=right]:sm:max-w-sm',
          'data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0',
          width !== 'full' && 'data-[vaul-drawer-direction=left]:w-[var(--lody-drawer-width)]',
          'data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=left]:border-border',
          width !== 'full' && 'data-[vaul-drawer-direction=left]:max-w-[var(--lody-drawer-width)]',
          className
        )}
        style={mergedStyle}
        {...props}
      >
        {/* Drag grabber for bottom sheets. Uses `muted-foreground/40` (not
           `bg-muted`, which equals `--background` in the dark theme and renders
           invisible) so the handle actually reads as draggable. */}
        <div
          className={cn(
            stylex.props(styles.grabber).className,
            'group-data-[vaul-drawer-direction=bottom]/drawer-content:block'
          )}
        />
        <ModalContainerProvider container={popupContainer}>
          <PopupContainerProvider container={popupContainer}>{children}</PopupContainerProvider>
        </ModalContainerProvider>
        {/* Body portals inherit Vaul's pointer lock and leave its focus scope.
            Keep floating controls inside the modal, outside scrolling content;
            a boxless host adds no flex item, and menu gestures never drag Vaul. */}
        <div
          ref={setPopupContainer}
          className={stylex.props(styles.popupHost).className}
          data-vaul-no-drag=""
        />
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        stylex.props(styles.header).className,
        'group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-1.5 md:text-left',
        className
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(stylex.props(styles.footer).className, className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(stylex.props(styles.title).className, className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn(stylex.props(styles.description).className, className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
