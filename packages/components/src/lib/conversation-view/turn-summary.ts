import type { MessageContent, SessionHistory } from '@lody/shared';
import { normalizeMessageContent } from '../../components/ai-gui/message-content-guards';
import { firstTextOf, proseLengthOf } from '../conversation-outline';
import type { LoroList, LoroMap, LoroText } from 'loro-crdt';
import { TURN_SUMMARY_HEAD_CHARS, type TurnSummary } from './types';

/**
 * Summary of a hydrated turn.
 *
 * `headText` and `textChars` come from the outline's own definitions of "the
 * opening prose" and "how much was said", because the rail reads both from
 * this summary for a turn it cannot hydrate — a second definition here would
 * make a round's title and tick weight change the moment it is evicted.
 */
export function summarizeTurn(entry: Pick<SessionHistory, 'items'>): TurnSummary {
  const items = (Array.isArray(entry.items) ? entry.items : [])
    .map(normalizeMessageContent)
    .filter((item): item is MessageContent => item !== null);
  let toolCalls = 0;
  let thoughts = 0;
  for (const item of items) {
    if (item?.type === 'tool_call') toolCalls += 1;
    else if (item?.type === 'thought') thoughts += 1;
  }
  return {
    headText: firstTextOf(items) ?? '',
    textChars: proseLengthOf({ items }),
    toolCalls,
    thoughts,
  };
}

// Inline of loro-crdt's isContainer: importing it pulls the WASM-glue module
// into the boot chunk, while the check itself is pure JavaScript.
const LORO_CONTAINER_TYPES = new Set(['Map', 'Text', 'List', 'Tree', 'MovableList', 'Counter']);
function isContainer(value: unknown): value is LoroList | LoroMap | LoroText {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null || typeof proto !== 'object') return false;
  if (typeof (proto as { kind?: unknown }).kind !== 'function') return false;
  return LORO_CONTAINER_TYPES.has(String((value as { kind: () => string }).kind()));
}

const textLength = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (isContainer(value) && value.kind() === 'Text') return (value as LoroText).length;
  return 0;
};

/**
 * Summary of a turn that is NOT hydrated, from shallow reads only: one shallow
 * value per item map plus one `length` per prose text. Never copies a whole
 * text — only the first prose item's head is sliced.
 */
export function summarizeTurnShallow(turnMap: LoroMap): TurnSummary {
  let headText = '';
  let textChars = 0;
  let toolCalls = 0;
  let thoughts = 0;
  const itemsHandle = turnMap.get('items');
  if (isContainer(itemsHandle) && itemsHandle.kind() === 'List') {
    const items = itemsHandle as LoroList;
    const length = items.length;
    for (let i = 0; i < length; i += 1) {
      const item = items.get(i);
      if (!isContainer(item) || item.kind() !== 'Map') continue;
      const map = item as LoroMap;
      const type = map.get('type');
      if (type === 'text') {
        const text = map.get('text');
        textChars += textLength(text);
        if (!headText) {
          const head =
            typeof text === 'string'
              ? text.slice(0, TURN_SUMMARY_HEAD_CHARS)
              : isContainer(text) && text.kind() === 'Text'
                ? (text as LoroText).slice(
                    0,
                    Math.min((text as LoroText).length, TURN_SUMMARY_HEAD_CHARS)
                  )
                : '';
          if (head.trim()) headText = head;
        }
      } else if (type === 'thought') {
        thoughts += 1;
        textChars += textLength(map.get('text'));
      } else if (type === 'tool_call') {
        toolCalls += 1;
      } else if (type === 'proposed_plan') {
        textChars += textLength(map.get('markdown'));
      }
    }
  }
  return { headText, textChars, toolCalls, thoughts };
}
