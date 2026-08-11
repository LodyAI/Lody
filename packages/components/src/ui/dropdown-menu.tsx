import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';

import { handleMenuCloseAutoFocus } from '@/lib/menu-focus';
import { cn } from '@/lib/utils';
import { useSafeAreaInsets } from '@/hooks/use-safe-area-insets';
import {
  menuItemClassName,
  menuSelectionItemClassName,
  menuSeparatorClassName,
  menuSeparatorStyle,
  menuSurfaceClassName,
  menuSurfaceStyle,
} from './menu-styles';

type DropdownMenuSubmenuLevel = {
  activeSubmenuId: symbol | null;
  setActiveSubmenuId: React.Dispatch<React.SetStateAction<symbol | null>>;
};

const DropdownMenuSubmenuLevelContext = React.createContext<DropdownMenuSubmenuLevel | null>(null);

type DropdownMenuSelectionContextValue = {
  didSelectItemRef: React.MutableRefObject<boolean>;
  markItemSelected: () => void;
};

const DropdownMenuSelectionContext = React.createContext<DropdownMenuSelectionContextValue | null>(
  null
);

const DropdownMenu = ({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) => {
  const [activeSubmenuId, setActiveSubmenuId] = React.useState<symbol | null>(null);
  const didSelectItemRef = React.useRef(false);
  const submenuLevel = React.useMemo(
    () => ({ activeSubmenuId, setActiveSubmenuId }),
    [activeSubmenuId]
  );
  const selectionContext = React.useMemo(
    () => ({
      didSelectItemRef,
      markItemSelected: () => {
        didSelectItemRef.current = true;
      },
    }),
    []
  );

  return (
    <DropdownMenuSelectionContext.Provider value={selectionContext}>
      <DropdownMenuSubmenuLevelContext.Provider value={submenuLevel}>
        <DropdownMenuPrimitive.Root
          {...props}
          onOpenChange={(open) => {
            if (open) {
              didSelectItemRef.current = false;
            } else {
              setActiveSubmenuId(null);
            }
            onOpenChange?.(open);
          }}
        />
      </DropdownMenuSubmenuLevelContext.Provider>
    </DropdownMenuSelectionContext.Provider>
  );
};
DropdownMenu.displayName = DropdownMenuPrimitive.Root.displayName;

/**
 * Touch-friendly DropdownMenuTrigger.
 *
 * Radix toggles the dropdown exclusively from its internal `onPointerDown`
 * handler — there is no `onClick` fallback.  On touch devices `pointerdown`
 * fires the instant the finger contacts the screen, before the browser can
 * distinguish a tap from a scroll, so a scroll that begins over the trigger
 * accidentally opens the menu.
 *
 * Fix: for touch interactions we block Radix's `pointerdown` (via
 * `preventDefault`, which Radix's `composeEventHandlers` respects) and then,
 * on the subsequent `click` event — which the browser only fires for genuine
 * taps, never for scrolls — we re-dispatch a *mouse-type* `pointerdown` so
 * that Radix can toggle normally.
 *
 * Mouse / pen interactions are completely unaffected.
 */
const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ onPointerDown, onClick, ...props }, ref) => {
  const wasTouchRef = React.useRef(false);
  const isSyntheticRef = React.useRef(false);

  return (
    <DropdownMenuPrimitive.Trigger
      ref={ref}
      onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) => {
        // Let our synthetic re-dispatch pass straight through to Radix.
        if (isSyntheticRef.current) {
          isSyntheticRef.current = false;
          // Stop the synthetic pointerdown from bubbling to ancestor handlers.
          // It carries no active pointer (pointerId 0), so ancestors that grab
          // the pointer — e.g. vaul's Drawer.Content `onPress`, which calls
          // `setPointerCapture(event.pointerId)` — crash with a NotFoundError
          // when a trigger inside a drawer is tapped. Radix's own toggle runs
          // on this same element and is unaffected.
          e.stopPropagation();
          return;
        }

        onPointerDown?.(e);

        if (!e.defaultPrevented && e.pointerType === 'touch') {
          wasTouchRef.current = true;
          e.preventDefault(); // Blocks Radix via composeEventHandlers
          return;
        }
        wasTouchRef.current = false;
      }}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        if (wasTouchRef.current) {
          wasTouchRef.current = false;
          isSyntheticRef.current = true;
          // Tap confirmed — re-dispatch as mouse pointerdown for Radix to toggle.
          e.currentTarget.dispatchEvent(
            new PointerEvent('pointerdown', {
              button: 0,
              pointerType: 'mouse',
              bubbles: true,
              cancelable: true,
            })
          );
        }
        onClick?.(e);
      }}
      {...props}
    />
  );
});
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

type DropdownMenuSubProps = React.ComponentProps<typeof DropdownMenuPrimitive.Sub>;

const DropdownMenuSubOpenContext = React.createContext<((open: boolean) => void) | null>(null);

/**
 * Radix hard-codes a 100ms mouse-hover delay for submenus. Keep its keyboard,
 * click, focus, and pointer-grace behavior, but expose the open state to our
 * SubTrigger so mouse hover can open the submenu in the same frame.
 */
const DropdownMenuSub = ({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: DropdownMenuSubProps) => {
  const parentLevel = React.useContext(DropdownMenuSubmenuLevelContext);
  const setParentActiveSubmenuId = parentLevel?.setActiveSubmenuId;
  const submenuIdRef = React.useRef(Symbol('dropdown-submenu'));
  const submenuId = submenuIdRef.current;
  const open = parentLevel?.activeSubmenuId === submenuId;
  const [childActiveSubmenuId, setChildActiveSubmenuId] = React.useState<symbol | null>(null);
  const childLevel = React.useMemo(
    () => ({
      activeSubmenuId: childActiveSubmenuId,
      setActiveSubmenuId: setChildActiveSubmenuId,
    }),
    [childActiveSubmenuId]
  );
  const previousOpenRef = React.useRef(open);
  const didApplyDefaultOpenRef = React.useRef(false);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setParentActiveSubmenuId?.((activeId) =>
        nextOpen ? submenuId : activeId === submenuId ? null : activeId
      );
    },
    [setParentActiveSubmenuId, submenuId]
  );

  React.useEffect(() => {
    if (controlledOpen === true) {
      setParentActiveSubmenuId?.(submenuId);
    } else if (controlledOpen === false) {
      setParentActiveSubmenuId?.((activeId) => (activeId === submenuId ? null : activeId));
    }
  }, [controlledOpen, setParentActiveSubmenuId, submenuId]);

  React.useEffect(() => {
    if (didApplyDefaultOpenRef.current) return;
    didApplyDefaultOpenRef.current = true;
    if (controlledOpen === undefined && defaultOpen) {
      setParentActiveSubmenuId?.(submenuId);
    }
  }, [controlledOpen, defaultOpen, setParentActiveSubmenuId, submenuId]);

  React.useEffect(() => {
    if (previousOpenRef.current === open) return;
    previousOpenRef.current = open;
    onOpenChange?.(open);
    if (!open) {
      setChildActiveSubmenuId(null);
    }
  }, [onOpenChange, open]);

  React.useEffect(
    () => () => {
      setParentActiveSubmenuId?.((activeId) => (activeId === submenuId ? null : activeId));
    },
    [setParentActiveSubmenuId, submenuId]
  );

  return (
    <DropdownMenuSubOpenContext.Provider value={handleOpenChange}>
      <DropdownMenuSubmenuLevelContext.Provider value={childLevel}>
        <DropdownMenuPrimitive.Sub {...props} open={open} onOpenChange={handleOpenChange} />
      </DropdownMenuSubmenuLevelContext.Provider>
    </DropdownMenuSubOpenContext.Provider>
  );
};
DropdownMenuSub.displayName = DropdownMenuPrimitive.Sub.displayName;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  }
>(({ className, inset, children, onPointerEnter, disabled, ...props }, ref) => {
  const setSubmenuOpen = React.useContext(DropdownMenuSubOpenContext);

  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(menuItemClassName, 'data-[state=open]:bg-hover', inset && 'pl-8', className)}
      disabled={disabled}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented && event.pointerType === 'mouse' && !disabled) {
          setSubmenuOpen?.(true);
        }
      }}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, sideOffset = 6, style, ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    sideOffset={sideOffset}
    style={{ ...menuSurfaceStyle, ...style }}
    className={cn(
      'scroll-pro scrollbar-pro [scrollbar-gutter:auto] z-[var(--z-popover)] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] overflow-y-auto overflow-x-hidden',
      menuSurfaceClassName,
      className
    )}
    {...props}
  />
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 8, collisionPadding, style, onCloseAutoFocus, ...props }, ref) => {
  const safeArea = useSafeAreaInsets();
  const selectionContext = React.useContext(DropdownMenuSelectionContext);
  const baseCollisionPadding = { top: 8, right: 8, bottom: 8, left: 8 };
  const safeAreaPadding = {
    top: baseCollisionPadding.top + safeArea.top,
    right: baseCollisionPadding.right + safeArea.right,
    bottom: baseCollisionPadding.bottom + safeArea.bottom,
    left: baseCollisionPadding.left + safeArea.left,
  };
  const mergedCollisionPadding =
    typeof collisionPadding === 'number'
      ? {
          top: Math.max(safeAreaPadding.top, collisionPadding),
          right: Math.max(safeAreaPadding.right, collisionPadding),
          bottom: Math.max(safeAreaPadding.bottom, collisionPadding),
          left: Math.max(safeAreaPadding.left, collisionPadding),
        }
      : collisionPadding
        ? {
            top: Math.max(safeAreaPadding.top, collisionPadding.top ?? 0),
            right: Math.max(safeAreaPadding.right, collisionPadding.right ?? 0),
            bottom: Math.max(safeAreaPadding.bottom, collisionPadding.bottom ?? 0),
            left: Math.max(safeAreaPadding.left, collisionPadding.left ?? 0),
          }
        : safeAreaPadding;
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={mergedCollisionPadding}
        style={{ ...menuSurfaceStyle, ...style }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const didSelectItem = selectionContext?.didSelectItemRef.current === true;
          if (selectionContext) {
            selectionContext.didSelectItemRef.current = false;
          }
          handleMenuCloseAutoFocus(event, {
            didSelectItem,
            menuContent: event.currentTarget,
          });
        }}
        className={cn(
          'scroll-pro scrollbar-pro [scrollbar-gutter:auto] z-[var(--z-popover)] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[8rem] overflow-y-auto overflow-x-hidden',
          menuSurfaceClassName,
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
  }
>(({ className, inset, onSelect, ...props }, ref) => {
  const selectionContext = React.useContext(DropdownMenuSelectionContext);
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(menuItemClassName, inset && 'pl-8', className)}
      onSelect={(event) => {
        // Mark even when the consumer preventDefaults to keep the menu open
        // (run-config multi-pick). That interaction still means "user chose
        // something" — closing later must not restore the trigger, or Enter
        // re-opens the model/agent menu instead of submitting the composer.
        selectionContext?.markItemSelected();
        onSelect?.(event);
      }}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, onSelect, ...props }, ref) => {
  const selectionContext = React.useContext(DropdownMenuSelectionContext);
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(menuSelectionItemClassName, className)}
      checked={checked}
      onSelect={(event) => {
        selectionContext?.markItemSelected();
        onSelect?.(event);
      }}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, onSelect, ...props }, ref) => {
  const selectionContext = React.useContext(DropdownMenuSelectionContext);
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn(menuSelectionItemClassName, className)}
      onSelect={(event) => {
        selectionContext?.markItemSelected();
        onSelect?.(event);
      }}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="h-2 w-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
});
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      'select-none px-2.5 py-1.5 text-[0.8rem] font-semibold',
      inset && 'pl-8',
      className
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, style, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    // Share the outer border's edge color so inner dividers read as the same line.
    className={cn(menuSeparatorClassName, className)}
    style={{ ...menuSeparatorStyle, ...style }}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span className={cn('ml-auto text-xs tracking-widest opacity-60', className)} {...props} />
  );
};
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
