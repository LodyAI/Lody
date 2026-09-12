import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { usePopupContainer, type PopupContainer } from '../popup/portal-container';
import { hiddenSurfaceForSide, surface } from '../popup/surface';
import { useForcedThemeClassNames } from '../theme/theme';
import {
  MenuContent,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenuTrigger,
} from './menu';

type PositionerBaseProps = ComponentProps<typeof BaseContextMenu.Positioner>;
type PopupBaseProps = ComponentProps<typeof BaseContextMenu.Popup>;
type TriggerBaseProps = ComponentProps<typeof BaseContextMenu.Trigger>;

export interface ContextMenuTriggerProps extends Omit<TriggerBaseProps, 'className'> {
  className?: string;
}

export interface ContextMenuContentProps extends Omit<
  PositionerBaseProps,
  'className' | 'children' | 'render'
> {
  children?: ReactNode;
  /** Where the menu mounts. Defaults to the nearest `PopupContainerProvider`. */
  container?: PopupContainer;
  /** Where focus goes when the menu closes; Base UI's popup prop. */
  finalFocus?: PopupBaseProps['finalFocus'];
  className?: string;
}

const styles = stylex.create({
  positioner: { outlineStyle: 'none' },
  /** The area that answers a right click; it is the caller's own layout. */
  trigger: { display: 'contents' },
});

/**
 * The region a right click or a long press opens the menu over.
 *
 * It renders no box of its own — `display: contents` — because a context menu
 * is attached to something the surface already laid out, and a wrapper with a
 * layout of its own would change that layout just by being asked for a menu.
 */
export const ContextMenuTrigger = forwardRef<HTMLDivElement, ContextMenuTriggerProps>(
  function ContextMenuTrigger({ className, ...rest }, ref) {
    return (
      <BaseContextMenu.Trigger
        ref={ref}
        {...rest}
        className={appendClassName(stylex.props(styles.trigger).className, className)}
      />
    );
  }
);

/**
 * The same surface `Menu.Content` renders, anchored to the pointer.
 *
 * It states no `sideOffset` or `alignOffset`, unlike `Menu.Content`: a context
 * menu has no control to leave a gap beside, and Base UI's own offsets place
 * its corner under the pointer. Passing the menu gap here would push the menu
 * away from the click that asked for it.
 */
export const ContextMenuContent = forwardRef<HTMLDivElement, ContextMenuContentProps>(
  function ContextMenuContent({ className, children, container, finalFocus, ...rest }, ref) {
    const inheritedContainer = usePopupContainer();
    const palette = useForcedThemeClassNames();
    const mountPoint = container ?? inheritedContainer;
    return (
      <BaseContextMenu.Portal container={mountPoint}>
        <BaseContextMenu.Positioner
          ref={ref}
          {...rest}
          className={[stylex.props(styles.positioner).className, ...palette]
            .filter(Boolean)
            .join(' ')}
        >
          <BaseContextMenu.Popup
            finalFocus={finalFocus}
            className={(state) => {
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
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    );
  }
);

/**
 * A menu reached by right click or long press instead of by a button.
 *
 * Only the way in differs, so only the way in is restated here: the rows, the
 * groups, the separators and the submenu trigger are `Menu`'s, re-exported
 * rather than rebuilt, which is what keeps a command from looking like one
 * thing in a dropdown and another under a right click.
 */
export const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: ContextMenuTrigger,
  Content: ContextMenuContent,
  Item: MenuItem,
  LinkItem: MenuLinkItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  Group: MenuGroup,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  Submenu: BaseContextMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
  /**
   * A submenu of a context menu is anchored to the row that opened it, not to
   * the pointer, so it is `Menu.Content` — the gap beside the row applies again.
   */
  SubmenuContent: MenuContent,
};
