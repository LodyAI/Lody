import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { Menu as UiMenu } from '@lody/ui/menu';
import { Search } from 'lucide-react';

import { restoreComposerFocusAfterMenu } from '@/lib/menu-focus';
import { withClassName } from '@/lib/stylex';
import { useSafeAreaCollisionPadding } from '@/hooks/use-safe-area-insets';
import { menuStyles } from './menu-styles';

type MenuRootProps = React.ComponentProps<typeof UiMenu.Root>;
type MenuContentProps = React.ComponentProps<typeof UiMenu.Content>;
type MenuItemProps = React.ComponentProps<typeof UiMenu.Item>;
type MenuLinkItemProps = React.ComponentProps<typeof UiMenu.LinkItem>;
type MenuCheckboxItemProps = React.ComponentProps<typeof UiMenu.CheckboxItem>;
type MenuRadioItemProps = React.ComponentProps<typeof UiMenu.RadioItem>;
type MenuSubmenuProps = React.ComponentProps<typeof UiMenu.Submenu>;
type MenuSubmenuTriggerProps = React.ComponentProps<typeof UiMenu.SubmenuTrigger>;

type MenuSelectionContextValue = {
  didSelectItemRef: React.MutableRefObject<boolean>;
};

const MenuSelectionContext = React.createContext<MenuSelectionContextValue | null>(null);

function useMarkMenuItemSelected() {
  const selection = React.useContext(MenuSelectionContext);
  return React.useCallback(() => {
    if (selection) selection.didSelectItemRef.current = true;
  }, [selection]);
}

/**
 * Product layer over `@lody/ui`'s `Menu`: the parts are the package's, while
 * the post-close focus policy (the composer's), the same-frame submenu open and
 * the in-menu search field are ours.
 *
 * Selection is tracked here rather than per item: a closing `item-press` reason
 * marks it, and a `closeOnClick={false}` row marks itself on activation, which
 * is what the old mark-on-select wrapper did.
 */
function MenuRoot({ onOpenChange, children, ...props }: MenuRootProps) {
  const didSelectItemRef = React.useRef(false);
  const selection = React.useMemo(() => ({ didSelectItemRef }), []);
  return (
    <MenuSelectionContext.Provider value={selection}>
      <UiMenu.Root
        {...props}
        onOpenChange={(open, eventDetails) => {
          if (open) {
            didSelectItemRef.current = false;
          } else if (eventDetails?.reason === 'item-press') {
            didSelectItemRef.current = true;
          }
          onOpenChange?.(open, eventDetails);
        }}
      >
        {children}
      </UiMenu.Root>
    </MenuSelectionContext.Provider>
  );
}

const MenuContent = React.forwardRef<HTMLDivElement, MenuContentProps>(function MenuContent(
  { finalFocus, collisionPadding, ...props },
  ref
) {
  const selection = React.useContext(MenuSelectionContext);
  const mergedCollisionPadding = useSafeAreaCollisionPadding(collisionPadding);
  const handleFinalFocus = React.useCallback(
    (closeType: Parameters<Extract<MenuContentProps['finalFocus'], Function>>[0]) => {
      const provided =
        typeof finalFocus === 'function'
          ? finalFocus(closeType)
          : finalFocus && typeof finalFocus === 'object' && 'current' in finalFocus
            ? finalFocus.current
            : finalFocus;
      if (provided === false) return false;
      if (selection?.didSelectItemRef.current) {
        selection.didSelectItemRef.current = false;
        restoreComposerFocusAfterMenu();
        return false;
      }
      /* Outside-press onto another control (including the prompt): the
           browser already moved focus there; leave it instead of pulling it
           back to the trigger. Focus still inside a menu means a keyboard
           close, where the default trigger restore is correct. */
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.closest('[role="menu"]') === null
      ) {
        return false;
      }
      return provided;
    },
    [finalFocus, selection]
  );
  return (
    <UiMenu.Content
      ref={ref}
      collisionPadding={mergedCollisionPadding}
      finalFocus={handleFinalFocus}
      {...props}
    />
  );
});

const MenuItem = React.forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  { onClick, closeOnClick, ...props },
  ref
) {
  const markSelected = useMarkMenuItemSelected();
  return (
    <UiMenu.Item
      ref={ref}
      closeOnClick={closeOnClick}
      {...props}
      onClick={(event) => {
        // A row that keeps the menu open never produces an `item-press` close
        // reason, so it marks the selection itself.
        if (closeOnClick === false) markSelected();
        onClick?.(event);
      }}
    />
  );
});

const MenuLinkItem = React.forwardRef<HTMLAnchorElement, MenuLinkItemProps>(function MenuLinkItem(
  { onClick, ...props },
  ref
) {
  const markSelected = useMarkMenuItemSelected();
  return (
    <UiMenu.LinkItem
      ref={ref}
      {...props}
      onClick={(event) => {
        markSelected();
        onClick?.(event);
      }}
    />
  );
});

const MenuCheckboxItem = React.forwardRef<HTMLDivElement, MenuCheckboxItemProps>(
  function MenuCheckboxItem({ onCheckedChange, closeOnClick, ...props }, ref) {
    const markSelected = useMarkMenuItemSelected();
    return (
      <UiMenu.CheckboxItem
        ref={ref}
        closeOnClick={closeOnClick}
        {...props}
        onCheckedChange={(checked, eventDetails) => {
          if (closeOnClick === false) markSelected();
          onCheckedChange?.(checked, eventDetails);
        }}
      />
    );
  }
);

/* Picking one value answers the question the menu asked, so a radio row closes
 * it — the way a native checkmark menu dismisses on selection. Base UI keeps
 * checkable rows open (`closeOnClick` defaults false); a caller that wants
 * the picker's menu to stay up states `closeOnClick={false}` itself. */
const MenuRadioItem = React.forwardRef<HTMLDivElement, MenuRadioItemProps>(function MenuRadioItem(
  { onClick, closeOnClick = true, ...props },
  ref
) {
  const markSelected = useMarkMenuItemSelected();
  return (
    <UiMenu.RadioItem
      ref={ref}
      closeOnClick={closeOnClick}
      {...props}
      onClick={(event) => {
        if (closeOnClick === false) markSelected();
        onClick?.(event);
      }}
    />
  );
});

/**
 * Base UI's GroupLabel throws outside a `Menu.Group`, and these menus use a
 * label as a loose section header. A presentation div states the same thing.
 */
const MenuGroupLabel = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  function MenuGroupLabel({ className, style, ...props }, ref) {
    const sx = withClassName(stylex.props(menuStyles.groupLabel), className);
    return <div ref={ref} {...props} className={sx.className} style={{ ...sx.style, ...style }} />;
  }
);

/** Same-frame hover open for submenus; Base UI's trigger `delay` defaults to 100ms. */
function MenuSubmenu(props: MenuSubmenuProps) {
  return <UiMenu.Submenu {...props} />;
}

/* Every focusable row of a menu, in DOM order — where an arrow key from the
   search field should land. */
const MENU_ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
]
  .map((role) => `${role}:not([data-disabled])`)
  .join(',');

const MENU_CONTENT_SELECTOR = '[role="menu"]';
const MENU_SEARCH_SELECTOR = '[data-lody-menu-search]';

const MenuSubmenuTrigger = React.forwardRef<HTMLDivElement, MenuSubmenuTriggerProps>(
  function MenuSubmenuTrigger({ onPointerMove, onClick, disabled, delay = 0, ...props }, ref) {
    const focusOpenSubmenuSearch = (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || disabled || !window.matchMedia?.('(pointer: fine)').matches)
        return;
      const trigger = event.currentTarget;
      if (trigger.getAttribute('aria-expanded') !== 'true') return;
      const content = trigger.ownerDocument.getElementById(
        trigger.getAttribute('aria-controls') ?? ''
      );
      const search = content?.querySelector<HTMLInputElement>(MENU_SEARCH_SELECTOR);
      if (!search || search.closest(MENU_CONTENT_SELECTOR) !== content) return;
      /* The trigger takes focus back on every mouse move, undoing the search
         field's mount autofocus as the pointer settles over this row. */
      event.preventDefault();
      search.focus({ preventScroll: true });
    };

    return (
      <UiMenu.SubmenuTrigger
        ref={ref}
        disabled={disabled}
        delay={delay}
        {...props}
        onPointerMove={(event) => {
          onPointerMove?.(event);
          if (event.pointerType === 'mouse') focusOpenSubmenuSearch(event);
        }}
        onClick={(event) => {
          onClick?.(event);
          focusOpenSubmenuSearch(event);
        }}
      />
    );
  }
);

type MenuSearchInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Defaults to `placeholder`; give one when the field has no visible label. */
  ariaLabel?: string;
  /** Enter with focus still in the field — typically "take the top match". */
  onSubmit?: () => void;
  /** Layout only (a width floor); the field is the recessed well. */
  className?: string;
};

/**
 * Search field for a menu whose list is too long to read at a glance. It is
 * typed into, so it is the recessed well every value holder takes.
 *
 * A menu owns every keystroke inside its content: printable keys drive
 * typeahead (which jumps focus to a matching row) and the arrows drive roving
 * focus between items. A plain `<input>` mounted in menu content is therefore
 * unusable. This keeps typing in the field and hands only the navigation keys
 * back to the menu, moving focus onto the first/last row itself because the
 * input is not part of the roving group — and it claims back the keystrokes
 * that land on a row once the POINTER has moved focus there, so the whole
 * primitive works wherever it is dropped rather than only inside a list that
 * remembers to re-route them.
 *
 * Focus is claimed a frame after mount: the menu focuses its own surface on
 * open, so an `autoFocus` would simply be overwritten. Only with a precise
 * pointer — on touch, grabbing focus would raise the soft keyboard over the
 * menu the user just opened.
 */
const MenuSearchInput = React.forwardRef<HTMLInputElement, MenuSearchInputProps>(
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
      // Escape closes the menu and Tab is the menu's to block; everything else —
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
        {...withClassName(stylex.props(menuStyles.searchShell), className)}
        onClick={(event) => {
          event.stopPropagation();
          inputRef.current?.focus();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <Search {...stylex.props(menuStyles.searchGlyph)} aria-hidden="true" />
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
          data-lody-menu-search=""
          aria-label={ariaLabel ?? placeholder}
          {...stylex.props(menuStyles.searchInput)}
        />
      </div>
    );
  }
);

export const Menu = {
  ...UiMenu,
  Root: MenuRoot,
  Content: MenuContent,
  Item: MenuItem,
  LinkItem: MenuLinkItem,
  CheckboxItem: MenuCheckboxItem,
  RadioItem: MenuRadioItem,
  GroupLabel: MenuGroupLabel,
  Submenu: MenuSubmenu,
  SubmenuTrigger: MenuSubmenuTrigger,
};

export { MenuSearchInput };
