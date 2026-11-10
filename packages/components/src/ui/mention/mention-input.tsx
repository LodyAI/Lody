import { composeEventHandlers, useComposedRefs } from '@diceui/shared';
import type { VirtualElement } from '@floating-ui/react';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { registerPlainText } from '@lexical/plain-text';
import { mergeRegister } from '@lexical/utils';
import {
  COMMAND_PRIORITY_CRITICAL,
  COPY_COMMAND,
  CUT_COMMAND,
  createEditor,
  DELETE_CHARACTER_COMMAND,
  DROP_COMMAND,
  HISTORY_MERGE_TAG,
  KEY_DOWN_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  UNDO_COMMAND,
  type LexicalEditor,
} from 'lexical';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { getPlatform } from '@/lib/commands/platform';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import {
  $offsetToPoint,
  $readComposerValue,
  $readMentionOffsets,
  $readSelectionOffsets,
  $setSelectionOffsets,
  $writeComposerValue,
  sanitizeComposerMentions,
} from './composer-document';
import {
  type ComposerController,
  type ComposerInputElement,
  type ComposerSelection,
  registerComposerController,
} from './composer-input';
import { MentionRangeView } from './mention-chip-content';
import {
  areMentionsEqual,
  areStringArraysEqual,
  findAdjacentMentionForHorizontalNavigation,
  findMentionBeforeCursorForDeletion,
  getMentionValuesFromMentions,
  removeMentionText,
} from './mention-input-core';
import { type MentionDecoration, MentionDecoratorNode } from './mention-node';
import { findTriggerCandidates, isMentionNavigationPrefix } from './mention-trigger';
import { type Mention, useMentionContext } from './mention-root';

const INPUT_NAME = 'MentionInput';

/** Updates that copy the owner's value into the editor. They are not edits. */
const SYNC_TAG = 'lody-composer-sync';

type InputElement = ComposerInputElement;

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

type HorizontalCaretMove = { direction: 'left' | 'right'; isWordJump: boolean };

const MAC_EMACS_CHARACTER_MOVES: Readonly<Record<string, HorizontalCaretMove['direction']>> = {
  b: 'left',
  f: 'right',
};

function getHorizontalCaretMove(
  event: React.KeyboardEvent<InputElement>
): HorizontalCaretMove | null {
  if (event.shiftKey) return null;

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    return {
      direction: event.key === 'ArrowLeft' ? 'left' : 'right',
      isWordJump: event.metaKey || event.ctrlKey,
    };
  }

  // Other macOS Emacs bindings move by line or change text. Only B/F have the
  // same one-character movement as the arrows at an atomic mention edge.
  const direction = MAC_EMACS_CHARACTER_MOVES[event.key];
  if (!direction || !event.ctrlKey || event.metaKey || event.altKey || getPlatform() !== 'mac') {
    return null;
  }
  return { direction, isWordJump: false };
}

type ComposerDocument = { text: string; mentions: Mention[] };

const EMPTY_DOCUMENT: ComposerDocument = { text: '', mentions: [] };

function isSameDocument(left: ComposerDocument, right: ComposerDocument) {
  return left.text === right.text && areMentionsEqual(left.mentions, right.mentions);
}

function isSameSelection(left: ComposerSelection | null, right: ComposerSelection | null) {
  return left?.start === right?.start && left?.end === right?.end;
}

function hasFiles(dataTransfer: DataTransfer | null | undefined) {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files');
}

/** A DOM range over the editor for composer-string offsets. */
function createDomRange(editor: LexicalEditor, start: number, end: number): Range | null {
  return editor.getEditorState().read(() => {
    const toDom = (offset: number): [Node, number] | null => {
      const point = $offsetToPoint(offset);
      const element = editor.getElementByKey(point.key);
      if (!element) return null;
      if (point.type === 'text') {
        const textNode = element.firstChild;
        if (!textNode) return null;
        return [textNode, Math.min(point.offset, textNode.textContent?.length ?? 0)];
      }
      return [element, Math.min(point.offset, element.childNodes.length)];
    };
    const from = toDom(start);
    const to = start === end ? from : toDom(end);
    if (!from || !to) return null;
    const range = document.createRange();
    range.setStart(from[0], from[1]);
    range.setEnd(to[0], to[1]);
    return range;
  });
}

function lineHeightOf(element: Element) {
  const style = window.getComputedStyle(element);
  return Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2 || 16;
}

function isEmptyRect(rect: DOMRect | null | undefined) {
  return !rect || (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0);
}

/** A zero-width, one-line rect at the laid-out caret position for `offset`. */
function measureCaretRect(editor: LexicalEditor, element: HTMLElement, offset: number): DOMRect {
  const lineHeight = lineHeightOf(element);
  let rect: DOMRect | null = null;
  const range = createDomRange(editor, offset, offset);
  if (range) {
    const rects = range.getClientRects();
    rect = rects.length > 0 ? rects[0]! : range.getBoundingClientRect();
    if (isEmptyRect(rect)) rect = null;
  }
  // A collapsed range between element children (beside a chip, on an empty
  // line) has no box of its own: measure the character before it instead.
  if (!rect && offset > 0) {
    const previous = createDomRange(editor, offset - 1, offset)?.getClientRects();
    const last = previous && previous.length > 0 ? previous[previous.length - 1] : null;
    if (last && last.height > 0) rect = new DOMRect(last.right, last.top, 0, last.height);
  }
  if (!rect) {
    const box = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    rect = new DOMRect(
      box.left +
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.borderLeftWidth) || 0),
      box.top +
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.borderTopWidth) || 0) -
        element.scrollTop,
      0,
      lineHeight
    );
  }
  const top = rect.top + (rect.height - lineHeight) / 2;
  return new DOMRect(rect.left, top, 0, lineHeight);
}

/** Copy the placeholder paint of a textarea styled like the editor. */
function usePlaceholderPaint(
  element: InputElement | null,
  className: string | undefined,
  placeholder: string | undefined
) {
  React.useLayoutEffect(() => {
    if (!element || !placeholder) return undefined;
    const measure = () => {
      const probe = document.createElement('textarea');
      probe.className = className ?? '';
      probe.placeholder = placeholder;
      probe.tabIndex = -1;
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;height:0;min-height:0;';
      (element.parentElement ?? document.body).appendChild(probe);
      const style = window.getComputedStyle(probe, '::placeholder');
      element.style.setProperty('--composer-placeholder-color', style.color);
      element.style.setProperty('--composer-placeholder-opacity', style.opacity || '1');
      probe.remove();
    };
    measure();
    // Theme switches restyle the placeholder along with the rest of the app.
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => observer.disconnect();
  }, [className, element, placeholder]);
}

/** Padding and border a textarea adds around its `rows` lines. */
function useRowsChrome(element: InputElement | null) {
  React.useLayoutEffect(() => {
    if (!element) return undefined;
    const measure = () => {
      const style = window.getComputedStyle(element);
      const chrome =
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0) +
        (Number.parseFloat(style.borderTopWidth) || 0) +
        (Number.parseFloat(style.borderBottomWidth) || 0);
      const next = `${chrome}px`;
      if (element.style.getPropertyValue('--composer-rows-chrome') !== next) {
        element.style.setProperty('--composer-rows-chrome', next);
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
}

/** Renders every mention node's chip into the editor's own DOM for it. */
function MentionDecorations({
  editor,
  offsets,
  selection,
  focused,
}: {
  editor: LexicalEditor;
  offsets: Record<string, ComposerSelection>;
  selection: ComposerSelection | null;
  focused: boolean;
}) {
  const context = useMentionContext(INPUT_NAME);
  const [decorators, setDecorators] = React.useState<Record<string, MentionDecoration>>(() => ({
    ...editor.getDecorators<MentionDecoration>(),
  }));
  React.useLayoutEffect(
    () =>
      editor.registerDecoratorListener<MentionDecoration>((next) => {
        setDecorators({ ...next });
      }),
    [editor]
  );
  return (
    <>
      {Object.entries(decorators).map(([key, decoration]) => {
        const element = editor.getElementByKey(key);
        const position = offsets[key];
        if (!element || !position) return null;
        const mention = { ...decoration.range, ...position } as Mention;
        const chip = context.getMentionChip?.(mention, decoration.text) ?? null;
        // The selection paints only while the editor has focus, as before.
        const selected =
          focused &&
          !!selection &&
          selection.start !== selection.end &&
          selection.start < mention.end &&
          selection.end > mention.start;
        return createPortal(
          <MentionRangeView
            mention={mention}
            text={decoration.text}
            chip={chip}
            selected={selected}
          />,
          element,
          key
        );
      })}
    </>
  );
}

interface MentionInputProps
  extends Omit<
    React.HTMLAttributes<InputElement>,
    'onChange' | 'defaultValue' | 'children' | 'contentEditable'
  > {
  /** The owner's text. Defaults to the Mention root's `inputValue`. */
  value?: string | null;
  /** Kept for call sites; edits reach the owner through the Mention root. */
  onChange?: () => void;
  /** Lines of height before the editor scrolls, as a textarea's `rows`. */
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  required?: boolean;
  containerClassName?: string;
}

const MentionInput = React.forwardRef<InputElement, MentionInputProps>((props, forwardedRef) => {
  const context = useMentionContext(INPUT_NAME);
  const {
    containerClassName,
    value: valueProp,
    onChange: _onChange,
    rows = 2,
    placeholder,
    autoFocus,
    readOnly,
    disabled,
    required,
    className,
    style,
    spellCheck,
    onKeyDown,
    onPaste,
    onCopy,
    onCut,
    onClick,
    onFocus,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    ...elementProps
  } = props;
  const [element, setElement] = React.useState<InputElement | null>(null);
  const composedRef = useComposedRefs(forwardedRef, context.inputRef, setElement);

  const [editor] = React.useState(() =>
    createEditor({
      namespace: 'lody-composer',
      nodes: [MentionDecoratorNode],
      onError: (error) => {
        console.error(error);
      },
    })
  );

  const contextRef = React.useRef(context);
  contextRef.current = context;
  const documentRef = React.useRef<ComposerDocument>(EMPTY_DOCUMENT);
  const selectionRef = React.useRef<ComposerSelection | null>(null);
  const pendingSelectionRef = React.useRef<PendingSelection | null>(null);
  const virtualAnchorSnapshotRef = React.useRef<VirtualAnchorSnapshot | null>(null);
  const [paint, setPaint] = React.useState<{
    empty: boolean;
    offsets: Record<string, ComposerSelection>;
    selection: ComposerSelection | null;
  }>({ empty: true, offsets: {}, selection: null });
  const [focused, setFocused] = React.useState(false);

  const readSelection = React.useCallback((): ComposerSelection => {
    const selection = editor.getEditorState().read(() => $readSelectionOffsets());
    if (selection) return selection;
    const end = documentRef.current.text.length;
    return { start: end, end };
  }, [editor]);

  const isFocused = React.useCallback(
    () => !!element && element.contains(element.ownerDocument.activeElement),
    [element]
  );

  const writeSelection = React.useCallback(
    (start: number, end: number = start) => {
      editor.update(() => $setSelectionOffsets(start, end), {
        discrete: true,
        tag: isFocused() ? undefined : SKIP_DOM_SELECTION_TAG,
      });
    },
    [editor, isFocused]
  );

  const createVirtualElement = React.useCallback(
    (anchorElement: InputElement, cursorPosition: number) => {
      const ctx = contextRef.current;
      const currentAnchor = virtualAnchorSnapshotRef.current;
      if (
        currentAnchor?.element === anchorElement &&
        currentAnchor.cursorPosition === cursorPosition
      ) {
        if (ctx.virtualAnchor !== currentAnchor.anchor) {
          ctx.onVirtualAnchorChange(currentAnchor.anchor);
        }
        return;
      }

      const virtualElement: VirtualElement = {
        contextElement: anchorElement,
        getBoundingClientRect() {
          return measureCaretRect(editor, anchorElement, cursorPosition);
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
        element: anchorElement,
        cursorPosition,
        anchor: virtualElement,
      };
      ctx.onVirtualAnchorChange(virtualElement);
    },
    [editor]
  );

  const onMentionUpdate = React.useCallback(
    (value: string, currentPosition: number) => {
      const ctx = contextRef.current;
      if (ctx.disabled || ctx.readonly) return false;
      if (editor.isComposing()) return false;
      if (!element) return false;

      const candidates = findTriggerCandidates(value, ctx.triggers, currentPosition);

      for (const { trigger, index: lastTriggerIndex } of candidates) {
        const mentionAtTrigger = ctx.mentions.find(
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
          ctx.triggers.includes(firstCharAfterCursor);

        const isTextAfterCursorPartOfMention = ctx.mentions.some(
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
          if (ctx.trigger !== trigger) {
            ctx.onTriggerChange(trigger);
          }

          createVirtualElement(element, currentPosition);
          ctx.onOpenChange(true);
          ctx.filterStore.search = isImmediatelyAfterTrigger ? '' : textAfterTrigger;
          requestAnimationFrame(() => contextRef.current.onItemsFilter());
          return true;
        }
      }

      if (ctx.open) {
        ctx.onOpenChange(false);
        ctx.onHighlightedItemChange(null);
        ctx.filterStore.search = '';
      }

      return false;
    },
    [createVirtualElement, editor, element]
  );

  /** Hand an edit made in the editor to the owner, as a textarea change did. */
  const publish = React.useCallback(
    (document: ComposerDocument, caret: number) => {
      const ctx = contextRef.current;
      if (!areMentionsEqual(ctx.mentions, document.mentions)) {
        ctx.onMentionsChange(document.mentions);
      }
      const nextMentionValues = getMentionValuesFromMentions(document.mentions);
      if (!areStringArraysEqual(ctx.value, nextMentionValues)) {
        ctx.onValueChange(nextMentionValues);
      }
      ctx.onInputValueChange?.(document.text);
      onMentionUpdate(document.text, caret);
    },
    [onMentionUpdate]
  );

  const isPublished = React.useCallback(() => {
    const ctx = contextRef.current;
    return isSameDocument(documentRef.current, {
      text: ctx.inputValue,
      mentions: sanitizeComposerMentions(ctx.inputValue, ctx.mentions),
    });
  }, []);

  const applyInputValue = React.useCallback(
    (nextValue: string, selectionStart: number, options?: { mentionsToRemove?: Mention[] }) => {
      const ctx = contextRef.current;
      if (options?.mentionsToRemove?.length) {
        ctx.onMentionsRemove(options.mentionsToRemove);
      }
      ctx.onInputValueChange?.(nextValue);
      pendingSelectionRef.current = {
        start: selectionStart,
        end: selectionStart,
        expectedValue: nextValue,
      };
    },
    []
  );

  /** Backward deletion reaching a chip from Lexical (mobile `beforeinput`). */
  const deleteMentionCharacter = React.useCallback(
    (isBackward: boolean) => {
      const ctx = contextRef.current;
      if (ctx.disabled || ctx.readonly) return false;
      const value = documentRef.current.text;
      const { start, end } = readSelection();
      if (start !== end) return false;
      const mention = ctx.mentions.find((candidate) =>
        isBackward
          ? start > candidate.start && start <= candidate.end
          : start >= candidate.start && start < candidate.end
      );
      if (!mention) return false;
      const includeTrailingSpace = isBackward && value[mention.end] === ' ';
      applyInputValue(removeMentionText(value, mention, includeTrailingSpace), mention.start, {
        mentionsToRemove: [mention],
      });
      return true;
    },
    [applyInputValue, readSelection]
  );

  const controller = React.useMemo<ComposerController | null>(
    () =>
      element
        ? {
            getText: () => documentRef.current.text,
            getSelection: readSelection,
            setSelection: writeSelection,
            isComposing: () => editor.isComposing(),
            getCaretRect: (offset) => measureCaretRect(editor, element, offset),
            getRangeRects: (start, end) => {
              const range = createDomRange(editor, start, end);
              return range ? Array.from(range.getClientRects()) : [];
            },
          }
        : null,
    [editor, element, readSelection, writeSelection]
  );

  // Mount the editor on its element and wire Lexical's defaults behind the
  // primitive and caller handlers, which run first and may prevent them.
  React.useLayoutEffect(() => {
    if (!element || !controller) return undefined;
    editor.setRootElement(element);
    const unregister = mergeRegister(
      registerPlainText(editor),
      registerHistory(editor, createEmptyHistoryState(), 300),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => event.defaultPrevented,
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => 'defaultPrevented' in event && event.defaultPrevented,
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(
        COPY_COMMAND,
        (event) => !!event && 'defaultPrevented' in event && event.defaultPrevented,
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(
        CUT_COMMAND,
        (event) => !!event && 'defaultPrevented' in event && event.defaultPrevented,
        COMMAND_PRIORITY_CRITICAL
      ),
      // Files dropped on the editor belong to the composer's drop handling.
      editor.registerCommand(
        DROP_COMMAND,
        (event) => event.defaultPrevented || hasFiles(event.dataTransfer),
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(
        UNDO_COMMAND,
        () => contextRef.current.onHistoryMove(-1),
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(
        REDO_COMMAND,
        () => contextRef.current.onHistoryMove(1),
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(
        DELETE_CHARACTER_COMMAND,
        (isBackward) => deleteMentionCharacter(isBackward),
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerUpdateListener(({ editorState, tags }) => {
        const { document, selection, offsets } = editorState.read(() => ({
          document: $readComposerValue<Mention>(),
          selection: $readSelectionOffsets(),
          offsets: $readMentionOffsets(),
        }));
        const previousSelection = selectionRef.current;
        const changed = !isSameDocument(documentRef.current, document);
        documentRef.current = document;
        selectionRef.current = selection;
        setPaint((current) =>
          current.empty === (document.text.length === 0) &&
          isSameSelection(current.selection, selection) &&
          !changed
            ? current
            : { empty: document.text.length === 0, offsets, selection }
        );
        if (tags.has(SYNC_TAG)) return;
        // The owner hears about IME text only once it is committed.
        if (editor.isComposing()) return;
        const caret = selection?.end ?? document.text.length;
        if (changed || !isPublished()) {
          publish(document, caret);
        } else if (!isSameSelection(previousSelection, selection) && selection) {
          onMentionUpdate(document.text, selection.start);
        }
      }),
      registerComposerController(element, controller)
    );
    return () => {
      unregister();
      editor.setRootElement(null);
    };
  }, [
    controller,
    deleteMentionCharacter,
    editor,
    element,
    isPublished,
    onMentionUpdate,
    publish,
  ]);

  React.useEffect(() => {
    editor.setEditable(!readOnly && !disabled);
  }, [disabled, editor, readOnly]);

  React.useEffect(() => {
    if (autoFocus) element?.focus({ preventScroll: true });
    // Only on mount, as the `autofocus` attribute does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element]);

  const ownerValue = valueProp ?? context.inputValue;
  const pendingSelectionFromRoot = context.pendingSelection;
  const onPendingSelectionFromRootChange = context.onPendingSelectionChange;

  // Copy the owner's value into the editor whenever it differs from what the
  // editor holds, then restore the caret the owner asked for.
  React.useLayoutEffect(() => {
    if (!element) return;
    if (pendingSelectionFromRoot) {
      pendingSelectionRef.current = pendingSelectionFromRoot;
      onPendingSelectionFromRootChange(null);
    }
    if (editor.isComposing()) return;

    const incoming: ComposerDocument = {
      text: ownerValue ?? '',
      mentions: sanitizeComposerMentions(ownerValue ?? '', context.mentions),
    };
    const pending = pendingSelectionRef.current;
    const pendingApplies =
      !!pending && (pending.expectedValue === undefined || pending.expectedValue === incoming.text);
    const isInitial = documentRef.current === EMPTY_DOCUMENT;

    if (!isSameDocument(documentRef.current, incoming) || isInitial) {
      const focusedNow = isFocused();
      const keep = pendingApplies ? pending : (selectionRef.current ?? null);
      editor.update(
        () => {
          $writeComposerValue(incoming.text, incoming.mentions);
          if (keep && (focusedNow || pendingApplies)) {
            const max = incoming.text.length;
            $setSelectionOffsets(Math.min(keep.start, max), Math.min(keep.end, max));
          }
        },
        {
          discrete: true,
          tag: [
            SYNC_TAG,
            ...(isInitial ? [HISTORY_MERGE_TAG] : []),
            ...(focusedNow ? [] : [SKIP_DOM_SELECTION_TAG]),
          ],
        }
      );
      if (pendingApplies) pendingSelectionRef.current = null;
      return;
    }

    if (pending && pendingApplies) {
      pendingSelectionRef.current = null;
      const max = incoming.text.length;
      writeSelection(Math.min(pending.start, max), Math.min(pending.end, max));
    }
  });

  usePlaceholderPaint(element, className, placeholder);
  useRowsChrome(element);

  const onKeyDownPrimitive = React.useCallback(
    (event: React.KeyboardEvent<InputElement>) => {
      const ctx = contextRef.current;
      if (isImeComposingKeyboardEvent(event)) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        if (ctx.onHistoryMove(event.shiftKey ? 1 : -1)) event.preventDefault();
        return;
      }
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'y') {
        if (ctx.onHistoryMove(1)) event.preventDefault();
        return;
      }

      const value = documentRef.current.text;
      const { start: cursorPosition, end: selectionEnd } = readSelection();
      const hasSelection = cursorPosition !== selectionEnd;
      const horizontalMove = hasSelection ? null : getHorizontalCaretMove(event);

      if (horizontalMove) {
        const { direction, isWordJump } = horizontalMove;

        const adjacentMention = findAdjacentMentionForHorizontalNavigation({
          mentions: ctx.mentions,
          value,
          cursorPosition,
          direction,
          isWordJump,
        });

        if (adjacentMention) {
          event.preventDefault();
          const newPosition = isWordJump
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

          writeSelection(newPosition, newPosition);
          return;
        }

        if (event.metaKey || event.ctrlKey) {
          return;
        }
      }

      if (event.key === 'Delete' && !ctx.open && !hasSelection && !ctx.readonly) {
        const next = ctx.mentions.find(
          (mention) => cursorPosition >= mention.start && cursorPosition < mention.end
        );
        if (next) {
          event.preventDefault();
          applyInputValue(removeMentionText(value, next, false), next.start, {
            mentionsToRemove: [next],
          });
          return;
        }
      }
      if (event.key === 'Backspace' && !ctx.open && !hasSelection && !ctx.readonly) {
        const isCtrlOrCmd = event.metaKey || event.ctrlKey;

        const mentionBeforeCursor = findMentionBeforeCursorForDeletion({
          mentions: ctx.mentions,
          value,
          cursorPosition,
          isCtrlOrCmd,
        });

        if (mentionBeforeCursor) {
          const hasTrailingSpace = value[mentionBeforeCursor.end] === ' ';
          const isCursorInsideMention =
            cursorPosition > mentionBeforeCursor.start && cursorPosition <= mentionBeforeCursor.end;

          if (isCursorInsideMention || isCtrlOrCmd) {
            event.preventDefault();
            const newValue = removeMentionText(value, mentionBeforeCursor, hasTrailingSpace);
            applyInputValue(newValue, mentionBeforeCursor.start, {
              mentionsToRemove: [mentionBeforeCursor],
            });
            return;
          }

          if (hasTrailingSpace && cursorPosition === mentionBeforeCursor.end + 1 && !isCtrlOrCmd) {
            event.preventDefault();
            const newValue =
              value.slice(0, mentionBeforeCursor.end) + value.slice(mentionBeforeCursor.end + 1);
            applyInputValue(newValue, mentionBeforeCursor.end);
            return;
          }

          event.preventDefault();
          const newValue = removeMentionText(value, mentionBeforeCursor, hasTrailingSpace);
          applyInputValue(newValue, mentionBeforeCursor.start, {
            mentionsToRemove: [mentionBeforeCursor],
          });
          return;
        }
      }

      if (!ctx.open) return;

      // A modified Enter belongs to the input, not the menu: Cmd/Ctrl+Enter is
      // the owner's send/save, Shift+Enter is a literal newline. Bail before the
      // preventDefault below so neither selects a menu item.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.shiftKey)) return;

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
        ctx.onOpenChange(false);
        ctx.onHighlightedItemChange(null);
        ctx.filterStore.search = '';
      }

      function getTriggerSpan() {
        const triggerIndex = value.lastIndexOf(ctx.trigger, cursorPosition);
        if (triggerIndex === -1) return null;
        return {
          triggerIndex,
          search: value.slice(triggerIndex + ctx.trigger.length, cursorPosition),
        };
      }

      // `highlightedItem` can be a partial snapshot created on hover, so read
      // navigation data off the registered item instead.
      function getRegisteredItem(itemValue: string) {
        return ctx.getEnabledItems().find((item) => item.value === itemValue) ?? null;
      }

      /** Descend into the highlighted navigation item, if it is one. */
      function tryNavigateInto() {
        if (hasSelection || event.shiftKey) return false;
        const highlighted = ctx.highlightedItem;
        if (!highlighted) return false;
        const registered = getRegisteredItem(highlighted.value);
        if (!registered?.navigateText) return false;
        const span = getTriggerSpan();
        if (!span) return false;
        void ctx.onMentionAdd(registered.value, span.triggerIndex);
        return true;
      }

      /** Pop a `@ns:` category prefix back to the bare trigger in one keystroke. */
      function tryNavigateBack() {
        if (hasSelection || event.shiftKey) return false;
        const span = getTriggerSpan();
        if (!span || !isMentionNavigationPrefix(span.search)) return false;
        return ctx.onNavigateBack();
      }

      /** Commit the highlighted (or exact-match) item, matching Enter. */
      function trySelectHighlighted() {
        const span = getTriggerSpan();
        if (!span) return false;

        const searchText = span.search;
        const exactMatchItem =
          searchText.length > 0
            ? ctx.getEnabledItems().find((item) => item.label === searchText)
            : null;

        const selectedItem = ctx.highlightedItem ?? exactMatchItem;
        if (!selectedItem) return false;

        // Enter/Tab on a navigation item the user has already typed out in full
        // commits it rather than descending again: typing `@src/` then Enter
        // inserts `@src`.
        const registeredItem = getRegisteredItem(selectedItem.value) ?? selectedItem;
        const shouldCommit =
          Boolean(registeredItem.navigateText) && registeredItem.label === searchText;

        void ctx.onMentionAdd(selectedItem.value, span.triggerIndex, {
          commit: shouldCommit,
        });
        return true;
      }

      switch (event.key) {
        case 'Enter': {
          if (!trySelectHighlighted()) {
            onMenuClose();
            return;
          }
          event.preventDefault();
          break;
        }
        case 'Tab': {
          // ⇧Tab is the composer mode-cycle binding; do not steal it to select.
          if (event.shiftKey) {
            if (ctx.modal) event.preventDefault();
            onMenuClose();
            break;
          }
          if (tryNavigateInto()) {
            event.preventDefault();
            break;
          }
          if (trySelectHighlighted()) {
            event.preventDefault();
            break;
          }
          if (ctx.modal) event.preventDefault();
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
          if (ctx.readonly) return;
          ctx.onHighlightMove(ctx.highlightedItem ? 'next' : 'first');
          break;
        }
        case 'ArrowUp': {
          if (ctx.readonly) return;
          ctx.onHighlightMove(ctx.highlightedItem ? 'prev' : 'last');
          break;
        }
        case 'Home': {
          if (event.metaKey || event.ctrlKey) return;
          if (ctx.readonly) return;
          event.preventDefault();
          ctx.onHighlightMove('first');
          break;
        }
        case 'End': {
          if (event.metaKey || event.ctrlKey) return;
          if (ctx.readonly) return;
          event.preventDefault();
          ctx.onHighlightMove('last');
          break;
        }
        case 'Escape': {
          onMenuClose();
          event.stopPropagation();
          break;
        }
      }
    },
    [applyInputValue, readSelection, writeSelection]
  );

  const onClickPrimitive = React.useCallback(
    (event: React.MouseEvent<InputElement>) => {
      if (editor.isComposing()) return;
      const ctx = contextRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const chipElement = target?.closest<HTMLElement>('[data-mention-start]');
      if (chipElement && element?.contains(chipElement)) {
        const start = Number(chipElement.dataset.mentionStart);
        const end = Number(chipElement.dataset.mentionEnd);
        // A click lands the caret on the chip's nearer edge, never inside it.
        const rects = Array.from(chipElement.getClientRects());
        const first = rects[0];
        const towardStart =
          !!first &&
          event.clientY <= first.bottom &&
          event.clientX < first.left + (first.right - first.left) / 2 &&
          (rects.length === 1 || event.clientY >= first.top);
        const edge = towardStart ? start : end;
        writeSelection(edge, edge);
        onMentionUpdate(documentRef.current.text, edge);
        const mention = ctx.mentions.find(
          (candidate) => candidate.start === start && candidate.end === end
        );
        if (mention && ctx.onMentionClick) ctx.onMentionClick(mention);
        return;
      }
      onMentionUpdate(documentRef.current.text, readSelection().start);
    },
    [editor, element, onMentionUpdate, readSelection, writeSelection]
  );

  const onFocusPrimitive = React.useCallback(() => {
    setFocused(true);
    onMentionUpdate(documentRef.current.text, readSelection().start);
  }, [onMentionUpdate, readSelection]);

  const onCompositionStartPrimitive = React.useCallback(() => {
    contextRef.current.cancelMentionPreparation();
  }, []);

  const onCompositionEndPrimitive = React.useCallback(() => {
    // Lexical commits the composed text in its own handler, which runs before
    // this one; make sure the owner received it.
    if (!isPublished() && !editor.isComposing()) {
      publish(documentRef.current, readSelection().end);
    }
  }, [editor, isPublished, publish, readSelection]);

  const mirrorSelection = !!context.getMentionChip;
  const editable = !readOnly && !disabled;

  return (
    <div className={cn('relative', containerClassName)}>
      <div
        role="combobox"
        id={context.inputId}
        aria-expanded={context.open}
        aria-controls={context.listId}
        aria-labelledby={context.labelId}
        aria-autocomplete="list"
        aria-activedescendant={context.highlightedItem?.ref.current?.id}
        aria-disabled={context.disabled || disabled || undefined}
        aria-readonly={context.readonly || readOnly || undefined}
        aria-required={required || undefined}
        aria-multiline="true"
        aria-placeholder={placeholder}
        dir={context.dir}
        tabIndex={!editable && !disabled ? 0 : undefined}
        {...elementProps}
        ref={composedRef}
        data-composer-editor=""
        data-placeholder={placeholder}
        data-empty={paint.empty ? '' : undefined}
        data-system-selection={mirrorSelection ? '' : undefined}
        className={cn('relative', 'z-10', className, 'bg-transparent')}
        style={{ '--composer-rows': rows, ...style } as React.CSSProperties}
        // Chip glyphs repaint under native spelling decorations.
        spellCheck={mirrorSelection ? false : spellCheck}
        onKeyDownCapture={composeEventHandlers(onKeyDownPrimitive, onKeyDown)}
        onPasteCapture={onPaste}
        onCopyCapture={onCopy}
        onCutCapture={onCut}
        onClick={composeEventHandlers(onClick, onClickPrimitive)}
        onFocus={composeEventHandlers(onFocus, onFocusPrimitive)}
        onBlur={composeEventHandlers(onBlur, () => setFocused(false))}
        onCompositionStart={composeEventHandlers(onCompositionStart, onCompositionStartPrimitive)}
        onCompositionEnd={composeEventHandlers(onCompositionEnd, onCompositionEndPrimitive)}
      />
      <MentionDecorations
        editor={editor}
        offsets={paint.offsets}
        selection={paint.selection}
        focused={focused}
      />
    </div>
  );
});

MentionInput.displayName = INPUT_NAME;

const Input = MentionInput;

export { Input, MentionInput };

export type { InputElement, MentionInputProps };
