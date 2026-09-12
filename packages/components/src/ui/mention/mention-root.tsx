import { MentionPreparation } from './mention-preparation';
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
import {
  applyMentionSplice,
  resolveMentionInsertPrefix,
  type MentionSplice,
} from './mention-input-core';
import type { InputElement } from './mention-input';
import type { ItemElement } from './mention-item';

function getDataState(open: boolean) {
  return open ? 'open' : 'closed';
}

/** Stable empty list for the range-less splice run; never mutated. */
const EMPTY_MENTIONS: Mention[] = [];

const ROOT_NAME = 'MentionRoot';

type RootElement = React.ElementRef<typeof Primitive.div>;

interface ItemData {
  label: string;
  value: string;
  disabled: boolean;
  onMentionSelect?: () => void;
  /** Resolve an opaque payload before changing any text or range. Null cancels. */
  onMentionPrepare?: MentionPrepare;
  /** Called synchronously when this item is used as a navigation step. */
  onMentionNavigate?: () => void;

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

/**
 * `pasted_text` is the one kind the primitive itself branches on — an external
 * range it renders but never owns. Everything else is an opaque tag the menu
 * chooses, recorded on the range and echoed as `data-mention-kind`, so adding a
 * mention category does not touch this file.
 */
type MentionKind = 'mention' | 'pasted_text' | (string & {});

interface Mention extends Omit<ItemData, 'label' | 'disabled'> {
  start: number;
  end: number;
  kind?: MentionKind;
}

export type PreparedMention = {
  text: string;
  /** Ordinary ranges relative to the inserted text; no range wraps the whole result. */
  mentions: Mention[];
};
export type MentionPrepare = (request: {
  signal: AbortSignal;
  generation: number;
  text: string;
  start: number;
  end: number;
}) => Promise<PreparedMention | null>;

/**
 * A chip decoration for a committed mention range.
 *
 * The highlighter mirrors the textarea character for character, so the caret
 * only stays aligned while every rendered range keeps the *same advance width*
 * as the raw text underneath it. A chip therefore may only paint — background,
 * colour, and an icon drawn over characters the range already contains. It may
 * not add horizontal padding, margin, or border, nor change font size, weight,
 * family, or letter spacing.
 *
 * `iconSlots` and `trailingSlots` are how a chip buys room without buying
 * width: those leading/trailing characters of the range keep their exact boxes
 * and are simply not painted, so the icon sits over the trigger character and
 * the trailing character reads as right padding.
 */
interface MentionChip {
  /** Painted over the range's first `iconSlots` characters. */
  icon?: React.ReactNode;
  /**
   * Chip body classes — colour only, per the width rule above.
   *
   * The primitive supplies the opaque cover that hides the textarea's own
   * glyphs, painted in `--mention-chip-surface`. That variable must be set on
   * whatever container actually paints the background behind the textarea, or
   * the cover reads as a rectangle instead of disappearing into the surface.
   */
  className?: string;
  /** Leading characters of the range surrendered to the icon. @default 1 */
  iconSlots?: number;
  /** Trailing characters of the range left blank as right padding. @default 0 */
  trailingSlots?: number;
}

/**
 * Resolves the chip for a range, or `null` to keep the plain highlight. Product
 * code owns this: the primitive never learns which kinds look like chips.
 */
type MentionChipResolver = (
  mention: Mention,
  /** The range's current text, so a resolver can size its slots from it. */
  text: string
) => MentionChip | null | undefined;

/**
 * A mention written by something other than the menu.
 *
 * The menu is not the only way a mention is born — a drop, or any other gesture
 * that happens outside the input, has to produce the SAME artefact: text plus a
 * committed range. Nothing downstream reconstructs a range from text, so a
 * caller that only appends text writes a mention that silently stops being one.
 *
 * `prefix`/`suffix` are written into the text but stay outside the range, which
 * is how a caller adds separating whitespace without widening the mention.
 */
interface MentionInsertRequest {
  /** Exactly what the committed range covers, marker included (`@fix-ci`). */
  text: string;
  /** Payload recorded on the range. */
  value: string;
  kind?: MentionKind;
  /** Insertion index. @default end of the current value */
  at?: number;
  /**
   * Prefix a single space unless the text already ends in whitespace (or the
   * insert lands at the very start). Resolved against the input's own value, so
   * a caller holding a stale copy of it cannot glue the mention to the previous
   * word.
   */
  separate?: boolean;
  suffix?: string;
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
  cancelMentionPreparation: () => void;
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
  /**
   * Write one or a batch of mentions outside the menu, and take focus.
   * Batch insertion indices refer to the text after preceding entries.
   *
   * Product-neutral by construction: the caller supplies the text, the payload,
   * and the kind, so reaching this from a new mention category does not touch
   * this package.
   */
  onMentionInsert: (request: MentionInsertRequest | MentionInsertRequest[]) => void;
  /**
   * Pop the text between the trigger and the caret back to the bare trigger,
   * undoing one drill-down step. Returns false when there is no trigger to pop
   * back to. The caller decides *when* this applies (Backspace on a namespace
   * prefix, the menu's Back button); the transaction itself lives here because
   * it has to interleave the controlled value commit with caret restoration.
   */
  onNavigateBack: () => boolean;
  onMentionsRemove: (mentionsToRemove: Mention[]) => void;
  onMentionClick?: (mention: Mention) => void;
  getMentionChip?: MentionChipResolver;
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
   * Resolves the chip decoration for a rendered range. Ranges without a chip
   * keep the plain inline highlight.
   */
  getMentionChip?: MentionChipResolver;

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

/**
 * A functional setter whose `prev` is the last value *written*, not the last
 * value rendered.
 *
 * `useControllableState` resolves an updater against the controlled prop, and
 * that prop only moves when the owner re-renders. So two updates in one commit
 * — the hydrators, which all run their effects in the same flush — each see the
 * pre-flush value, and the last one silently replaces the others instead of
 * merging with them. A draft holding a `@file` and an `@session` came back from
 * a remount with whichever hydrator happened to render last.
 *
 * The ref carries the pending value across that gap and is re-synced from the
 * rendered value on every render, so an owner that rejects or rewrites an
 * update still wins the next frame.
 */
function useFlushConsistentState<T>(
  current: T,
  setState: (next: T) => void
): React.Dispatch<React.SetStateAction<T>> {
  const pendingRef = React.useRef(current);
  pendingRef.current = current;
  return React.useCallback(
    (next) => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(pendingRef.current) : next;
      pendingRef.current = resolved;
      setState(resolved);
    },
    [setState]
  );
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
    getMentionChip,
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
  const [value = [], setValueState] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue,
    onChange: onValueChange,
  });
  const setValue = useFlushConsistentState<string[] | undefined>(value, setValueState);
  const preparation = React.useRef(new MentionPreparation()).current;
  React.useEffect(() => () => preparation.cancel(), [preparation]);
  const observedInput = React.useRef({ inputValueProp, disabled, readonly });
  if (
    observedInput.current.inputValueProp !== inputValueProp ||
    observedInput.current.disabled !== disabled ||
    observedInput.current.readonly !== readonly
  ) {
    preparation.cancel();
    observedInput.current = { inputValueProp, disabled, readonly };
  }
  const [inputValue = '', setInputValueState] = useControllableState({
    prop: inputValueProp,
    defaultProp: '',
    onChange: onInputValueChange,
  });
  const setInputValue = React.useCallback(
    (next: string) => {
      preparation.cancel();
      setInputValueState(next);
    },
    [preparation, setInputValueState]
  );
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
  const mentions = mentionsState ?? EMPTY_MENTIONS;
  const setMentions = useFlushConsistentState(mentions, setMentionsState);
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
      if (!nextOpen) preparation.cancel();
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
    [setOpen, getEnabledItems, filterStore, preparation]
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

      const selectedItem = getItems().find((item) => item.value === payloadValue);
      // A disabled registered item must not fall through to free-form insertion.
      if (selectedItem?.disabled) return;
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
      const sourceValue = input?.value ?? inputValue;
      const insertionPoint = input?.selectionStart ?? triggerIndex;
      const commit = (prepared: PreparedMention | null = null) => {
        const committedValue = payloadValue;
        const splice: MentionSplice = {
          replaceStart: triggerIndex,
          replaceEnd: insertionPoint,
          text: prepared?.text ?? mentionText,
          suffix: isNavigating || prepared ? '' : ' ',
          value: committedValue,
          kind: selectedItem?.kind,
          commitRange: !isNavigating && !prepared,
          mentions: prepared?.mentions,
        };

        // The text and caret do not depend on the existing ranges, so they are
        // read from a range-less run rather than smuggled out of the updater —
        // the updater stays pure, and `setMentions` keeps the functional form its
        // flush-consistency contract requires.
        const { value: newValue, caret: newCursorPosition } = applyMentionSplice(
          sourceValue,
          EMPTY_MENTIONS,
          splice
        );
        setMentions((prev) => applyMentionSplice(sourceValue, prev, splice).mentions);

        setInputValue(newValue);
        if (isNavigating) {
          // Start work required by the destination before React commits the
          // rewritten trigger text. View-derived activation remains as a fallback
          // for typed/pasted navigation prefixes and direct triggers.
          selectedItem?.onMentionNavigate?.();
        } else {
          selectedItem?.onMentionSelect?.();
          setValue((prev) => {
            const next = [...(prev ?? [])];
            for (const insertedValue of prepared
              ? prepared.mentions.map((mention) => mention.value)
              : [committedValue]) {
              if (!next.includes(insertedValue)) next.push(insertedValue);
            }
            return next;
          });
        }

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
      };
      if (!isNavigating && selectedItem?.onMentionPrepare) {
        if (disabled || readonly) return;
        const ticket = preparation.begin();
        void selectedItem
          .onMentionPrepare({
            signal: ticket.signal,
            generation: ticket.generation,
            text: sourceValue,
            start: triggerIndex,
            end: insertionPoint,
          })
          .then((prepared) => {
            if (ticket.isCurrent() && prepared) commit(prepared);
          })
          .catch(() => {
            // The source owns error/retry presentation. Failure never inserts a range.
          });
        return;
      }
      commit();
      return;
    },
    [
      trigger,
      preparation,
      disabled,
      readonly,
      setInputValue,
      setMentions,
      setValue,
      setOpen,
      inputValue,
      getItems,
      filterStore,
      onItemsFilter,
    ]
  );

  const onMentionInsert = React.useCallback(
    (request: MentionInsertRequest | MentionInsertRequest[]) => {
      const requests = Array.isArray(request) ? request : [request];
      if (requests.length === 0) return;
      const input = inputRef.current;
      const sourceValue = input?.value ?? inputValue;
      // Every insert reads the result of the previous one, then the controlled
      // text and ranges are published once for the entire gesture.
      const applyRequests = (initialMentions: Mention[]) => {
        let result = { value: sourceValue, mentions: initialMentions, caret: sourceValue.length };
        for (const entry of requests) {
          const at = Math.max(0, Math.min(result.value.length, entry.at ?? result.value.length));
          result = applyMentionSplice(result.value, result.mentions, {
            replaceStart: at,
            replaceEnd: at,
            prefix: resolveMentionInsertPrefix(result.value, at, entry.separate),
            text: entry.text,
            suffix: entry.suffix,
            value: entry.value,
            kind: entry.kind,
            commitRange: true,
          });
        }
        return result;
      };

      const { value: newValue, caret } = applyRequests(EMPTY_MENTIONS);
      setMentions((prev) => applyRequests(prev).mentions);
      setInputValue(newValue);
      setValue((prev) => {
        const next = [...(prev ?? [])];
        for (const entry of requests) {
          if (!next.includes(entry.value)) next.push(entry.value);
        }
        return next;
      });
      setPendingSelection({ start: caret, end: caret, expectedValue: newValue });
      // An open menu was anchored to a trigger span that just moved, and the
      // caret is no longer in it. Same teardown a commit does.
      setOpen(false);
      setHighlightedItem(null);
      filterStore.search = '';
      // The gesture that inserts this happened outside the input (a drop, a
      // toolbar action), so the caret restoration above lands on an input the
      // user is not in. Typing is the expected next step, so take focus.
      input?.focus();
    },
    [filterStore, inputValue, setInputValue, setMentions, setOpen, setValue]
  );

  const onNavigateBack = React.useCallback(() => {
    const input = inputRef.current;
    if (!input) return false;
    const caretPosition = input.selectionStart ?? input.value.length;
    const triggerIndex = input.value.lastIndexOf(trigger, caretPosition);
    if (triggerIndex === -1) return false;

    const caret = triggerIndex + trigger.length;
    const nextValue = input.value.slice(0, caret) + input.value.slice(caretPosition);
    setInputValue(nextValue);
    // Same reason as `onMentionAdd`: MentionInput restores the caret once it has
    // rendered this exact value, because touching the DOM selection here races
    // the controlled value commit.
    setPendingSelection({ start: caret, end: caret, expectedValue: nextValue });
    filterStore.search = '';
    setHighlightedItem(null);
    requestAnimationFrame(() => onItemsFilter());
    return true;
  }, [filterStore, onItemsFilter, setInputValue, trigger]);

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
      cancelMentionPreparation={preparation.cancel}
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
      onMentionInsert={onMentionInsert}
      onNavigateBack={onNavigateBack}
      onMentionsRemove={onMentionsRemove}
      onMentionClick={onMentionClick}
      getMentionChip={getMentionChip}
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

export type {
  ItemData,
  Mention,
  MentionChip,
  MentionChipResolver,
  MentionInsertRequest,
  MentionKind,
  MentionRootProps,
};
