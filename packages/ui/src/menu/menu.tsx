import { Menu as BaseMenu } from '@base-ui/react/menu';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { ChevronRightGlyph, DotGlyph, TickGlyph } from '../internal/glyphs';
import { usePopupContainer, type PopupContainer } from '../popup/portal-container';
import { hiddenSurfaceForSide, surface } from '../popup/surface';
import { useForcedThemeClassNames } from '../theme/theme';

/** The gap between a menu and whatever opened it; the rules' rise distance. */
const POPUP_GAP = 4;

/**
 * What a row is about. `neutral` is a command; `destructive` is one that
 * destroys something and says so, the way a Button's tone does.
 */
export type MenuItemTone = 'neutral' | 'destructive';

type PositionerBaseProps = ComponentProps<typeof BaseMenu.Positioner>;
type PopupBaseProps = ComponentProps<typeof BaseMenu.Popup>;
type TriggerBaseProps = ComponentProps<typeof BaseMenu.Trigger>;
type ItemBaseProps = ComponentProps<typeof BaseMenu.Item>;
type LinkItemBaseProps = ComponentProps<typeof BaseMenu.LinkItem>;
type CheckboxItemBaseProps = ComponentProps<typeof BaseMenu.CheckboxItem>;
type RadioItemBaseProps = ComponentProps<typeof BaseMenu.RadioItem>;
type RadioGroupBaseProps = ComponentProps<typeof BaseMenu.RadioGroup>;
type SubmenuTriggerBaseProps = ComponentProps<typeof BaseMenu.SubmenuTrigger>;
type GroupBaseProps = ComponentProps<typeof BaseMenu.Group>;
type GroupLabelBaseProps = ComponentProps<typeof BaseMenu.GroupLabel>;
type SeparatorBaseProps = ComponentProps<typeof BaseMenu.Separator>;

/** What every row in this family takes beyond the part's own props. */
interface MenuRowProps {
  children?: ReactNode;
  /**
   * A glyph in the fixed box at the start of the row. The box owns its size and
   * its colour; a glyph placed in it fills it, so an icon that carries its own
   * dimensions states them as 100% rather than arriving at its library default.
   */
  icon?: ReactNode;
  /** Trailing metadata: a keyboard shortcut, a count, a hint. */
  shortcut?: ReactNode;
  /** Anything else at the end of the row, after the shortcut. */
  endContent?: ReactNode;
  className?: string;
}

export interface MenuContentProps extends Omit<
  PositionerBaseProps,
  'className' | 'children' | 'render'
> {
  children?: ReactNode;
  /** Where the menu mounts. Defaults to the nearest `PopupContainerProvider`. */
  container?: PopupContainer;
  /** Where focus goes when the menu closes; Base UI's `Menu.Popup` prop. */
  finalFocus?: PopupBaseProps['finalFocus'];
  className?: string;
}

/**
 * What opens the menu. It is Base UI's trigger unchanged, because a menu is
 * opened by whatever the surface already had there: a caller passes the control
 * it wants through `render` — `render={<Button variant="ghost" icon />}` —
 * rather than being given a second button to keep in step with `Button`.
 */
export type MenuTriggerProps = TriggerBaseProps;

export interface MenuItemProps extends Omit<ItemBaseProps, 'className' | 'children'>, MenuRowProps {
  /** A command, or one that destroys something. */
  tone?: MenuItemTone;
  /**
   * Reserve the leading box on a row that has no icon, so its label lines up
   * with the labels of the rows around it that do.
   */
  inset?: boolean;
}

export interface MenuLinkItemProps
  extends Omit<LinkItemBaseProps, 'className' | 'children'>, MenuRowProps {
  tone?: MenuItemTone;
  inset?: boolean;
}

export interface MenuCheckboxItemProps
  extends Omit<CheckboxItemBaseProps, 'className' | 'children'>, Omit<MenuRowProps, 'icon'> {}

export interface MenuRadioItemProps
  extends Omit<RadioItemBaseProps, 'className' | 'children'>, Omit<MenuRowProps, 'icon'> {}

export interface MenuSubmenuTriggerProps
  extends Omit<SubmenuTriggerBaseProps, 'className' | 'children'>, MenuRowProps {
  inset?: boolean;
}

export interface MenuRadioGroupProps extends Omit<RadioGroupBaseProps, 'className'> {
  className?: string;
}
export interface MenuGroupProps extends Omit<GroupBaseProps, 'className'> {
  className?: string;
}
export interface MenuGroupLabelProps extends Omit<GroupLabelBaseProps, 'className'> {
  className?: string;
}
export interface MenuSeparatorProps extends Omit<SeparatorBaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  /** The positioner carries no appearance; the popup inside it does. */
  positioner: { outlineStyle: 'none' },
});

/**
 * The row every part in this family renders: the leading box, the label that
 * takes the remaining width, the trailing metadata, and whatever the caller
 * appended. It is written once here so a command, a checkbox row, a radio row
 * and a submenu trigger cannot line their contents up differently.
 */
function Row({
  leading,
  children,
  shortcut,
  endContent,
}: {
  leading?: ReactNode;
  children?: ReactNode;
  shortcut?: ReactNode;
  endContent?: ReactNode;
}) {
  return (
    <>
      {leading}
      <span {...stylex.props(surface.itemText)}>{children}</span>
      {shortcut == null ? null : <span {...stylex.props(surface.itemShortcut)}>{shortcut}</span>}
      {endContent}
    </>
  );
}

/** The caller's glyph, in the box the rules give it. */
function ItemIcon({ icon, tone }: { icon: ReactNode; tone?: MenuItemTone }) {
  return (
    <span
      {...stylex.props(
        surface.itemIcon,
        // A destructive row's icon is part of what the row says rather than a
        // hint beside it, so it takes the row's colour instead of its own.
        tone === 'destructive' && surface.itemIconInherit
      )}
    >
      {icon}
    </span>
  );
}

/** The reserved but empty leading box that lines an `inset` row up. */
function ItemSpacer() {
  return <span aria-hidden="true" {...stylex.props(surface.itemIcon)} />;
}

function leadingFor(icon: ReactNode, inset: boolean | undefined, tone?: MenuItemTone) {
  if (icon != null) return <ItemIcon icon={icon} tone={tone} />;
  return inset ? <ItemSpacer /> : null;
}

/**
 * A row's classes, from the state Base UI reports on it.
 *
 * `highlighted` is where the keyboard or the pointer is; a submenu trigger also
 * reports `open` and keeps the fill while the submenu it opened is up, so the
 * row the pointer left does not go dark as it crosses into that submenu.
 */
function rowClassName(
  state: { disabled?: boolean; highlighted?: boolean; checked?: boolean; open?: boolean },
  tone: MenuItemTone,
  className: string | undefined
): string | undefined {
  const destructive = tone === 'destructive';
  return appendClassName(
    stylex.props(
      surface.item,
      destructive && surface.itemDestructive,
      state.open && surface.itemOpen,
      state.highlighted && surface.itemHighlighted,
      state.highlighted && destructive && surface.itemDestructiveHighlighted,
      state.disabled && surface.itemDisabled
    ).className,
    className
  );
}

/**
 * The menu, assembled. Base UI splits a popup into a portal, a positioner and
 * the popup; every caller writes the same three, so this part writes them once
 * and takes the positioning props on the outside.
 *
 * It is the same part for a dropdown, a submenu, a context menu and a menubar
 * menu. Base UI resolves the side from where the menu sits — `inline-end` under
 * a submenu trigger, `bottom` under a menubar trigger — so only the top-level
 * gap is stated here, and `ContextMenu.Content` drops even that because a
 * context menu is anchored to the pointer rather than to a control.
 */
export const MenuContent = forwardRef<HTMLDivElement, MenuContentProps>(function MenuContent(
  { className, children, container, finalFocus, sideOffset = POPUP_GAP, ...rest },
  ref
) {
  const inheritedContainer = usePopupContainer();
  // A portalled popup leaves the subtree whose palette it should be using, so
  // the classes that declare that palette travel with it and land on the
  // positioner, where they cascade into the popup and its rows.
  const palette = useForcedThemeClassNames();
  const mountPoint = container ?? inheritedContainer;
  // A popup mounted into a named container is inside a subtree the host owns,
  // and a modal panel typically centres itself with `translate`, which makes it
  // the containing block for every `position: fixed` descendant. Floating UI's
  // fixed strategy then resolves the coordinates it computed against the
  // viewport relative to that panel instead. The absolute strategy resolves
  // against the offset parent, which is the panel, so the two agree again.
  const strategy = rest.positionMethod ?? (mountPoint != null ? 'absolute' : undefined);
  return (
    <BaseMenu.Portal container={mountPoint}>
      <BaseMenu.Positioner
        ref={ref}
        {...rest}
        sideOffset={sideOffset}
        positionMethod={strategy}
        className={[stylex.props(styles.positioner).className, ...palette]
          .filter(Boolean)
          .join(' ')}
      >
        <BaseMenu.Popup
          finalFocus={finalFocus}
          className={(state) => {
            // StyleX cannot express `[data-starting-style]`, so the two ends of
            // the rise are read off Base UI's transition status here, and the
            // direction from the side the menu actually landed on.
            const hidden =
              state.transitionStatus === 'starting' || state.transitionStatus === 'ending';
            return appendClassName(
              stylex.props(
                surface.popup,
                surface.popupMenu,
                hidden && hiddenSurfaceForSide(state.side)
              ).className,
              className
            );
          }}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
});

/** A command. */
export const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  { className, children, icon, shortcut, endContent, inset, tone = 'neutral', ...rest },
  ref
) {
  return (
    <BaseMenu.Item
      ref={ref}
      data-tone={tone}
      {...rest}
      className={(state) => rowClassName(state, tone, className)}
    >
      <Row leading={leadingFor(icon, inset, tone)} shortcut={shortcut} endContent={endContent}>
        {children}
      </Row>
    </BaseMenu.Item>
  );
});

/** A command that is a link: the same row, rendered as an `<a>`. */
export const MenuLinkItem = forwardRef<HTMLAnchorElement, MenuLinkItemProps>(function MenuLinkItem(
  { className, children, icon, shortcut, endContent, inset, tone = 'neutral', ...rest },
  ref
) {
  return (
    <BaseMenu.LinkItem
      ref={ref}
      data-tone={tone}
      {...rest}
      className={(state) => rowClassName(state, tone, className)}
    >
      <Row leading={leadingFor(icon, inset, tone)} shortcut={shortcut} endContent={endContent}>
        {children}
      </Row>
    </BaseMenu.LinkItem>
  );
});

/**
 * A row that toggles a setting.
 *
 * Its leading box is the same box a plain row gives an icon, so a list holding
 * both lines up, and it holds the row's state rather than a caller's glyph:
 * Base UI unmounts the tick while the row is unticked, so an icon sharing that
 * box would slide sideways every time the row was toggled. A row that needs a
 * glyph as well puts it in `endContent`. The box itself is always reserved, so
 * the list does not reflow as the tick appears.
 */
export const MenuCheckboxItem = forwardRef<HTMLDivElement, MenuCheckboxItemProps>(
  function MenuCheckboxItem({ className, children, shortcut, endContent, ...rest }, ref) {
    return (
      <BaseMenu.CheckboxItem
        ref={ref}
        {...rest}
        className={(state) => rowClassName(state, 'neutral', className)}
      >
        <Row
          leading={
            <span {...stylex.props(surface.indicator)}>
              <BaseMenu.CheckboxItemIndicator
                className={stylex.props(surface.indicatorGlyph).className}
                render={<span />}
              >
                <TickGlyph />
              </BaseMenu.CheckboxItemIndicator>
            </span>
          }
          shortcut={shortcut}
          endContent={endContent}
        >
          {children}
        </Row>
      </BaseMenu.CheckboxItem>
    );
  }
);

/** A row that picks one of a `Menu.RadioGroup`'s values; the same box, a dot. */
export const MenuRadioItem = forwardRef<HTMLDivElement, MenuRadioItemProps>(function MenuRadioItem(
  { className, children, shortcut, endContent, ...rest },
  ref
) {
  return (
    <BaseMenu.RadioItem
      ref={ref}
      {...rest}
      className={(state) => rowClassName(state, 'neutral', className)}
    >
      <Row
        leading={
          <span {...stylex.props(surface.indicator)}>
            <BaseMenu.RadioItemIndicator
              className={stylex.props(surface.indicatorGlyph).className}
              render={<span />}
            >
              <DotGlyph />
            </BaseMenu.RadioItemIndicator>
          </span>
        }
        shortcut={shortcut}
        endContent={endContent}
      >
        {children}
      </Row>
    </BaseMenu.RadioItem>
  );
});

/** A row that opens a submenu: the same row, plus the chevron that says so. */
export const MenuSubmenuTrigger = forwardRef<HTMLDivElement, MenuSubmenuTriggerProps>(
  function MenuSubmenuTrigger(
    { className, children, icon, shortcut, endContent, inset, ...rest },
    ref
  ) {
    return (
      <BaseMenu.SubmenuTrigger
        ref={ref}
        {...rest}
        className={(state) => rowClassName(state, 'neutral', className)}
      >
        <Row
          leading={leadingFor(icon, inset)}
          shortcut={shortcut}
          endContent={
            <>
              {endContent}
              <span {...stylex.props(surface.itemIcon, surface.itemSubmenuGlyph)}>
                <ChevronRightGlyph />
              </span>
            </>
          }
        >
          {children}
        </Row>
      </BaseMenu.SubmenuTrigger>
    );
  }
);

export const MenuRadioGroup = forwardRef<HTMLDivElement, MenuRadioGroupProps>(
  function MenuRadioGroup({ className, ...rest }, ref) {
    return <BaseMenu.RadioGroup ref={ref} {...rest} className={className} />;
  }
);

export const MenuGroup = forwardRef<HTMLDivElement, MenuGroupProps>(function MenuGroup(
  { className, ...rest },
  ref
) {
  return <BaseMenu.Group ref={ref} {...rest} className={className} />;
});

export const MenuGroupLabel = forwardRef<HTMLDivElement, MenuGroupLabelProps>(
  function MenuGroupLabel({ className, ...rest }, ref) {
    const sx = stylex.props(surface.groupLabel);
    return (
      <BaseMenu.GroupLabel
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

export const MenuSeparator = forwardRef<HTMLDivElement, MenuSeparatorProps>(function MenuSeparator(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.separator);
  return (
    <BaseMenu.Separator
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * A menu: a trigger and the floating surface it opens.
 *
 * This is also the dropdown menu — Base UI has no separate part for one, and a
 * second name for the same component would be a second thing to keep in step.
 * `ContextMenu` and `Menubar` are the two that reach this surface a different
 * way; they re-export these rows rather than restating them, so a command looks
 * and behaves the same wherever a person meets it.
 *
 * `Menu.Content` assembles the portal, positioner and popup, mounts into the
 * nearest `PopupContainerProvider`, and carries a forced palette across the
 * portal, the way `Select.Content` does.
 */
export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Content: MenuContent,
  Item: MenuItem,
  LinkItem: MenuLinkItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  Group: MenuGroup,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  /** A submenu is a menu inside a row; its content is `Menu.Content` again. */
  Submenu: BaseMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
};
