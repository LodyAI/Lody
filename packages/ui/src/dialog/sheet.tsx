import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { forwardRef } from 'react';
import { Button } from '../button/button';
import { appendClassName } from '../internal/class-name';
import { CrossGlyph } from '../internal/glyphs';
import { PopupContainerProvider } from '../popup/portal-container';
import { useForcedThemeClassNames } from '../theme/theme';
import { DialogBackdrop, DialogDescription, DialogTitle, type DialogContentProps } from './dialog';
import { DialogFooter, DialogHeader, usePanelContainer } from './parts';
import { isHidden, modal, sheetHiddenStyle, sheetSideStyle, type SheetSide } from './surface';

export type { SheetSide };

export interface SheetContentProps extends DialogContentProps {
  /**
   * Which edge the sheet comes in on. `start` and `end` are the writing
   * direction's edges rather than left and right, so a sheet that opens from
   * the trailing side of the window does so in every locale.
   */
  side?: SheetSide;
}

const styles = stylex.create({
  portal: { display: 'contents' },
});

/**
 * The sheet, assembled: the dialog's panel pinned to an edge.
 *
 * It is the same portal, backdrop and panel, reading the same token group, and
 * it replaces exactly the declarations that make a dialog a centred box — the
 * centring transform, the capped width, the radius on the two corners that now
 * meet the window's edge — and the direction it arrives from.
 */
export const SheetContent = forwardRef<HTMLDivElement, SheetContentProps>(function SheetContent(
  {
    className,
    children,
    container,
    backdropContent,
    backdropClassName,
    closeButton = true,
    closeLabel = 'Close',
    side = 'end',
    ...rest
  },
  ref
) {
  const { ref: panelRef, container: panel } = usePanelContainer<HTMLDivElement>(ref);
  const palette = useForcedThemeClassNames();
  return (
    <BaseDialog.Portal
      container={container}
      className={[stylex.props(styles.portal).className, ...palette].filter(Boolean).join(' ')}
    >
      <DialogBackdrop className={backdropClassName}>{backdropContent}</DialogBackdrop>
      <BaseDialog.Popup
        ref={panelRef}
        data-side={side}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(
              modal.popup,
              modal.sheet,
              sheetSideStyle(side),
              isHidden(state.transitionStatus) && sheetHiddenStyle(side)
            ).className,
            className
          )
        }
      >
        <PopupContainerProvider container={panel}>{children}</PopupContainerProvider>
        {closeButton ? (
          <BaseDialog.Close
            render={
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={closeLabel}
                {...stylex.props(modal.close)}
              />
            }
          >
            <CrossGlyph />
          </BaseDialog.Close>
        ) : null}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
});

/**
 * A sheet: the dialog, arriving from an edge of the window instead of its
 * middle.
 *
 * It is a Dialog in every way the token group can see — same rung, same
 * padding, same title step, same overlay — so it is the dialog's `Root`,
 * `Trigger`, `Title`, `Description` and `Close` with one part of its own. That
 * is the shape `ContextMenu` already has against `Menu`: only the way in
 * differs, so only the way in is restated.
 */
export const Sheet = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Content: SheetContent,
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
  Footer: DialogFooter,
  Close: BaseDialog.Close,
};
