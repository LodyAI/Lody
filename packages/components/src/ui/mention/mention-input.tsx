import { composeEventHandlers, Primitive, useComposedRefs } from '@diceui/shared';
import type { VirtualElement } from '@floating-ui/react';
import * as React from 'react';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import {
  applyTextEditToMentions,
  areMentionsEqual,
  areStringArraysEqual,
  findAdjacentMentionForHorizontalNavigation,
  findMentionBeforeCursorForDeletion,
  getMentionValuesFromMentions,
  getTextDiff,
  removeMentionText,
} from './mention-input-core';
import { MentionHighlighter } from './mention-highlighter';
import { findTriggerCandidates, isMentionNavigationPrefix } from './mention-trigger';
import { type Mention, useMentionContext } from './mention-root';

const INPUT_NAME = 'MentionInput';

type InputElement = React.ElementRef<typeof Primitive.textarea>;

type PendingSelection = {
  start: number;
  end: number;
  expectedValue?: string;
};

type VirtualAnchorSnapshot = {
  element: InputElement;
  cursorPosition: number;
  anchor: VirtualElement;
};

function normalizeTextareaValue(
  value: React.ComponentPropsWithoutRef<typeof Primitive.textarea>['value']
): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (Array.isArray(value)) return value.join('\n');
  return String(value);
}

function isPointInsideMentionHighlight(
  input: InputElement,
  mention: Mention,
  clientX: number,
  clientY: number
) {
  const highlighter = input.parentElement?.querySelector<HTMLElement>(
    '[data-mention-highlighter="true"]'
  );
  if (!highlighter) return false;

  const mentionKind = mention.kind ?? 'mention';
  const mentionElements = highlighter.querySelectorAll<HTMLElement>('[data-mention-start]');

  for (const element of mentionElements) {
    if (
      Number(element.dataset.mentionStart) !== mention.start ||
      Number(element.dataset.mentionEnd) !== mention.end ||
      element.dataset.mentionKind !== mentionKind ||
      element.dataset.mentionValue !== mention.value
    ) {
      continue;
    }

    for (const rect of element.getClientRects()) {
      if (
        clientX >= rect.left - 1 &&
        clientX <= rect.right + 1 &&
        clientY >= rect.top - 1 &&
        clientY <= rect.bottom + 1
      ) {
        return true;
      }
    }
  }

  return false;
}

interface MentionInputProps extends React.ComponentPropsWithoutRef<typeof Primitive.textarea> {
  containerClassName?: string;
  highlighterClassName?: string;
}

const MentionInput = React.forwardRef<InputElement, MentionInputProps>((props, forwardedRef) => {
  const context = useMentionContext(INPUT_NAME);
  const composedRef = useComposedRefs(forwardedRef, context.inputRef);
  const { containerClassName, highlighterClassName, ...inputProps } = props;
  const pendingSelectionFromRoot = context.pendingSelection;
  const onPendingSelectionFromRootChange = context.onPendingSelectionChange;
  const inputRef = context.inputRef;
  const inputValue = context.inputValue;

  const pendingSelectionRef = React.useRef<PendingSelection | null>(null);
  const virtualAnchorSnapshotRef = React.useRef<VirtualAnchorSnapshot | null>(null);
  // Simplified IME handling: only track if we're in composition, ignore all updates
  // during composition, and sync the final value after composition ends.
  const isComposingRef = React.useRef(false);
  const [compositionRenderValue, setCompositionRenderValue] = React.useState<string | null>(null);

  const normalizedPropValue = React.useMemo(
    () => normalizeTextareaValue(inputProps.value),
    [inputProps.value]
  );

  // Sync compositionRenderValue with external value when they match.
  React.useLayoutEffect(() => {
    if (compositionRenderValue === null) return;
    if (normalizedPropValue === compositionRenderValue) {
      setCompositionRenderValue(null);
    }
  }, [compositionRenderValue, normalizedPropValue]);

  const renderedInputValue = compositionRenderValue ?? normalizedPropValue;

  const queueSelectionRestore = React.useCallback(
    (start: number, end: number = start, expectedValue?: string) => {
      // Selection is restored by a layout effect, not immediately in handlers.
      // This keeps cursor moves deterministic across desktop/mobile where
      // controlled value commits can land in slightly different event phases.
      pendingSelectionRef.current = { start, end, expectedValue };
    },
    []
  );

  React.useLayoutEffect(() => {
    if (pendingSelectionFromRoot) {
      // MentionRoot cannot safely mutate DOM selection directly because its
      // state updates and the input's controlled value commit may be out of sync.
      // We consume root-issued selection requests here and apply them only after
      // the textarea reflects the expected value.
      pendingSelectionRef.current = pendingSelectionFromRoot;
      onPendingSelectionFromRootChange(null);
    }

    const pending = pendingSelectionRef.current;
    if (!pending) return;

    const input = inputRef.current;
    if (!input) return;

    if (pending.expectedValue !== undefined && input.value !== pending.expectedValue) {
      return;
    }

    pendingSelectionRef.current = null;

    const max = input.value.length;
    const start = Math.max(0, Math.min(max, pending.start));
    const end = Math.max(0, Math.min(max, pending.end));
    input.setSelectionRange(start, end);
  }, [inputRef, inputValue, onPendingSelectionFromRootChange, pendingSelectionFromRoot]);

  const getTextWidth = React.useCallback((text: string, input: InputElement) => {
    const style = window.getComputedStyle(input);
    const measureSpan = document.createElement('span');
    measureSpan.style.cssText = `
        position: absolute;
        visibility: hidden;
        white-space: pre;
        font: ${style.font};
        letter-spacing: ${style.letterSpacing};
        text-transform: ${style.textTransform};
      `;
    measureSpan.textContent = text;
    document.body.appendChild(measureSpan);
    const width = measureSpan.offsetWidth;
    document.body.removeChild(measureSpan);
    return width;
  }, []);

  const getLineHeight = React.useCallback((input: InputElement) => {
    const style = window.getComputedStyle(input);
    return Number.parseInt(style.lineHeight, 10) ?? input.offsetHeight;
  }, []);

  const calculatePosition = React.useCallback(
    (input: InputElement, cursorPosition: number) => {
      const rect = input.getBoundingClientRect();
      const textBeforeCursor = input.value.slice(0, cursorPosition);
      const lines = textBeforeCursor.split('\n');
      const currentLine = lines.length - 1;
      const currentLineText = lines[currentLine] ?? '';
      const textWidth = getTextWidth(currentLineText, input);

      const style = window.getComputedStyle(input);
      const lineHeight = getLineHeight(input);
      const paddingLeft = Number.parseFloat(style.getPropertyValue('padding-left') ?? '0');
      const paddingRight = Number.parseFloat(style.getPropertyValue('padding-right') ?? '0');
      const paddingTop = Number.parseFloat(style.getPropertyValue('padding-top') ?? '0');

      const containerWidth = input.clientWidth - paddingLeft - paddingRight;
      const wrappedLines = Math.floor(textWidth / containerWidth);
      const totalLines = currentLine + wrappedLines;

      const scrollTop = input.scrollTop;
      const scrollLeft = input.scrollLeft;

      const effectiveTextWidth = textWidth % containerWidth;
      const isRTL = context.dir === 'rtl';
      const x = isRTL
        ? Math.min(rect.right - paddingRight - effectiveTextWidth + scrollLeft, rect.right - 10)
        : Math.min(rect.left + paddingLeft + effectiveTextWidth - scrollLeft, rect.right - 10);

      const y = rect.top + paddingTop + (totalLines * lineHeight - scrollTop);

      return {
        width: 0,
        height: lineHeight,
        x,
        y,
        top: y,
        right: x,
        bottom: y + lineHeight,
        left: x,
        toJSON() {
          return this;
        },
      } satisfies DOMRect;
    },
    [context.dir, getLineHeight, getTextWidth]
  );

  const createVirtualElement = React.useCallback(
    (element: InputElement, cursorPosition: number) => {
      const currentAnchor = virtualAnchorSnapshotRef.current;
      if (currentAnchor?.element === element && currentAnchor.cursorPosition === cursorPosition) {
        if (context.virtualAnchor !== currentAnchor.anchor) {
          context.onVirtualAnchorChange(currentAnchor.anchor);
        }
        return;
      }

      const virtualElement: VirtualElement = {
        getBoundingClientRect() {
          return calculatePosition(element, cursorPosition);
        },
        getClientRects() {
          const rect = this.getBoundingClientRect();
          const rects = [rect];
          Object.defineProperty(rects, 'item', {
            value: function item(index: number) {
              return this[index];
            },
          });
          return rects;
        },
      };

      virtualAnchorSnapshotRef.current = {
        element,
        cursorPosition,
        anchor: virtualElement,
      };
      context.onVirtualAnchorChange(virtualElement);
    },
    [calculatePosition, context]
  );

  const onMentionUpdate = React.useCallback(
    (element: InputElement, selectionStart: number | null = null) => {
      if (context.disabled || context.readonly) return false;
      if (isComposingRef.current) return false;

      const currentPosition = selectionStart ?? element.selectionStart;
      if (currentPosition === null) return false;

      const value = element.value;
      const candidates = findTriggerCandidates(value, context.triggers, currentPosition);

      for (const { trigger, index: lastTriggerIndex } of candidates) {
        const mentionAtTrigger = context.mentions.find(
          (mention) => mention.start <= lastTriggerIndex && mention.end > lastTriggerIndex
        );

        const isDirectoryMentionAtEnd =
          mentionAtTrigger?.value.endsWith('/') && currentPosition === mentionAtTrigger.end;
        const isPartOfExistingMention = Boolean(mentionAtTrigger) && !isDirectoryMentionAtEnd;
        if (isPartOfExistingMention) {
          continue;
        }

        function isTriggerPartOfText() {
          if (trigger === '#') return false;
          const textBeforeTrigger = value.slice(0, lastTriggerIndex);
          const hasTextBeforeTrigger = /\S/.test(textBeforeTrigger);
          if (!hasTextBeforeTrigger) return false;
          const lastCharBeforeTrigger = textBeforeTrigger.slice(-1);
          return lastCharBeforeTrigger !== ' ' && lastCharBeforeTrigger !== '\n';
        }

        if (isTriggerPartOfText()) {
          continue;
        }

        const textAfterTrigger = value.slice(lastTriggerIndex + trigger.length, currentPosition);
        const isValidMention = !/\s/.test(textAfterTrigger);
        const isCursorAfterTrigger = currentPosition > lastTriggerIndex;
        const isImmediatelyAfterTrigger = currentPosition === lastTriggerIndex + trigger.length;

        const textAfterCursor = value.slice(currentPosition);
        const firstCharAfterCursor = textAfterCursor[0];
        const isTextAfterCursorSeparated =
          !firstCharAfterCursor ||
          firstCharAfterCursor === ' ' ||
          firstCharAfterCursor === '\n' ||
          context.triggers.includes(firstCharAfterCursor);

        const isTextAfterCursorPartOfMention = context.mentions.some(
          (mention) => currentPosition >= mention.start && currentPosition < mention.end
        );

        const hasInterferingText =
          textAfterCursor.length > 0 &&
          !isTextAfterCursorSeparated &&
          !isTextAfterCursorPartOfMention;

        if (hasInterferingText) {
          continue;
        }

        if (isValidMention && (isCursorAfterTrigger || isImmediatelyAfterTrigger)) {
          if (context.trigger !== trigger) {
            context.onTriggerChange(trigger);
          }

          createVirtualElement(element, lastTriggerIndex);
          context.onOpenChange(true);
          context.filterStore.search = isImmediatelyAfterTrigger ? '' : textAfterTrigger;
          requestAnimationFrame(() => context.onItemsFilter());
          return true;
        }
      }

      if (context.open) {
        context.onOpenChange(false);
        context.onHighlightedItemChange(null);
        context.filterStore.search = '';
      }

      return false;
    },
    [context, createVirtualElement]
  );

  const syncResolvedInputValue = React.useCallback(
    (newValue: string) => {
      const prevValue = context.inputValue;
      const diff = getTextDiff(prevValue, newValue);

      if (diff) {
        const nextMentions = applyTextEditToMentions(
          context.mentions,
          diff.start,
          diff.prevEnd,
          diff.delta
        );

        if (!areMentionsEqual(context.mentions, nextMentions)) {
          context.onMentionsChange(nextMentions);
        }

        const nextMentionValues = getMentionValuesFromMentions(nextMentions);
        if (!areStringArraysEqual(context.value, nextMentionValues)) {
          context.onValueChange(nextMentionValues);
        }
      }

      context.onInputValueChange?.(newValue);
    },
    [context]
  );

  const syncInputValue = React.useCallback(
    (input: InputElement) => {
      syncResolvedInputValue(input.value);
    },
    [syncResolvedInputValue]
  );

  const applyInputValue = React.useCallback(
    (
      nextValue: string,
      selectionStart: number,
      options?: {
        mentionsToRemove?: Mention[];
      }
    ) => {
      if (options?.mentionsToRemove?.length) {
        context.onMentionsRemove(options.mentionsToRemove);
      }

      context.onInputValueChange?.(nextValue);
      queueSelectionRestore(selectionStart, selectionStart, nextValue);
    },
    [context, queueSelectionRestore]
  );

  const onChange = React.useCallback(
    (event: React.ChangeEvent<InputElement>) => {
      if (context.disabled || context.readonly) return;

      const input = event.currentTarget;

      // Check if we're truly in composition.
      // - isComposingRef tracks our internal state based on compositionStart/End
      // - nativeEvent.isComposing is the browser's flag
      //
      // Some IMEs may have mismatch:
      // - During composition: both should be true
      // - After compositionEnd: isComposingRef=false, but nativeEvent.isComposing
      //   may still be true for the first few events
      //
      // We trust isComposingRef more because it's based on the explicit events.
      const trulyComposing = isComposingRef.current;

      // During composition: only update local render value, don't sync to parent.
      if (trulyComposing) {
        setCompositionRenderValue(input.value);
        return;
      }

      // After composition ends: sync the final value to parent.
      syncInputValue(input);
      onMentionUpdate(input);
    },
    [context, onMentionUpdate, syncInputValue]
  );

  const onCompositionStart = React.useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const onCompositionEnd = React.useCallback(
    (event: React.CompositionEvent<InputElement>) => {
      if (context.disabled || context.readonly) return;

      const input = event.currentTarget;
      isComposingRef.current = false;

      // Always update local render value to match DOM.
      setCompositionRenderValue(input.value);

      // Always sync the value after composition ends.
      // The value at compositionEnd should be the final committed text.
      syncInputValue(input);
      onMentionUpdate(input);
    },
    [context, onMentionUpdate, syncInputValue]
  );

  const onClick = React.useCallback(
    (event: React.MouseEvent<InputElement>) => {
      const input = event.currentTarget;
      onMentionUpdate(input);

      if (!context.onMentionClick) return;

      const selectionStart = input.selectionStart ?? 0;
      const selectionEnd = input.selectionEnd ?? selectionStart;
      if (selectionStart !== selectionEnd) return;

      const mentionAtCursor = context.mentions.find(
        (mention) => selectionStart >= mention.start && selectionStart <= mention.end
      );

      if (
        mentionAtCursor &&
        isPointInsideMentionHighlight(input, mentionAtCursor, event.clientX, event.clientY)
      ) {
        context.onMentionClick(mentionAtCursor);
      }
    },
    [context, onMentionUpdate]
  );

  const onFocus = React.useCallback(
    (event: React.FocusEvent<InputElement>) => {
      onMentionUpdate(event.currentTarget);
    },
    [onMentionUpdate]
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<InputElement>) => {
      if (isImeComposingKeyboardEvent(event)) {
        return;
      }

      const input = event.currentTarget;
      const cursorPosition = input.selectionStart ?? 0;
      const selectionEnd = input.selectionEnd ?? cursorPosition;
      const hasSelection = cursorPosition !== selectionEnd;

      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        !hasSelection &&
        !event.shiftKey
      ) {
        const isCtrlOrCmd = event.metaKey || event.ctrlKey;
        const direction = event.key === 'ArrowLeft' ? 'left' : 'right';

        const adjacentMention = findAdjacentMentionForHorizontalNavigation({
          mentions: context.mentions,
          value: input.value,
          cursorPosition,
          direction,
          isWordJump: isCtrlOrCmd,
        });

        if (adjacentMention) {
          event.preventDefault();
          const newPosition = isCtrlOrCmd
            ? direction === 'left'
              ? adjacentMention.start
              : adjacentMention.end
            : direction === 'left'
              ? cursorPosition > adjacentMention.end
                ? adjacentMention.end
                : adjacentMention.start
              : cursorPosition < adjacentMention.start
                ? adjacentMention.start
                : adjacentMention.end;

          input.setSelectionRange(newPosition, newPosition);
          return;
        }

        if (isCtrlOrCmd) {
          return;
        }
      }

      if (event.key === 'Backspace' && !context.open && !hasSelection) {
        const isCtrlOrCmd = event.metaKey || event.ctrlKey;

        const mentionBeforeCursor = findMentionBeforeCursorForDeletion({
          mentions: context.mentions,
          value: input.value,
          cursorPosition,
          isCtrlOrCmd,
        });

        if (mentionBeforeCursor) {
          const hasTrailingSpace = input.value[mentionBeforeCursor.end] === ' ';
          const isCursorInsideMention =
            cursorPosition > mentionBeforeCursor.start && cursorPosition <= mentionBeforeCursor.end;

          if (isCursorInsideMention || isCtrlOrCmd) {
            event.preventDefault();
            const newValue = removeMentionText(input.value, mentionBeforeCursor, hasTrailingSpace);
            applyInputValue(newValue, mentionBeforeCursor.start, {
              mentionsToRemove: [mentionBeforeCursor],
            });
            return;
          }

          if (hasTrailingSpace && cursorPosition === mentionBeforeCursor.end + 1 && !isCtrlOrCmd) {
            event.preventDefault();
            const newValue =
              input.value.slice(0, mentionBeforeCursor.end) +
              input.value.slice(mentionBeforeCursor.end + 1);
            applyInputValue(newValue, mentionBeforeCursor.end);
            return;
          }

          event.preventDefault();
          const newValue = removeMentionText(input.value, mentionBeforeCursor, hasTrailingSpace);
          applyInputValue(newValue, mentionBeforeCursor.start, {
            mentionsToRemove: [mentionBeforeCursor],
          });
          return;
        }
      }

      if (!context.open) return;

      const isNavigationKey = [
        'ArrowDown',
        'ArrowUp',
        'Enter',
        'Escape',
        'Tab',
        'Home',
        'End',
      ].includes(event.key);

      if (isNavigationKey && event.key !== 'Tab') {
        event.preventDefault();
      }

      function onMenuClose() {
        context.onOpenChange(false);
        context.onHighlightedItemChange(null);
        context.filterStore.search = '';
      }

      function getTriggerSpan() {
        const triggerIndex = input.value.lastIndexOf(context.trigger, cursorPosition);
        if (triggerIndex === -1) return null;
        return {
          triggerIndex,
          search: input.value.slice(triggerIndex + context.trigger.length, cursorPosition),
        };
      }

      // `highlightedItem` can be a partial snapshot created on hover, so read
      // navigation data off the registered item instead.
      function getRegisteredItem(value: string) {
        return context.getEnabledItems().find((item) => item.value === value) ?? null;
      }

      /** Descend into the highlighted navigation item, if it is one. */
      function tryNavigateInto() {
        if (hasSelection || event.shiftKey) return false;
        const highlighted = context.highlightedItem;
        if (!highlighted) return false;
        const registered = getRegisteredItem(highlighted.value);
        if (!registered?.navigateText) return false;
        const span = getTriggerSpan();
        if (!span) return false;
        context.onMentionAdd(registered.value, span.triggerIndex);
        return true;
      }

      /** Pop a `@ns:` category prefix back to the bare trigger in one keystroke. */
      function tryNavigateBack() {
        if (hasSelection || event.shiftKey) return false;
        const span = getTriggerSpan();
        if (!span || !isMentionNavigationPrefix(span.search)) return false;
        return context.onNavigateBack();
      }

      switch (event.key) {
        case 'Enter': {
          const span = getTriggerSpan();
          if (!span) {
            onMenuClose();
            return;
          }

          const searchText = span.search;
          const exactMatchItem =
            searchText.length > 0
              ? context.getEnabledItems().find((item) => item.label === searchText)
              : null;

          const selectedItem = context.highlightedItem ?? exactMatchItem;
          if (!selectedItem) {
            onMenuClose();
            return;
          }

          event.preventDefault();
          // Enter on a navigation item the user has already typed out in full
          // commits it rather than descending again: typing `@src/` then Enter
          // inserts `@src`.
          const registeredItem = getRegisteredItem(selectedItem.value) ?? selectedItem;
          const shouldCommit =
            Boolean(registeredItem.navigateText) && registeredItem.label === searchText;

          context.onMentionAdd(selectedItem.value, span.triggerIndex, {
            commit: shouldCommit,
          });
          break;
        }
        case 'Tab': {
          if (tryNavigateInto()) {
            event.preventDefault();
            break;
          }
          if (context.modal) event.preventDefault();
          onMenuClose();
          break;
        }
        case 'ArrowRight': {
          if (tryNavigateInto()) event.preventDefault();
          break;
        }
        case 'ArrowLeft': {
          if (tryNavigateBack()) event.preventDefault();
          break;
        }
        case 'Backspace': {
          if (tryNavigateBack()) event.preventDefault();
          break;
        }
        case 'ArrowDown': {
          if (context.readonly) return;
          context.onHighlightMove(context.highlightedItem ? 'next' : 'first');
          break;
        }
        case 'ArrowUp': {
          if (context.readonly) return;
          context.onHighlightMove(context.highlightedItem ? 'prev' : 'last');
          break;
        }
        case 'Home': {
          if (event.metaKey || event.ctrlKey) return;
          if (context.readonly) return;
          event.preventDefault();
          context.onHighlightMove('first');
          break;
        }
        case 'End': {
          if (event.metaKey || event.ctrlKey) return;
          if (context.readonly) return;
          event.preventDefault();
          context.onHighlightMove('last');
          break;
        }
        case 'Escape': {
          onMenuClose();
          event.stopPropagation();
          break;
        }
      }
    },
    [applyInputValue, context]
  );

  const onBeforeInput = React.useCallback(
    (event: React.FormEvent<InputElement> & { inputType?: string }) => {
      if (context.disabled || context.readonly) return;
      const input = event.currentTarget;
      const cursorPosition = input.selectionStart ?? 0;

      if (event.inputType === 'deleteContentBackward') {
        const mentionAtCursor = context.mentions.find(
          (mention) => cursorPosition > mention.start && cursorPosition <= mention.end
        );

        if (mentionAtCursor) {
          event.preventDefault();
          const hasTrailingSpace = input.value[mentionAtCursor.end] === ' ';
          const newValue = removeMentionText(input.value, mentionAtCursor, hasTrailingSpace);

          applyInputValue(newValue, mentionAtCursor.start, {
            mentionsToRemove: [mentionAtCursor],
          });
        }
      }
    },
    [applyInputValue, context]
  );

  const onSelect = React.useCallback(() => {
    if (context.disabled || context.readonly) return;
    const inputElement = context.inputRef.current;
    if (!inputElement) return;
    onMentionUpdate(inputElement);
  }, [context, onMentionUpdate]);

  return (
    <div className={cn('relative', containerClassName)}>
      <MentionHighlighter className={highlighterClassName} />
      <Primitive.textarea
        role="combobox"
        id={context.inputId}
        autoComplete="off"
        aria-expanded={context.open}
        aria-controls={context.listId}
        aria-labelledby={context.labelId}
        aria-autocomplete="list"
        aria-activedescendant={context.highlightedItem?.ref.current?.id}
        aria-disabled={context.disabled}
        aria-readonly={context.readonly}
        disabled={context.disabled}
        readOnly={context.readonly}
        dir={context.dir}
        {...inputProps}
        ref={composedRef}
        value={renderedInputValue}
        className={cn('relative z-10', inputProps.className, 'bg-transparent')}
        onBeforeInput={composeEventHandlers(inputProps.onBeforeInput, onBeforeInput)}
        onChange={composeEventHandlers(inputProps.onChange, onChange)}
        onClick={composeEventHandlers(inputProps.onClick, onClick)}
        onFocus={composeEventHandlers(inputProps.onFocus, onFocus)}
        onKeyDown={composeEventHandlers(onKeyDown, inputProps.onKeyDown)}
        onCompositionStart={composeEventHandlers(inputProps.onCompositionStart, onCompositionStart)}
        onCompositionEnd={composeEventHandlers(inputProps.onCompositionEnd, onCompositionEnd)}
        onSelect={composeEventHandlers(inputProps.onSelect, onSelect)}
      />
    </div>
  );
});

MentionInput.displayName = INPUT_NAME;

const Input = MentionInput;

export { Input, MentionInput };

export type { InputElement, MentionInputProps };
