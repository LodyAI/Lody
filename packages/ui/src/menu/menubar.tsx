import { Menubar as BaseMenubar } from '@base-ui/react/menubar';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { surface } from '../popup/surface';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenuTrigger,
} from './menu';

type RootBaseProps = ComponentProps<typeof BaseMenubar>;
type TriggerBaseProps = ComponentProps<typeof Menu.Trigger>;

export interface MenubarRootProps extends Omit<RootBaseProps, 'className'> {
  className?: string;
}

export interface MenubarTriggerProps extends Omit<TriggerBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

/**
 * The bar itself: a row of triggers and nothing more.
 *
 * It states no background and no edge, because a menubar is not a surface — it
 * sits on whatever rung the shell put it on, most often the region rung of a
 * title bar, and giving it a fill of its own would put a second surface inside
 * the one that already holds it.
 */
export const MenubarRoot = forwardRef<HTMLDivElement, MenubarRootProps>(function MenubarRoot(
  { className, ...rest },
  ref
) {
  return (
    <BaseMenubar
      ref={ref}
      {...rest}
      className={appendClassName(stylex.props(surface.bar).className, className)}
    />
  );
});

/**
 * A name on the bar that opens a menu.
 *
 * It is a menu row laid along the bar rather than down a list: the same height,
 * radius, type and highlight a row takes, so a bar and the menus it opens
 * cannot drift into two vocabularies. While its menu is up it keeps the
 * highlight, which is what says which name the open menu belongs to.
 */
export const MenubarTrigger = forwardRef<HTMLButtonElement, MenubarTriggerProps>(
  function MenubarTrigger({ className, ...rest }, ref) {
    return (
      <Menu.Trigger
        ref={ref}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(surface.barItem, state.open && surface.barItemOpen).className,
            className
          )
        }
      />
    );
  }
);

/**
 * A bar of menus, the way a desktop window titles them.
 *
 * `Menubar.Menu` is `Menu.Root` and `Menubar.Content` is `Menu.Content`: Base UI
 * reads the bar from the tree and gives a menu inside one the side and the
 * keyboard handoff a bar needs — Left and Right walk between the menus while
 * one is open. Only the bar and its trigger are new here; every row is `Menu`'s.
 */
export const Menubar = {
  Root: MenubarRoot,
  Menu: Menu.Root,
  Trigger: MenubarTrigger,
  Content: MenuContent,
  Item: MenuItem,
  LinkItem: MenuLinkItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  Group: MenuGroup,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  Submenu: Menu.Submenu,
  SubmenuTrigger: MenuSubmenuTrigger,
};
