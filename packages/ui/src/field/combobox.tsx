import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import * as stylex from '@stylexjs/stylex';
import { createContext, forwardRef, useContext, type ComponentProps, type ReactNode } from 'react';
import { appendClassName } from '../internal/class-name';
import { ChevronDownGlyph, TickGlyph } from '../internal/glyphs';
import { usePopupContainer, type PopupContainer } from '../popup/portal-container';
import { useForcedThemeClassNames } from '../theme/theme';
import { surface } from '../popup/surface';
import { rowLabel } from '../popup/row-label';
import { field } from './field.tokens.stylex';
import { isInvalid } from './invalid';
import { popup } from '../popup/popup.tokens.stylex';
import { trigger, triggerSizes } from './trigger';
import { well } from './well';

/** The gap between a control and the list it opens; the rules' rise distance. */
const POPUP_GAP = 4;

/** The control sits on the same 28 / 32 / 36 ladder as `Input`. */
export type ComboboxSize = 'small' | 'medium' | 'large';

type InputBaseProps = ComponentProps<typeof BaseCombobox.Input>;
type InputGroupBaseProps = ComponentProps<typeof BaseCombobox.InputGroup>;
type TriggerBaseProps = ComponentProps<typeof BaseCombobox.Trigger>;
type ClearBaseProps = ComponentProps<typeof BaseCombobox.Clear>;
type PositionerBaseProps = ComponentProps<typeof BaseCombobox.Positioner>;
type ItemBaseProps = ComponentProps<typeof BaseCombobox.Item>;
type ListBaseProps = ComponentProps<typeof BaseCombobox.List>;
type EmptyBaseProps = ComponentProps<typeof BaseCombobox.Empty>;
type GroupBaseProps = ComponentProps<typeof BaseCombobox.Group>;
type GroupLabelBaseProps = ComponentProps<typeof BaseCombobox.GroupLabel>;
type SeparatorBaseProps = ComponentProps<typeof BaseCombobox.Separator>;

export interface ComboboxInputProps extends Omit<InputBaseProps, 'className' | 'size'> {
  /** Control height and density. `size` is the token step, not the HTML attribute. */
  size?: ComboboxSize;
  className?: string;
}

export interface ComboboxInputGroupProps extends Omit<InputGroupBaseProps, 'className'> {
  size?: ComboboxSize;
  className?: string;
}

export interface ComboboxTriggerProps extends Omit<TriggerBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

export interface ComboboxButtonProps extends Omit<TriggerBaseProps, 'className' | 'children'> {
  /** Control height and density, on the ladder a Select trigger takes. */
  size?: ComboboxSize;
  /** What the button says while nothing is picked. */
  placeholder?: ReactNode;
  /** The value, drawn another way; defaults to the picked item's label. */
  children?: ComponentProps<typeof BaseCombobox.Value>['children'];
  className?: string;
}

export interface ComboboxSearchProps extends Omit<InputBaseProps, 'className' | 'size'> {
  className?: string;
}

export interface ComboboxClearProps extends Omit<ClearBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

export interface ComboboxContentProps extends Omit<
  PositionerBaseProps,
  'className' | 'children' | 'render'
> {
  children?: ListBaseProps['children'];
  /**
   * What the popup says when nothing matches. It is rendered beside the list
   * rather than inside it, and stays mounted, because Base UI announces it.
   */
  empty?: ReactNode;
  /** Where the popup mounts. Defaults to the nearest `PopupContainerProvider`. */
  container?: PopupContainer;
  /**
   * A `Combobox.Search` above the rows, for a list opened by a `Combobox.Button`
   * rather than typed into from the page.
   */
  search?: ReactNode;
  className?: string;
}

export interface ComboboxItemProps extends Omit<ItemBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

export interface ComboboxEmptyProps extends Omit<EmptyBaseProps, 'className'> {
  className?: string;
}
export interface ComboboxGroupProps extends Omit<GroupBaseProps, 'className'> {
  className?: string;
}
export interface ComboboxGroupLabelProps extends Omit<GroupLabelBaseProps, 'className'> {
  className?: string;
}
export interface ComboboxSeparatorProps extends Omit<SeparatorBaseProps, 'className'> {
  className?: string;
}

const styles = stylex.create({
  input: { display: 'block' },
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
  /** The controls beside the input keep the shell's end padding off them. */
  shell: { gap: field.triggerGap },
  /**
   * The search field at the top of a popup: typed into, so still a well, one
   * row tall at the row's radius, clear of the rows by the popup's inset.
   */
  search: {
    display: 'block',
    flexShrink: 0,
    height: popup.itemHeight,
    paddingInline: popup.itemPaddingX,
    borderRadius: popup.itemRadius,
    fontSize: popup.text,
    marginBottom: popup.inset,
  },
});

const sizeStyles = {
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

/**
 * Whether a `Combobox.InputGroup` is above the input. The group is the well
 * when there is one, so the input inside it drops its own; without a group the
 * input is the whole control. Read here rather than made a prop so the two
 * cannot disagree and draw two wells.
 */
const InsideInputGroup = createContext(false);

/**
 * The shell holding the input and whatever sits beside it. It is the well, and
 * the ring follows focus inside it, so a chevron next to the input lands inside
 * one control rather than beside a second one.
 */
export const ComboboxInputGroup = forwardRef<HTMLDivElement, ComboboxInputGroupProps>(
  function ComboboxInputGroup({ size = 'medium', className, ...rest }, ref) {
    const ariaInvalid = rest['aria-invalid'];
    return (
      <InsideInputGroup.Provider value={true}>
        <BaseCombobox.InputGroup
          ref={ref}
          data-size={size}
          {...rest}
          className={(state) =>
            appendClassName(
              stylex.props(
                well.shell,
                styles.shell,
                sizeStyles[size],
                isInvalid(state.valid, ariaInvalid) && well.shellInvalid,
                // `:disabled` cannot reach a `<div>`, so the family's one
                // disabled value is applied from Base UI's state instead.
                state.disabled && well.dimmed
              ).className,
              className
            )
          }
        />
      </InsideInputGroup.Provider>
    );
  }
);

/**
 * The text input a person filters with. On its own it is the whole control, a
 * well on the size ladder; inside a `Combobox.InputGroup` the group is the well
 * and this is bare.
 */
export const ComboboxInput = forwardRef<HTMLInputElement, ComboboxInputProps>(
  function ComboboxInput({ size = 'medium', className, ...rest }, ref) {
    const insideGroup = useContext(InsideInputGroup);
    const ariaInvalid = rest['aria-invalid'];
    return (
      <BaseCombobox.Input
        ref={ref}
        data-size={insideGroup ? undefined : size}
        {...rest}
        className={(state) =>
          appendClassName(
            insideGroup
              ? stylex.props(well.bare).className
              : stylex.props(
                  well.base,
                  styles.input,
                  sizeStyles[size],
                  isInvalid(state.valid, ariaInvalid) && well.invalid
                ).className,
            className
          )
        }
      />
    );
  }
);

/** The chevron beside the input: it opens the list without clearing the query. */
export const ComboboxTrigger = forwardRef<HTMLButtonElement, ComboboxTriggerProps>(
  function ComboboxTrigger({ className, children, ...rest }, ref) {
    const sx = stylex.props(well.adornment);
    return (
      <BaseCombobox.Trigger
        ref={ref}
        nativeButton
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      >
        {children ?? <ChevronDownGlyph />}
      </BaseCombobox.Trigger>
    );
  }
);

/**
 * A list picked from rather than typed into, whose search sits inside its
 * popup: a font from every installed family, a model from a long catalogue.
 * It is the trigger a `Select` takes, so a column of settings reads as one kind
 * of control whether or not its list can be searched; the typing happens in
 * `Combobox.Search`, at the top of the popup.
 */
export const ComboboxButton = forwardRef<HTMLButtonElement, ComboboxButtonProps>(
  function ComboboxButton({ size = 'medium', placeholder, children, className, ...rest }, ref) {
    const ariaInvalid = rest['aria-invalid'];
    return (
      <BaseCombobox.Trigger
        ref={ref}
        nativeButton
        data-size={size}
        {...rest}
        className={(state) =>
          appendClassName(
            stylex.props(
              well.base,
              trigger.base,
              triggerSizes[size],
              state.placeholder && trigger.placeholder,
              isInvalid(state.valid, ariaInvalid) && well.invalid
            ).className,
            className
          )
        }
      >
        <span {...stylex.props(trigger.value)}>
          <BaseCombobox.Value placeholder={placeholder}>{children}</BaseCombobox.Value>
        </span>
        <span {...stylex.props(trigger.icon)}>
          <ChevronDownGlyph />
        </span>
      </BaseCombobox.Trigger>
    );
  }
);

/** The field a person filters with, at the top of a `Combobox.Button`'s popup. */
export const ComboboxSearch = forwardRef<HTMLInputElement, ComboboxSearchProps>(
  function ComboboxSearch({ className, ...rest }, ref) {
    return (
      <BaseCombobox.Input
        ref={ref}
        {...rest}
        className={appendClassName(stylex.props(well.base, styles.search).className, className)}
      />
    );
  }
);

/** Drops the value. Base UI unmounts it while there is nothing to drop. */
export const ComboboxClear = forwardRef<HTMLButtonElement, ComboboxClearProps>(
  function ComboboxClear({ className, children, ...rest }, ref) {
    const sx = stylex.props(well.adornment);
    return (
      <BaseCombobox.Clear
        ref={ref}
        nativeButton
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      >
        {children}
      </BaseCombobox.Clear>
    );
  }
);

/** A row in the list: its label, and the tick when it holds the value. */
export const ComboboxItem = forwardRef<HTMLDivElement, ComboboxItemProps>(function ComboboxItem(
  { className, children, ...rest },
  ref
) {
  return (
    <BaseCombobox.Item
      ref={ref}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            surface.item,
            state.selected && surface.itemSelected,
            state.highlighted && surface.itemHighlighted,
            state.disabled && surface.itemDisabled
          ).className,
          className
        )
      }
    >
      <span {...stylex.props(surface.itemText)}>{rowLabel(children)}</span>
      <span {...stylex.props(surface.indicator)}>
        <BaseCombobox.ItemIndicator
          className={stylex.props(surface.indicatorGlyph).className}
          render={<span />}
        >
          <TickGlyph />
        </BaseCombobox.ItemIndicator>
      </span>
    </BaseCombobox.Item>
  );
});

export const ComboboxEmpty = forwardRef<HTMLDivElement, ComboboxEmptyProps>(function ComboboxEmpty(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.empty);
  return (
    <BaseCombobox.Empty
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

export const ComboboxGroup = forwardRef<HTMLDivElement, ComboboxGroupProps>(function ComboboxGroup(
  { className, ...rest },
  ref
) {
  return <BaseCombobox.Group ref={ref} {...rest} className={className} />;
});

export const ComboboxGroupLabel = forwardRef<HTMLDivElement, ComboboxGroupLabelProps>(
  function ComboboxGroupLabel({ className, ...rest }, ref) {
    const sx = stylex.props(surface.groupLabel);
    return (
      <BaseCombobox.GroupLabel
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

export const ComboboxSeparator = forwardRef<HTMLDivElement, ComboboxSeparatorProps>(
  function ComboboxSeparator({ className, ...rest }, ref) {
    const sx = stylex.props(surface.separator);
    return (
      <BaseCombobox.Separator
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);

/**
 * The list, assembled — the same floating surface a `Select` opens, so the two
 * cannot drift. `empty` is rendered beside the list rather than inside it,
 * because Base UI keeps that region mounted to announce the change.
 */
export const ComboboxContent = forwardRef<HTMLDivElement, ComboboxContentProps>(
  function ComboboxContent(
    { className, children, empty, search, container, sideOffset = POPUP_GAP, ...rest },
    ref
  ) {
    const inheritedContainer = usePopupContainer();
    // A portalled popup leaves the subtree whose palette it should be using, so
    // the classes that declare that palette travel with it and land on the
    // positioner, where they cascade into the popup and its rows.
    const palette = useForcedThemeClassNames();
    const mountPoint = container ?? inheritedContainer;
    // A popup mounted into a named container is inside a subtree the host owns,
    // and a modal panel typically centres itself with `translate`, which makes
    // it the containing block for every `position: fixed` descendant. Floating
    // UI's fixed strategy then resolves the coordinates it computed against the
    // viewport relative to that panel instead, and the list lands as far off as
    // the panel is from the viewport corner. The absolute strategy resolves
    // against the offset parent, which is the panel, so the two agree again.
    const strategy = rest.positionMethod ?? (mountPoint != null ? 'absolute' : undefined);
    return (
      <BaseCombobox.Portal container={mountPoint}>
        <BaseCombobox.Positioner
          ref={ref}
          {...rest}
          sideOffset={sideOffset}
          positionMethod={strategy}
          className={[stylex.props(surface.positioner).className, ...palette]
            .filter(Boolean)
            .join(' ')}
        >
          <BaseCombobox.Popup
            className={(state) => {
              // StyleX cannot express `[data-starting-style]`, so the two ends
              // of the rise are read off Base UI's transition status here.
              const hidden =
                state.transitionStatus === 'starting' || state.transitionStatus === 'ending';
              return appendClassName(
                stylex.props(surface.popup, hidden && surface.popupHidden).className,
                className
              );
            }}
          >
            {search}
            {empty}
            <BaseCombobox.List className={stylex.props(surface.list).className}>
              {children}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    );
  }
);

/**
 * A combobox in the field family: a well-rung text input that filters the same
 * floating list a `Select` opens. `Combobox.Root` owns the value, the query and
 * the open state; the input reads validity and disabled from `Field.Root` the
 * way an `Input` does.
 */
export const Combobox = {
  Root: BaseCombobox.Root,
  InputGroup: ComboboxInputGroup,
  Input: ComboboxInput,
  Button: ComboboxButton,
  Search: ComboboxSearch,
  Trigger: ComboboxTrigger,
  Clear: ComboboxClear,
  Content: ComboboxContent,
  Item: ComboboxItem,
  Empty: ComboboxEmpty,
  Group: ComboboxGroup,
  GroupLabel: ComboboxGroupLabel,
  Separator: ComboboxSeparator,
  Value: BaseCombobox.Value,
};
