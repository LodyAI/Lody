import {
  composeEventHandlers,
  composeRefs,
  createContext,
  DATA_ITEM_ATTR,
  Primitive,
  useId,
  useIsomorphicLayoutEffect,
} from "@diceui/shared";
import * as React from "react";
import { type ItemData, useMentionContext } from "./mention-root";

const ITEM_NAME = "MentionItem";

type ItemElement = React.ElementRef<typeof Primitive.div>;

interface MentionItemContext extends ItemData {}

const [MentionItemProvider, useMentionItemContext] =
  createContext<MentionItemContext>(ITEM_NAME);

interface MentionItemProps
  extends React.ComponentPropsWithoutRef<typeof Primitive.div> {
  /**
   * The value of the item.
   *
   * Cannot be an empty string.
   */
  value: string;

  /**
   * The label of the item. By default value is used as label.
   *
   * Override the text value for mention item in the input.
   */
  label?: string;

  /** Whether the item is disabled. */
  disabled?: boolean;

  /** Called when this item is committed as a mention by mouse or keyboard. */
  onMentionSelect?: () => void;

  /**
   * Literal text written into the input when this item is committed, replacing
   * the whole span from the trigger to the caret. Must carry its own leading
   * marker. Defaults to `${trigger}${label}`.
   */
  insertText?: string;

  /**
   * Makes this item a navigation step: selecting it rewrites the trigger span
   * to this text and keeps the menu open, without recording a mention.
   */
  navigateText?: string;

  /** Mention kind recorded on the committed range. */
  kind?: ItemData["kind"];
}

const MentionItem = React.forwardRef<ItemElement, MentionItemProps>(
  (props, forwardedRef) => {
    const {
      value,
      label: labelProp,
      disabled = false,
      onMentionSelect,
      insertText,
      navigateText,
      kind,
      ...itemProps
    } = props;
    const context = useMentionContext(ITEM_NAME);
    const [itemNode, setItemNode] = React.useState<ItemElement | null>(null);
    const itemNodeRef = React.useRef<ItemElement | null>(null);
    const handleItemRef = React.useCallback((node: ItemElement | null) => {
      if (itemNodeRef.current === node) return;
      itemNodeRef.current = node;
      setItemNode(node);
    }, []);
    const composedRef = React.useMemo(
      () => composeRefs(forwardedRef, handleItemRef),
      [forwardedRef, handleItemRef]
    );
    const id = useId();
    const onMentionSelectRef = React.useRef(onMentionSelect);

    const label = labelProp ?? value;
    const isDisabled = disabled || context.disabled;
    const isSelected = context.value.includes(value);

    useIsomorphicLayoutEffect(() => {
      onMentionSelectRef.current = onMentionSelect;
    }, [onMentionSelect]);

    const handleMentionSelect = React.useCallback(() => {
      onMentionSelectRef.current?.();
    }, []);

    useIsomorphicLayoutEffect(() => {
      if (value === "") {
        throw new Error(`\`${ITEM_NAME}\` value cannot be an empty string`);
      }

      // Register the stable ref object, never a `{ current: node }` snapshot.
      // The collection keys its map by this object and reads `.current` when it
      // sorts by document position, so a snapshot taken before the node mounts
      // leaves a null-node entry behind: the sort collapses around it and
      // highlight movement matches the wrong row, losing the highlight and
      // jumping back to the first group.
      return context.onItemRegister({
        ref: itemNodeRef,
        value,
        label,
        disabled: isDisabled,
        onMentionSelect: handleMentionSelect,
        insertText,
        navigateText,
        kind,
      });
    }, [
      label,
      value,
      isDisabled,
      handleMentionSelect,
      context.onItemRegister,
      insertText,
      navigateText,
      kind,
    ]);

    const isVisible = context.getIsItemVisible(value);

    if (!isVisible) return null;

    return (
      <MentionItemProvider label={label} value={value} disabled={isDisabled}>
        <Primitive.div
          role="option"
          id={id}
          aria-selected={isSelected}
          {...{ [DATA_ITEM_ATTR]: "" }}
          data-selected={isSelected ? "" : undefined}
          data-highlighted={
            context.highlightedItem?.ref.current?.id === id ? "" : undefined
          }
          data-disabled={isDisabled ? "" : undefined}
          {...itemProps}
          ref={composedRef}
          onClick={composeEventHandlers(itemProps.onClick, () => {
            if (isDisabled) return;
            const inputElement = context.inputRef.current;
            if (!inputElement) return;

            const selectionStart = inputElement.selectionStart ?? 0;
            const lastTriggerIndex = inputElement.value.lastIndexOf(
              context.trigger,
              selectionStart,
            );

            if (lastTriggerIndex !== -1) {
              context.onMentionAdd(value, lastTriggerIndex);
            }

            inputElement.focus();
          })}
          onPointerDown={composeEventHandlers(
            itemProps.onPointerDown,
            (event) => {
              if (isDisabled) return;

              // prevent implicit pointer capture
              const target = event.target;
              if (!(target instanceof HTMLElement)) return;
              if (target.hasPointerCapture(event.pointerId)) {
                target.releasePointerCapture(event.pointerId);
              }

              if (event.button === 0 && !event.ctrlKey) {
                // prevent item from stealing focus from the input for both mouse and touch
                event.preventDefault();
              }
            },
          )}
          onPointerMove={composeEventHandlers(itemProps.onPointerMove, () => {
            if (isDisabled || !itemNode) return;
            context.onHighlightedItemChange({
              ref: itemNodeRef,
              label,
              value,
              disabled: isDisabled,
            });
          })}
        />
      </MentionItemProvider>
    );
  },
);

MentionItem.displayName = ITEM_NAME;

const Item = MentionItem;

export { Item, MentionItem, useMentionItemContext };

export type { ItemElement, MentionItemProps };
