import { Toolbar as BaseToolbar } from '@base-ui/react/toolbar';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { separatorStyles } from '../separator/separator';
import { toggleSurface as surface } from './surface';

type RootBaseProps = ComponentProps<typeof BaseToolbar.Root>;
type GroupBaseProps = ComponentProps<typeof BaseToolbar.Group>;
type SeparatorBaseProps = ComponentProps<typeof BaseToolbar.Separator>;

export interface ToolbarRootProps extends Omit<RootBaseProps, 'className'> {
  className?: string;
}
export interface ToolbarGroupProps extends Omit<GroupBaseProps, 'className'> {
  className?: string;
}
export interface ToolbarSeparatorProps extends Omit<SeparatorBaseProps, 'className'> {
  className?: string;
}

/**
 * A bar of controls.
 *
 * It draws nothing at all: no fill, no shadow, no radius, and not even the line
 * a table draws. A bar is a row of controls on whatever surface the product
 * already had there — a page, a card, the popup over a text selection — so a
 * bar inside a panel is not a second panel inside one, and a surface that wants
 * the bar to look like something gives it that itself.
 *
 * What it is for is the keyboard. A row of eight icon buttons is eight tab
 * stops unless something says otherwise, and a person tabbing through a page
 * should pass a bar rather than walk it. Base UI makes the bar one stop, gives
 * the arrow keys the walking, and skips the controls that are disabled — which
 * is the whole reason this part exists rather than a `div` with a gap.
 */
export const ToolbarRoot = forwardRef<HTMLDivElement, ToolbarRootProps>(function ToolbarRoot(
  { className, orientation = 'horizontal', ...rest },
  ref
) {
  const sx = stylex.props(surface.bar, orientation === 'vertical' && surface.barVertical);
  return (
    <BaseToolbar.Root
      ref={ref}
      orientation={orientation}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * A cluster inside a bar: controls that belong together, at the gap a set of
 * toggles takes rather than the wider one between clusters. It says `group` to
 * a screen reader, so a person hears where one cluster ends.
 */
export const ToolbarGroup = forwardRef<HTMLDivElement, ToolbarGroupProps>(function ToolbarGroup(
  { className, ...rest },
  ref
) {
  return (
    <BaseToolbar.Group
      ref={ref}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            surface.barGroup,
            state.orientation === 'vertical' && surface.barGroupVertical
          ).className,
          className
        )
      }
    />
  );
});

/**
 * The line between two clusters of a bar — the same line `Separator` draws,
 * because this system allows exactly one. It is the toolbar's own part rather
 * than a `Separator` placed by hand for one reason: the orientation is the
 * bar's turned ninety degrees, and a caller stating it twice is a caller who
 * can get it wrong. It stretches to the row for the reason a vertical line
 * always does here — a percentage would resolve against a height a flex row has
 * not got.
 */
export const ToolbarSeparator = forwardRef<HTMLDivElement, ToolbarSeparatorProps>(
  function ToolbarSeparator({ className, ...rest }, ref) {
    return (
      <BaseToolbar.Separator
        ref={ref}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(
              separatorStyles.base,
              state.orientation === 'vertical'
                ? separatorStyles.vertical
                : separatorStyles.horizontal
            ).className,
            className
          )
        }
      />
    );
  }
);

/**
 * Toolbar: the bar, its clusters, the line between them, and the way a control
 * joins the walk.
 *
 * `Toolbar.Button` is Base UI's, unstyled, the way every trigger in this
 * package is: a bar holds whatever the surface already had there — a ghost
 * `Button`, a `Toggle`, the trigger of a `Menu` — and registering it in the
 * roving focus is all this part does. `render={<Button variant="ghost" icon/>}`
 * is how one arrives.
 *
 * There is no `Toolbar.Input` or `Toolbar.Link` here. Base UI ships both, and
 * neither has an appearance of this system's to add: an `Input` in a bar is
 * this package's `Input`, and a link is a `Button variant="link"`. They can be
 * added the day a surface needs one in the walk.
 */
export const Toolbar = {
  Root: ToolbarRoot,
  Button: BaseToolbar.Button,
  Group: ToolbarGroup,
  Separator: ToolbarSeparator,
};
