import {
  type CollectionItem,
  composeRefs,
  createContext,
  type Direction,
  type HighlightingDirection,
  Primitive,
  useCollection,
  useControllableState,
  useDirection,
  useFilterStore,
  useFormControl,
  useId,
  useListHighlighting,
  VisuallyHiddenInput,
} from '@diceui/shared';
import type { VirtualElement } from '@floating-ui/react';
import * as React from 'react';
import type { ContentElement } from './mention-content';
import type { InputElement } from './mention-input';
import type { ItemElement } from './mention-item';

function getDataState(open: boolean) {
  return open ? 'open' : 'closed';
}

const ROOT_NAME = 'MentionRoot';

type RootElement = React.ElementRef<typeof Primitive.div>;

interface ItemData {
  label: string;
  value: string;
  disabled: boolean;
  onMentionSelect?: () => void;

  /**
   * Literal text written into the input when this item is committed.
   *
   * It replaces the whole span from the trigger character to the caret, so it
   * must carry its own leading marker (`@src/foo.ts`, `#123`). Defaults to
   * `${trigger}${label}`.
   */
  insertText?: string;

  /**
   * Marks the item as a navigation step rather than a mention: selecting it
   * rewrites the trigger span to this text and keeps the menu open, without
   * recording a mention range or a selected value. Used to descend into a
   * directory (`@src/`) or into a mention category (`@issue:`).
   *
   * Like `insertText`, it replaces the span from the trigger and carries its
   * own leading marker.
   */
  navigateText?: string;

  /** Mention kind recorded on the committed range. Defaults to `mention`. */
  kind?: MentionKind;
}

type MentionKind =
  | 'mention'
  | 'file'
  | 'dir'
  | 'issue'
  | 'pr'
  | 'skill'
  | 'command'
  | 'session'
  | 'pasted_text';

interface Mention extends Omit<ItemData, 'label' | 'disabled'> {
  start: number;
  end: number;
  kind?: MentionKind;
}

interface MentionSelectionRange {
  start: number;
  end: number;
  // Optional guard to ensure selection applies only after the input renders
  // the same text snapshot that produced this cursor position.
  expectedValue?: string;
}

interface MentionContextValue {
  value: string[];
  onValueChange: React.Dispatch<React.SetStateAction<string[] | undefined>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inputValue: string;
  onInputValueChange: (value: string) => void;
  virtualAnchor: VirtualElement | null;
  onVirtualAnchorChange: (element: VirtualElement | null) => void;
  triggers: string[];
  trigger: string;
  onTriggerChange: (character: string) => void;
  getEnabledItems: () => CollectionItem<ItemElement, ItemData>[];
  onItemRegister: (item: CollectionItem<ItemElement, ItemData>) => void;
  filterStore: {
    search: string;
    itemCount: number;
    items: Map<string, number>;
  };
  onFilter?: (options: string[], term: string) => string[];
  onItemsFilter: () => void;
  getIsItemVisible: (value: string) => boolean;
  highlightedItem: CollectionItem<ItemElement, ItemData> | null;
  onHighlightedItemChange: (item: CollectionItem<ItemElement, ItemData> | null) => void;
  onHighlightMove: (direction: HighlightingDirection) => void;
  mentions: Mention[];
  onMentionsChange: React.Dispatch<React.SetStateAction<Mention[]>>;
  onMentionAdd: (value: string, triggerIndex: number, options?: { commit?: boolean }) => void;
  onMentionsRemove: (mentionsToRemove: Mention[]) => void;
  onMentionClick?: (mention: Mention) => void;
  pendingSelection: MentionSelectionRange | null;
  onPendingSelectionChange: React.Dispatch<React.SetStateAction<MentionSelectionRange | null>>;
  dir: Direction;
  disabled: boolean;
  exactMatch: boolean;
  loop: boolean;
  modal: boolean;
  readonly: boolean;
  inputRef: React.RefObject<InputElement | null>;
  listRef: React.RefObject<ContentElement | null>;
  inputId: string;
  labelId: string;
  listId: string;
}

const [MentionProvider, useMentionContext] = createContext<MentionContextValue>(ROOT_NAME);

interface MentionRootProps extends Omit<
  React.ComponentPropsWithoutRef<typeof Primitive.div>,
  'value' | 'defaultValue'
> {
  /** The currently selected value. */
  value?: string[];

  /** The default selected value. */
  defaultValue?: string[];

  /** Event handler called when a mention item is selected. */
  onValueChange?: (value: string[]) => void;

  /** Whether the mention menu is open. */
  open?: boolean;

  /** The default open state. */
  defaultOpen?: boolean;

  /** Event handler called when the open state changes. */
  onOpenChange?: (open: boolean) => void;

  /** The current input value. */
  inputValue?: string;

  /** Event handler called when the input value changes. */
  onInputValueChange?: (value: string) => void;

  /** Controlled mention ranges rendered inside the input. */
  mentions?: Mention[];

  /** The default mention ranges rendered inside the input. */
  defaultMentions?: Mention[];

  /** Event handler called when mention ranges change. */
  onMentionsChange?: (mentions: Mention[]) => void;

  /** Event handler called when a rendered mention range is clicked. */
  onMentionClick?: (mention: Mention) => void;

  /**
   * Characters that activate the mention menu when typed.
   *
   * When provided, the mention menu can be triggered by any of these characters.
   * The active trigger is exposed via `trigger` in context and is updated based on cursor position.
   */
  triggers?: string[];

  /** The character that activates the mention menu when typed. */
  trigger?: string;

  /** The direction the mention should open. */
  dir?: Direction;

  /** Whether the mention is disabled. */
  disabled?: boolean;

  /**
   * Event handler called when the filter is applied.
   * Can be used to prevent the default filtering behavior.
   */
  onFilter?: (options: string[], term: string) => string[];

  /**
   * Whether the mention menu should automatically close when filtering yields 0 results.
   * @default true
   */
  autoCloseOnEmpty?: boolean;

  /**
   * Whether the mention uses exact string matching or fuzzy matching.
   * When onFilter is provided, this prop is ignored.
   * @default false
   */
  exactMatch?: boolean;

  /**
   * Whether the mention loops through items.
   * @default false
   */
  loop?: boolean;

  /**
   * Whether the mention is modal.
   * @default false
   */
  modal?: boolean;

  /**
   * Whether the mention is read-only.
   * @default false
   */
  readonly?: boolean;

  /**
   * Whether the mention is required in a form context.
   * @default false
   */
  required?: boolean;

  /** The name of the mention for form submission. */
  name?: string;
}

const MentionRoot = React.forwardRef<RootElement, MentionRootProps>((props, forwardedRef) => {
  const {
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange: onOpenChangeProp,
    inputValue: inputValueProp,
    onInputValueChange,
    mentions: mentionsProp,
    defaultMentions = [],
    onMentionsChange: onMentionsChangeProp,
    onMentionClick,
    value: valueProp,
    defaultValue,
    onValueChange,
    onFilter,
    autoCloseOnEmpty = true,
    triggers: triggersProp,
    trigger: triggerProp = '@',
    dir: dirProp,
    disabled = false,
    exactMatch = false,
    loop = false,
    modal = false,
    readonly = false,
    required = false,
    name,
    ...rootProps
  } = props;

  const listRef = React.useRef<ContentElement | null>(null);
  const inputRef = React.useRef<InputElement | null>(null);

  const inputId = useId();
  const labelId = useId();
  const listId = useId();

  const { collectionRef, itemMap, getItems, onItemRegister } = useCollection<
    ItemElement,
    ItemData
  >();
  const { isFormControl, onTriggerChange } = useFormControl<RootElement>();
  const rootNodeRef = React.useRef<RootElement | null>(null);
  const onFormControlTriggerChangeRef = React.useRef(onTriggerChange);
  onFormControlTriggerChangeRef.current = onTriggerChange;
  const handleRootRef = React.useCallback((node: RootElement | null) => {
    if (rootNodeRef.current === node) return;
    rootNodeRef.current = node;
    onFormControlTriggerChangeRef.current(node);
  }, []);
  const composedRef = React.useMemo(
    () => composeRefs(forwardedRef, collectionRef, handleRootRef),
    [forwardedRef, collectionRef, handleRootRef]
  );

  const dir = useDirection(dirProp);
  const [open = false, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChangeProp,
  });
  const [value = [], setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue,
    onChange: onValueChange,
  });
  const [inputValue = '', setInputValue] = useControllableState({
    prop: inputValueProp,
    defaultProp: '',
    onChange: onInputValueChange,
  });
  const triggers = React.useMemo(() => {
    const provided = triggersProp ?? [triggerProp];
    const unique = Array.from(new Set((provided ?? []).filter(Boolean)));
    if (unique.length > 0 && !unique.includes(triggerProp)) unique.unshift(triggerProp);
    return unique;
  }, [triggersProp, triggerProp]);

  const [trigger, setTrigger] = React.useState<MentionContextValue['trigger']>(
    triggers.includes(triggerProp) ? triggerProp : (triggers[0] ?? triggerProp)
  );

  React.useEffect(() => {
    if (triggers.length === 0) {
      if (trigger !== triggerProp) {
        setTrigger(triggerProp);
      }
      return;
    }
    if (!triggers.includes(trigger)) {
      setTrigger(triggers[0] ?? triggerProp);
    }
  }, [trigger, triggerProp, triggers]);

  const [virtualAnchor, setVirtualAnchor] = React.useState<VirtualElement | null>(null);
  const [highlightedItem, setHighlightedItem] = React.useState<CollectionItem<
    ItemElement,
    ItemData
  > | null>(null);
  const [mentionsState = [], setMentionsState] = useControllableState({
    prop: mentionsProp,
    defaultProp: defaultMentions,
    onChange: onMentionsChangeProp,
  });
  const mentions = mentionsState ?? [];
  const setMentions = React.useCallback<React.Dispatch<React.SetStateAction<Mention[]>>>(
    (next) => {
      setMentionsState((prev) => {
        const currentMentions = prev ?? [];
        return typeof next === 'function' ? next(currentMentions) : next;
      });
    },
    [setMentionsState]
  );
  const [pendingSelection, setPendingSelection] = React.useState<MentionSelectionRange | null>(
    null
  );

  const { filterStore, onItemsFilter, getIsItemVisible } = useFilterStore({
    itemMap,
    onFilter,
    exactMatch,
    // Menus rank and slice their own candidates before rendering them, so the
    // built-in scorer must not decide visibility on top of that. Left on, it
    // matched the search term against each item's `value`, which hid every row
    // whose payload happened not to contain the term — an issue row (`#3312`)
    // under a text query — and a hidden row renders null, so its collection
    // entry lost its node and arrow-key movement stopped at the first group.
    manualFiltering: true,
    onCallback: (itemCount) => {
      if (autoCloseOnEmpty && itemCount === 0) {
        // Close the menu if no items match the filter
        setOpen(false);
        setHighlightedItem(null);
        setVirtualAnchor(null);
      }
    },
  });

  const getEnabledItems = React.useCallback(() => {
    return getItems().filter((item) => !item.disabled);
  }, [getItems]);

  const onOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && filterStore.search && filterStore.itemCount === 0) {
        return;
      }
      setOpen(nextOpen);
      if (nextOpen) {
        requestAnimationFrame(() => {
          const items = getEnabledItems();
          const firstItem = items[0] ?? null;
          setHighlightedItem(firstItem);
        });
      } else {
        setHighlightedItem(null);
        setVirtualAnchor(null);
      }
    },
    [setOpen, getEnabledItems, filterStore]
  );

  const { onHighlightMove } = useListHighlighting({
    highlightedItem,
    onHighlightedItemChange: setHighlightedItem,
    getItems: React.useCallback(() => {
      return getItems().filter((item) => !item.disabled && getIsItemVisible(item.value));
    }, [getItems, getIsItemVisible]),
    getIsItemSelected: (item) => value.includes(item.value),
    loop,
  });

  const onMentionAdd = React.useCallback(
    (payloadValue: string, triggerIndex: number, options?: { commit?: boolean }) => {
      const input = inputRef.current;

      const selectedItem = getEnabledItems().find((item) => item.value === payloadValue);
      // A navigation item rewrites the trigger span and keeps the menu open
      // instead of committing. `commit` overrides it, so pressing Enter on a
      // candidate the user already typed out inserts it for real.
      const navigateText = options?.commit ? undefined : selectedItem?.navigateText;
      const isNavigating = navigateText !== undefined;
      // `navigateText`/`insertText` replace everything from the trigger to the
      // caret and carry their own marker; the fallback re-derives it from the
      // active trigger.
      const mentionText =
        navigateText ??
        selectedItem?.insertText ??
        `${trigger}${selectedItem?.label ?? payloadValue}`;
      const suffix = isNavigating ? '' : ' ';
      const sourceValue = input?.value ?? inputValue;
      const beforeTrigger = sourceValue.slice(0, triggerIndex);
      const insertionPoint = input?.selectionStart ?? triggerIndex;
      const afterSearchText = sourceValue.slice(insertionPoint);
      const newValue = `${beforeTrigger}${mentionText}${suffix}${afterSearchText}`;

      const replacedLength = insertionPoint - triggerIndex;
      const insertionLength = mentionText.length + suffix.length;
      const delta = insertionLength - replacedLength;

      const newMention: Mention = {
        value: payloadValue,
        start: triggerIndex,
        end: triggerIndex + mentionText.length,
        kind: selectedItem?.kind ?? 'mention',
      };

      setMentions((prev) => {
        const updatedMentions = prev.map((mention) => {
          if (mention.start >= insertionPoint) {
            return {
              ...mention,
              start: mention.start + delta,
              end: mention.end + delta,
            };
          }
          return mention;
        });
        if (isNavigating) return updatedMentions;
        return [...updatedMentions, newMention].sort((a, b) => a.start - b.start);
      });

      setInputValue(newValue);
      if (!isNavigating) {
        selectedItem?.onMentionSelect?.();
        setValue((prev) => {
          const next = [...(prev ?? [])];
          if (!next.includes(payloadValue)) next.push(payloadValue);
          return next;
        });
      }

      const newCursorPosition = triggerIndex + insertionLength;
      // Request cursor restoration through context instead of mutating input DOM
      // directly. MentionInput applies this in a layout effect after controlled
      // value is committed, which avoids timing races on mobile IME flows.
      setPendingSelection({
        start: newCursorPosition,
        end: newCursorPosition,
        expectedValue: newValue,
      });

      if (isNavigating) {
        // Keep the filter in step with what now sits between the trigger and the
        // caret, so the menu re-filters for the level we just descended into.
        filterStore.search = mentionText.startsWith(trigger)
          ? mentionText.slice(trigger.length)
          : mentionText;
        setOpen(true);
        setHighlightedItem(null);
        requestAnimationFrame(() => onItemsFilter());
      } else {
        setOpen(false);
        setHighlightedItem(null);
        filterStore.search = '';
      }
    },
    [
      trigger,
      setInputValue,
      setMentions,
      setValue,
      setOpen,
      inputValue,
      getEnabledItems,
      filterStore,
      onItemsFilter,
    ]
  );

  const onMentionsRemove = React.useCallback(
    (mentionsToRemove: Mention[]) => {
      const input = inputRef.current;
      setMentions((prev) => {
        // must match their actual order in the text
        const removed = [...mentionsToRemove].sort((a, b) => a.start - b.start);

        const newMentions = prev
          .filter((mention) => {
            const isRemoved = removed.some(
              (m) => m.start === mention.start && m.end === mention.end
            );
            return !isRemoved;
          })
          .map((mention) => {
            // Shift mentions
            const shift = removed
              .filter((r) => r.start < mention.start)
              .reduce((acc, r) => {
                const mentionLength = r.end - r.start;
                const hasTrailingSpace = input?.value[r.end] === ' ';
                return acc + mentionLength + (hasTrailingSpace ? 1 : 0);
              }, 0);

            return {
              ...mention,
              start: mention.start - shift,
              end: mention.end - shift,
            };
          });

        setValue((prevValues) => {
          const valuesInMentions = new Set(
            newMentions
              .filter((mention) => mention.kind !== 'pasted_text')
              .map((mention) => mention.value)
          );
          return (prevValues ?? []).filter((v) => valuesInMentions.has(v));
        });

        return newMentions;
      });
    },
    [setMentions, setValue]
  );

  return (
    <MentionProvider
      open={open}
      onOpenChange={onOpenChange}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
      value={value}
      onValueChange={setValue}
      virtualAnchor={virtualAnchor}
      onVirtualAnchorChange={setVirtualAnchor}
      triggers={triggers}
      trigger={trigger}
      onTriggerChange={setTrigger}
      getEnabledItems={getEnabledItems}
      onItemRegister={onItemRegister}
      filterStore={filterStore}
      onFilter={onFilter}
      onItemsFilter={onItemsFilter}
      getIsItemVisible={getIsItemVisible}
      highlightedItem={highlightedItem}
      onHighlightedItemChange={setHighlightedItem}
      onHighlightMove={onHighlightMove}
      mentions={mentions}
      onMentionsChange={setMentions}
      onMentionAdd={onMentionAdd}
      onMentionsRemove={onMentionsRemove}
      onMentionClick={onMentionClick}
      pendingSelection={pendingSelection}
      onPendingSelectionChange={setPendingSelection}
      dir={dir}
      disabled={disabled}
      exactMatch={exactMatch}
      loop={loop}
      modal={modal}
      readonly={readonly}
      inputRef={inputRef}
      listRef={listRef}
      inputId={inputId}
      labelId={labelId}
      listId={listId}
    >
      <Primitive.div ref={composedRef} {...rootProps}>
        {children}
        {isFormControl && name && (
          <VisuallyHiddenInput
            type="hidden"
            control={collectionRef.current}
            name={name}
            value={value}
            disabled={disabled}
            readOnly={readonly}
            required={required}
          />
        )}
      </Primitive.div>
    </MentionProvider>
  );
});

MentionRoot.displayName = ROOT_NAME;

const Root = MentionRoot;

export { MentionRoot, Root, getDataState, useMentionContext };

export type { ItemData, Mention, MentionKind, MentionRootProps };
