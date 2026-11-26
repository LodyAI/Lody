import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SessionHistory, SessionId } from '@lody/shared';
import { getTextContentFromMessageItems } from '@/components/ai-gui/message-copy';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { isImeComposingNativeKeyboardEvent } from '@/lib/ime';
import type { ConversationView } from '@/lib/conversation-view/types';

/** Turns acquired together when recall reaches a body the view has not hydrated. */
const RECALL_LOAD_BATCH = 16;

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

/**
 * The text a user turn can be recalled as: only what a person wrote. Turns
 * authored by an agent or the system, and attachment-only turns, have none.
 */
export function recallableTurnText(turn: SessionHistory): string {
  if (turn.role !== 'user') return '';
  if (turn.author && turn.author.kind !== 'human') return '';
  return getTextContentFromMessageItems(turn.items ?? []);
}

type RecallSearch =
  | { kind: 'found'; position: number; text: string }
  | { kind: 'unhydrated'; position: number }
  | { kind: 'none' };

function findRecallableMessage(
  view: ConversationView,
  start: number,
  direction: -1 | 1
): RecallSearch {
  for (let i = start; i >= 0 && i < view.turnCount; i += direction) {
    if (view.index(i)?.role !== 'user') continue;
    if (!view.isHydrated(i)) return { kind: 'unhydrated', position: i };
    const turn = view.turn(i);
    const text = turn ? recallableTurnText(turn) : '';
    if (text) return { kind: 'found', position: i, text };
  }
  return { kind: 'none' };
}

type RecallState = { sessionId: SessionId; position: number; text: string };

/**
 * Up/Down in an empty session composer steps through the session's sent
 * messages. While a recalled message is shown the vertical arrows only step;
 * the editor puts the caret at the end of each text it is given. Typing, any other key, or a pointer press in
 * the input returns the composer to ordinary editing with that text as its
 * draft. A recalled message that was never edited is not stored as a draft.
 */
export function useComposerMessageRecall({
  sessionId,
  view,
  inputRef,
  value,
  canStart,
  showText,
  commitText,
}: {
  sessionId: SessionId;
  view: ConversationView | null | undefined;
  inputRef: RefObject<HTMLElement | null>;
  /** The composer's current text. */
  value: string;
  /** Whether an Up press may begin recall: the composer holds no draft of any kind. */
  canStart: boolean;
  /** Show text without persisting it as the session draft. */
  showText: (text: string) => void;
  /** Persist text as the session draft. */
  commitText: (text: string) => void;
}): {
  /**
   * Call with each composer value change. Returns true when the change is the
   * editor echoing the recalled text, which needs no further handling.
   */
  absorbChange: (next: string) => boolean;
} {
  const [recall, setRecall] = useState<RecallState | null>(null);
  // Any other value (a send cleared it, a session switch replaced it) means the
  // composer is no longer showing the recalled message.
  const active = recall && recall.sessionId === sessionId && recall.text === value ? recall : null;
  const latest = useLatestRef({ active, view, value, canStart, sessionId, showText, commitText });
  // Bumped by every step and exit, so a load that settles late cannot overwrite newer state.
  const requestRef = useRef(0);

  const end = useCallback(() => {
    requestRef.current += 1;
    const current = latest.current.active;
    setRecall(null);
    if (current) latest.current.commitText(current.text);
  }, [latest]);

  const step = useCallback(
    (direction: -1 | 1) => {
      const { view: recallView, active: current, sessionId: owner, value: shown } = latest.current;
      if (!recallView) return;
      const request = ++requestRef.current;
      const run = (start: number, loadedPosition: number | null) => {
        const found = findRecallableMessage(recallView, start, direction);
        if (found.kind === 'found') {
          setRecall({ sessionId: owner, position: found.position, text: found.text });
          latest.current.showText(found.text);
          return;
        }
        if (found.kind === 'none') {
          if (direction === 1 && current) {
            setRecall(null);
            latest.current.commitText('');
          }
          return;
        }
        // A range that settled without hydrating its turn would otherwise retry forever.
        if (found.position === loadedPosition) return;
        const range = recallView.acquireRange(
          Math.max(0, found.position - RECALL_LOAD_BATCH + 1),
          found.position + 1
        );
        void range.ready
          .then(
            () => {
              const now = latest.current;
              if (requestRef.current !== request || now.sessionId !== owner) return;
              // Text that reached the composer another way while loading wins.
              if (now.value !== shown) return;
              run(found.position, found.position);
            },
            () => undefined
          )
          .finally(() => range.release());
      };
      run((current ? current.position : recallView.turnCount) + direction, null);
    },
    [latest]
  );

  useEffect(() => {
    if (!view) return;
    const isInInput = (target: EventTarget | null) => {
      const input = inputRef.current;
      return !!input && target instanceof Node && input.contains(target);
    };
    // Document capture runs before the editor's own handlers, so the caret
    // never moves for a recall step, and a key the editor consumes (a caret
    // jump across a chip) still ends recall.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isInInput(event.target)) return;
      if (isImeComposingNativeKeyboardEvent(event)) return;
      const { active: current, canStart: startable } = latest.current;
      const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
      const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      // An open mention or command menu owns the arrows.
      const menuOpen = inputRef.current?.getAttribute('aria-expanded') === 'true';
      if (vertical && plain && !menuOpen) {
        if (current) {
          event.preventDefault();
          step(event.key === 'ArrowUp' ? -1 : 1);
        } else if (event.key === 'ArrowUp' && startable) {
          event.preventDefault();
          step(-1);
        }
        return;
      }
      if (current && event.key !== 'Enter' && !MODIFIER_KEYS.has(event.key)) end();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (latest.current.active && isInInput(event.target)) end();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [end, inputRef, latest, step, view]);

  const absorbChange = useCallback(
    (next: string) => {
      const current = latest.current.active;
      if (!current) return false;
      if (next === current.text) return true;
      requestRef.current += 1;
      setRecall(null);
      return false;
    },
    [latest]
  );

  return { absorbChange };
}
