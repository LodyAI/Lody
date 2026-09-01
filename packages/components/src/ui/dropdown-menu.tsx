import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle, Search } from 'lucide-react';

import { handleMenuCloseAutoFocus } from '@/lib/menu-focus';
import { cn } from '@/lib/utils';
import { useSafeAreaInsets } from '@/hooks/use-safe-area-insets';
import {
  menuGroupLabelClassName,
  menuItemClassName,
  menuItemDestructiveClassName,
  menuItemExtraClassName,
  menuItemIconClassName,
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
    icon?: React.ReactNode;
  }
>(({ className, inset, icon, children, onPointerEnter, disabled, ...props }, ref) => {
  const setSubmenuOpen = React.useContext(DropdownMenuSubOpenContext);

  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(menuItemClassName, inset && 'ps-8', className)}
      disabled={disabled}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented && event.pointerType === 'mouse' && !disabled) {
          setSubmenuOpen?.(true);
        }
      }}
      {...props}
    >
      {icon ? <span className={menuItemIconClassName}>{icon}</span> : null}
      {children}
      <span className={cn(menuItemIconClassName, 'ms-2 me-0 size-4 [&>svg]:size-3')}>
        <ChevronRight />
      </span>
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
      'scroll-pro scrollbar-pro [scrollbar-gutter:auto] z-[var(--z-popover)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overflow-x-hidden',
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
          'scroll-pro scrollbar-pro [scrollbar-gutter:auto] z-[var(--z-popover)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overflow-x-hidden',
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
    icon?: React.ReactNode;
    variant?: 'default' | 'destructive';
  }
>(({ className, inset, icon, variant = 'default', children, onSelect, ...props }, ref) => {
  const selectionContext = React.useContext(DropdownMenuSelectionContext);
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      data-variant={variant}
      className={cn(menuItemClassName, menuItemDestructiveClassName, inset && 'ps-8', className)}
      onSelect={(event) => {
        // Mark even when the consumer preventDefaults to keep the menu open
        // (run-config multi-pick). That interaction still means "user chose
        // something" — closing later must not restore the trigger, or Enter
        // re-opens the model/agent menu instead of submitting the composer.
        selectionContext?.markItemSelected();
        onSelect?.(event);
      }}
      {...props}
    >
      {/* Pass `children` through untouched when there is no icon: a consumer
          using `asChild` renders through a Slot, which takes exactly one child. */}
      {icon ? (
        <>
          <span className={menuItemIconClassName}>{icon}</span>
          {children}
        </>
      ) : (
        children
      )}
    </DropdownMenuPrimitive.Item>
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
      <span className="absolute start-3 flex h-3.5 w-3.5 items-center justify-center">
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
      <span className="absolute start-3 flex h-3.5 w-3.5 items-center justify-center">
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
    className={cn(menuGroupLabelClassName, inset && 'ps-8', className)}
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

/* Every focusable row of a menu, in DOM order — where an arrow key from the
   search field should land. Radix marks disabled items, which cannot take focus. */
const MENU_ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
]
  .map((role) => `${role}:not([data-disabled])`)
  .join(',');

const MENU_CONTENT_SELECTOR = '[data-radix-menu-content]';

type DropdownMenuSearchInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Defaults to `placeholder`; give one when the field has no visible label. */
  ariaLabel?: string;
  /** Enter with focus still in the field — typically "take the top match". */
  onSubmit?: () => void;
  className?: string;
};

/**
 * Search field for a menu whose list is too long to read at a glance.
 *
 * A Radix menu owns every keystroke inside its content: printable keys drive
 * typeahead (which jumps focus to a matching row) and the arrows drive roving
 * focus between items. A plain `<input>` mounted in menu content is therefore
 * unusable. This keeps typing in the field and hands only the navigation keys
 * back to the menu, moving focus onto the first/last row itself because the
 * input is not part of the roving group — and it claims back the keystrokes
 * that land on a row once the POINTER has moved focus there, so the whole
 * primitive works wherever it is dropped rather than only inside a list that
 * remembers to re-route them.
 *
 * Focus is claimed a frame after mount: Radix focuses the content element on
 * open (keyboard) and never focuses a non-item child, so an `autoFocus` would
 * simply be overwritten. Only with a precise pointer — on touch, grabbing focus
 * would raise the soft keyboard over the menu the user just opened.
 */
const DropdownMenuSearchInput = React.forwardRef<HTMLInputElement, DropdownMenuSearchInputProps>(
  ({ value, onValueChange, placeholder, ariaLabel, onSubmit, className }, forwardedRef) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    /* Read by the menu-level listener below, which binds once: rebinding it per
       keystroke would drop the key that caused the re-render. */
    const latest = React.useRef({ value, onValueChange });
    latest.current = { value, onValueChange };

    React.useEffect(() => {
      if (typeof window === 'undefined') return undefined;
      if (!window.matchMedia?.('(pointer: fine)').matches) return undefined;
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }, []);

    React.useEffect(() => {
      const content = inputRef.current?.closest<HTMLElement>(MENU_CONTENT_SELECTOR);
      if (!content) return undefined;
      /* Native listener on the menu content, not a React handler: it runs while
         the event is still bubbling to the portal container React listens on,
         so stopping it here is what keeps the menu's typeahead from seeing the
         key at all. */
      const claimTyping = (event: KeyboardEvent) => {
        if (event.target === inputRef.current) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const { value: current, onValueChange: change } = latest.current;
        if (event.key.length === 1) change(current + event.key);
        else if (event.key === 'Backspace') change(current.slice(0, -1));
        else return;
        event.preventDefault();
        event.stopPropagation();
        inputRef.current?.focus();
      };
      content.addEventListener('keydown', claimTyping);
      return () => content.removeEventListener('keydown', claimTyping);
    }, []);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = Array.from(
          event.currentTarget
            .closest(MENU_CONTENT_SELECTOR)
            ?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []
        );
        const target = event.key === 'ArrowDown' ? items[0] : items[items.length - 1];
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        target.focus();
        return;
      }
      // Escape closes the menu and Tab is Radix's to block; everything else —
      // including ←/→/Home/End, which would otherwise close the submenu or jump
      // rows — is text editing and stays in the field.
      if (event.key === 'Escape' || event.key === 'Tab') return;
      if (event.key === 'Enter' && onSubmit) {
        event.preventDefault();
        onSubmit();
      }
      event.stopPropagation();
    };

    return (
      <div
        className={cn('flex items-center gap-2 px-2.5 py-1.5', className)}
        onClick={(event) => {
          event.stopPropagation();
          inputRef.current?.focus();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          ref={(node) => {
            inputRef.current = node;
            if (typeof forwardedRef === 'function') forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          type="text"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder}
          className="min-w-0 flex-1 border-none bg-transparent text-[0.8rem] leading-tight outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0"
        />
      </div>
    );
  }
);
DropdownMenuSearchInput.displayName = 'DropdownMenuSearchInput';

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn(menuItemExtraClassName, className)} {...props} />;
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
  DropdownMenuSearchInput,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
