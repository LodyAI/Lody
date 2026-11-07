import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import * as stylex from '@stylexjs/stylex';
import { ModalContainerProvider, PopupContainerProvider } from '@lody/ui/popup-container';

import { clsx } from 'clsx';
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
  top: {
    insetInline: 0,
    top: 0,
    marginBottom: 'calc(var(--spacing) * 24)',
    maxHeight: '80dvh',
    borderBottomLeftRadius: 'var(--radius-lg)',
    borderBottomRightRadius: 'var(--radius-lg)',
    borderBottomWidth: 1,
    borderColor: 'hsl(var(--border) / 1)',
  },
  bottom: {
    insetInline: 0,
    bottom: 0,
    marginTop: 'calc(var(--spacing) * 24)',
    maxHeight: '80dvh',
    borderTopLeftRadius: 'var(--radius-lg)',
    borderTopRightRadius: 'var(--radius-lg)',
    borderTopWidth: 1,
    borderColor: 'hsl(var(--border) / 1)',
  },
  right: { insetBlock: 0, right: 0, borderLeftWidth: 1, borderColor: 'hsl(var(--border) / 1)' },
  rightWidth: {
    width: '75%',
    maxWidth: { default: null, '@media (width >= 40rem)': 'var(--container-sm)' },
  },
  left: { insetBlock: 0, left: 0, borderRightWidth: 1, borderColor: 'hsl(var(--border) / 1)' },
  leftWidth: { width: 'var(--lody-drawer-width)', maxWidth: 'var(--lody-drawer-width)' },
  fullWidth: { width: '100%', maxWidth: 'none' },
  safeAreaBottom: { paddingBottom: 'max(1.25rem,var(--safe-area-bottom,0px))' },
  grabber: {
    backgroundColor: `color-mix(in oklab, ${themeColors.mutedForeground} 40%, transparent)`,
    marginInline: 'auto',
    marginTop: themeSpace[3],
    display: { default: 'none', ':is([data-vaul-drawer-direction="bottom"] *)': 'block' },
    height: themeSpace[1.5],
    width: themeSpace[10],
    flexShrink: 0,
    borderRadius: 'calc(infinity * 1px)',
  },
  popupHost: { display: 'contents' },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: {
      default: 'calc(var(--spacing) * .5)',
      '@media (width >= 48rem)': 'calc(var(--spacing) * 1.5)',
    },
    textAlign: {
      default: null,
      ':is([data-vaul-drawer-direction="bottom"] *, [data-vaul-drawer-direction="top"] *)':
        'center',
      '@media (width >= 48rem)': {
        default: null,
        ':not(:is([data-vaul-drawer-direction="bottom"] *, [data-vaul-drawer-direction="top"] *))':
          'left',
      },
    },
    padding: themeSpace[4],
  },
  footer: {
    marginTop: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    padding: themeSpace[4],
  },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  title: { color: themeColors.foreground, fontWeight: themeFontWeight.semibold },
  description: {
    color: themeColors.mutedForeground,
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
});

const DrawerViewportContext = React.createContext(false);
const DrawerDirectionContext = React.createContext<'top' | 'bottom' | 'left' | 'right'>('bottom');

function Drawer({ repositionInputs, ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  // Vaul caches a focused drawer's initial height, which becomes stale after
  // a fold/rotation or a keyboard-resized WebView. Keep side drawers CSS-sized.
  // iOS surfaces already consume the native keyboard offset; other hosts need
  // the currently occluded visual-viewport edge instead.
  const manageSideDrawer =
    (props.direction === 'right' || props.direction === 'left') &&
    !props.snapPoints &&
    repositionInputs !== false &&
    (isNativeAppShell() || repositionInputs === true);
  const followViewport = manageSideDrawer && !isNativeIOSAppShell();

  return (
    <DrawerDirectionContext.Provider value={props.direction ?? 'bottom'}>
      <DrawerViewportContext.Provider value={followViewport}>
        <DrawerPrimitive.Root
          data-slot="drawer"
          {...props}
          repositionInputs={manageSideDrawer ? false : repositionInputs}
        />
      </DrawerViewportContext.Provider>
    </DrawerDirectionContext.Provider>
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
    className={clsx(stylex.props(styles.overlay).className, className)}
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
  /** Suppress entry during the composer handoff, retaining drag and exit transitions. */
  skipOpenAnimation?: boolean;
  /** Native side-panel content whose children do not already own keyboard lift. */
  nativeKeyboardInset?: boolean;
  xstyle?: stylex.StyleXStyles;
  /** Bottom clearance reads the safe-area variable on the content element. */
  bottomPadding?: 'safeArea';
};

function DrawerContent({
  width,
  xstyle,
  bottomPadding,
  skipOpenAnimation = false,
  nativeKeyboardInset = false,
  className,
  children,
  style,
  ...props
}: DrawerContentProps) {
  const viewportBottom = useDrawerViewportBottom();
  const direction = React.useContext(DrawerDirectionContext);
  const [popupContainer, setPopupContainer] = React.useState<HTMLDivElement | null>(null);
  const sx = stylex.props(
    styles.content,
    styles[direction],
    width !== 'full' && direction === 'left' && styles.leftWidth,
    width !== 'full' && direction === 'right' && styles.rightWidth,
    width === 'full' && styles.fullWidth,
    bottomPadding === 'safeArea' && styles.safeAreaBottom,
    xstyle
  );
  const mergedStyle = {
    '--lody-drawer-width': '256px',
    ...sx.style,
    ...style,
    ...(skipOpenAnimation ? { animationName: 'none' } : {}),
    ...(nativeKeyboardInset && isNativeIOSAppShell()
      ? { bottom: 'var(--native-keyboard-height, 0px)' }
      : {}),
    ...(viewportBottom === undefined ? {} : { bottom: viewportBottom }),
  } as React.CSSProperties;

  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay style={skipOpenAnimation ? { animationName: 'none' } : undefined} />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={clsx(sx.className, className)}
        style={mergedStyle}
        {...props}
      >
        {/* Drag grabber for bottom sheets. Uses `muted-foreground/40` (not
           `bg-muted`, which equals `--background` in the dark theme and renders
           invisible) so the handle actually reads as draggable. */}
        <div className={stylex.props(styles.grabber).className} />
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

function DrawerHeader({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<'div'> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.header, xstyle);
  return (
    <div
      data-slot="drawer-header"
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
}

function DrawerFooter({
  className,
  xstyle,
  style,
  ...props
}: React.ComponentProps<'div'> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.footer, xstyle);
  return (
    <div
      data-slot="drawer-footer"
      className={clsx(sx.className, className)}
      style={sx.style ? { ...sx.style, ...style } : style}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  xstyle,
  style,
  visuallyHidden = false,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title> & {
  visuallyHidden?: boolean;
  xstyle?: stylex.StyleXStyles;
}) {
  const sx = stylex.props(styles.title, xstyle, visuallyHidden && styles.srOnly);
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={clsx(sx.className, className)}
      {...props}
      style={sx.style ? { ...sx.style, ...style } : style}
    />
  );
}

function DrawerDescription({
  className,
  xstyle,
  visuallyHidden = false,
  fontSize,
  style,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description> & {
  visuallyHidden?: boolean;
  xstyle?: stylex.StyleXStyles;
  /** Explicit description size; caller styles and slotted-child styles retain priority. */
  fontSize?: React.CSSProperties['fontSize'];
}) {
  const sx = stylex.props(styles.description, xstyle, visuallyHidden && styles.srOnly);
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={clsx(sx.className, className)}
      {...props}
      style={
        sx.style || fontSize != null
          ? { ...sx.style, ...(fontSize != null ? { fontSize } : {}), ...style }
          : style
      }
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
