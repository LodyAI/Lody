import { Select as BaseSelect } from '@base-ui/react/select';
import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { ChevronDownGlyph, ChevronUpGlyph, TickGlyph } from '../internal/glyphs';
import { appendClassName } from '../internal/class-name';
import { usePopupContainer, type PopupContainer } from '../popup/portal-container';
import { useForcedThemeClassNames } from '../theme/theme';
import { surface } from '../popup/surface';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { well } from './well';

/** The gap between a control and the list it opens; the rules' rise distance. */
const POPUP_GAP = 4;

/** The trigger sits on the same 28 / 32 / 36 ladder as `Input`. */
export type SelectSize = 'small' | 'medium' | 'large';

type TriggerBaseProps = ComponentProps<typeof BaseSelect.Trigger>;
type ValueBaseProps = ComponentProps<typeof BaseSelect.Value>;
type PositionerBaseProps = ComponentProps<typeof BaseSelect.Positioner>;
type ItemBaseProps = ComponentProps<typeof BaseSelect.Item>;
type GroupBaseProps = ComponentProps<typeof BaseSelect.Group>;
type GroupLabelBaseProps = ComponentProps<typeof BaseSelect.GroupLabel>;
type SeparatorBaseProps = ComponentProps<typeof BaseSelect.Separator>;

export interface SelectTriggerProps extends Omit<TriggerBaseProps, 'className' | 'children'> {
  /** Control height and density, the same step `Input` takes. */
  size?: SelectSize;
  children?: ReactNode;
  className?: string;
}

export interface SelectValueProps extends Omit<ValueBaseProps, 'className'> {
  className?: string;
}

export interface SelectContentProps extends Omit<
  PositionerBaseProps,
  'className' | 'children' | 'render'
> {
  children?: ReactNode;
  /** Where the popup mounts. Defaults to the nearest `PopupContainerProvider`. */
  container?: PopupContainer;
  className?: string;
}

export interface SelectItemProps extends Omit<ItemBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  /**
   * An affordance at the end of the row, before the tick — an edit button on
   * the row it belongs to. It sits outside the row's label, so what the trigger
   * shows for the selected row stays the label alone.
   */
  endContent?: ReactNode;
  className?: string;
}

export interface SelectGroupProps extends Omit<GroupBaseProps, 'className'> {
  className?: string;
}
export interface SelectGroupLabelProps extends Omit<GroupLabelBaseProps, 'className'> {
  className?: string;
}
export interface SelectSeparatorProps extends Omit<SeparatorBaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  trigger: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: field.triggerGap,
    textAlign: 'start',
    whiteSpace: 'nowrap',
    lineHeight: 1,
    userSelect: 'none',
    // A trigger opens a list; it is not a button that acts, so it keeps the
    // arrow the way a native select does rather than taking the hand.
    cursor: { default: 'default', ':disabled': 'default' },
  },
  small: {
    height: field.heightSmall,
    paddingInline: field.paddingXSmall,
    borderRadius: field.radiusSmall,
    fontSize: field.text,
  },
  medium: {
    height: field.heightMedium,
    paddingInline: field.paddingXMedium,
    borderRadius: field.radiusMedium,
    fontSize: field.text,
  },
  large: {
    height: field.heightLarge,
    paddingInline: field.paddingXLarge,
    borderRadius: field.radiusMedium,
    fontSize: field.text,
  },
  /** The value takes the width the chevron leaves, so a long one truncates. */
  value: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** An empty trigger reads as a prompt, in the same hint colour as a placeholder. */
  placeholder: { color: field.placeholder },
  icon: {
    display: 'flex',
    flexShrink: 0,
    width: field.iconSize,
    height: field.iconSize,
    color: field.icon,
  },
  /** The positioner carries no appearance; the popup inside it does. */
  positioner: { outlineStyle: 'none' },
});

const sizeStyles = {
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

/**
 * The trigger: a control on the well rung that happens to open a list. It reads
 * validity and disabled from `Field.Root` the way every control in this family
 * does, and renders the chevron itself so a caller never draws one.
 */
export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger({ size = 'medium', className, children, ...rest }, ref) {
    const ariaInvalid = rest['aria-invalid'];
    return (
      <BaseSelect.Trigger
        ref={ref}
        nativeButton
        data-size={size}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(
              well.base,
              styles.trigger,
              sizeStyles[size],
              isInvalid(state.valid, ariaInvalid) && well.invalid
            ).className,
            className
          )
        }
      >
        {children}
        <BaseSelect.Icon className={stylex.props(styles.icon).className}>
          <ChevronDownGlyph />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
    );
  }
);

/** What the trigger shows: the selected label, or the placeholder prompt. */
export const SelectValue = forwardRef<HTMLSpanElement, SelectValueProps>(function SelectValue(
  { className, ...rest },
  ref
) {
  return (
    <BaseSelect.Value
      ref={ref}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(styles.value, state.placeholder && styles.placeholder).className,
          className
        )
      }
    />
  );
});

/** A row in the list: its label, and the tick when it holds the value. */
export const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(function SelectItem(
  { className, children, endContent, ...rest },
  ref
) {
  return (
    <BaseSelect.Item
      ref={ref}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            surface.item,
            state.selected && surface.itemSelected,
            // The highlight is where the keyboard or the pointer is, so it
            // wins the fill over the selected row; the tick still says which
            // row is current.
            state.highlighted && surface.itemHighlighted,
            state.disabled && surface.itemDisabled
          ).className,
          className
        )
      }
    >
      <BaseSelect.ItemText className={stylex.props(surface.itemText).className}>
        {children}
      </BaseSelect.ItemText>
      {endContent}
      <span {...stylex.props(surface.indicator)}>
        <BaseSelect.ItemIndicator
          className={stylex.props(surface.indicatorGlyph).className}
          render={<span />}
        >
          <TickGlyph />
        </BaseSelect.ItemIndicator>
      </span>
    </BaseSelect.Item>
  );
});

export const SelectGroup = forwardRef<HTMLDivElement, SelectGroupProps>(function SelectGroup(
  { className, ...rest },
  ref
) {
  return <BaseSelect.Group ref={ref} {...rest} className={className} />;
});

export const SelectGroupLabel = forwardRef<HTMLDivElement, SelectGroupLabelProps>(
  function SelectGroupLabel({ className, ...rest }, ref) {
    const sx = stylex.props(surface.groupLabel);
    return (
      <BaseSelect.GroupLabel
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

export const SelectSeparator = forwardRef<HTMLDivElement, SelectSeparatorProps>(
  function SelectSeparator({ className, ...rest }, ref) {
    const sx = stylex.props(surface.separator);
    return (
      <BaseSelect.Separator
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/**
 * The list, assembled. Base UI splits a popup into a portal, a positioner, the
 * popup, the scrolling list and two scroll arrows; every caller writes the same
 * five, so this part writes them once and takes the positioning props on the
 * outside. The caller supplies rows and nothing else.
 */
export const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(function SelectContent(
  {
    className,
    children,
    container,
    // Base UI's default overlaps the popup with its trigger so the selected
    // row's text lands on the value, the way a macOS pop-up button does. This
    // package's motion rule says a popup rises from 4px below the control
    // instead, so the list is anchored under the trigger by default. That also
    // keeps the popup on the anchored positioning path: the overlapping mode
    // computes viewport coordinates and pins `position: fixed` itself, which a
    // container that centres itself with `translate` then reinterprets as its
    // own origin. A caller that wants the overlap can still ask for it.
    alignItemWithTrigger = false,
    sideOffset = POPUP_GAP,
    ...rest
  },
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
  // viewport relative to that panel instead, and the list lands as far off as
  // the panel is from the viewport corner. The absolute strategy resolves
  // against the offset parent, which is the panel, so the two agree again.
  const strategy = rest.positionMethod ?? (mountPoint != null ? 'absolute' : undefined);
  return (
    <BaseSelect.Portal container={mountPoint}>
      <BaseSelect.Positioner
        ref={ref}
        {...rest}
        alignItemWithTrigger={alignItemWithTrigger}
        sideOffset={sideOffset}
        positionMethod={strategy}
        className={[stylex.props(styles.positioner).className, ...palette]
          .filter(Boolean)
          .join(' ')}
      >
        <BaseSelect.Popup
          className={(state) => {
            // StyleX cannot express `[data-starting-style]`, so the two ends
            // of the rise are read off Base UI's transition status here.
            const hidden =
              state.transitionStatus === 'starting' || state.transitionStatus === 'ending';
            return appendClassName(
              stylex.props(
                surface.popup,
                hidden &&
                  // `side="none"` means the popup is overlapping its trigger
                  // to line the selected row up with the value; sliding it
                  // would pull that alignment out from under the pointer.
                  (state.side === 'none' ? surface.popupHiddenInPlace : surface.popupHidden)
              ).className,
              className
            );
          }}
        >
          <BaseSelect.ScrollUpArrow className={stylex.props(surface.scrollArrow).className}>
            <ChevronUpGlyph />
          </BaseSelect.ScrollUpArrow>
          <BaseSelect.List className={stylex.props(surface.list).className}>
            {children}
          </BaseSelect.List>
          <BaseSelect.ScrollDownArrow className={stylex.props(surface.scrollArrow).className}>
            <ChevronDownGlyph />
          </BaseSelect.ScrollDownArrow>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
});

/**
 * A select in the field family: a well-rung trigger and a floating list.
 * `Select.Root` owns the value and the open state; the trigger reads validity
 * and disabled from `Field.Root` the way an `Input` does, and `Select.Content`
 * assembles the portal, positioner, popup, list and scroll arrows so a caller
 * writes rows rather than plumbing.
 */
export const Select = {
  Root: BaseSelect.Root,
  Trigger: SelectTrigger,
  Value: SelectValue,
  Content: SelectContent,
  Item: SelectItem,
  Group: SelectGroup,
  GroupLabel: SelectGroupLabel,
  Separator: SelectSeparator,
};
