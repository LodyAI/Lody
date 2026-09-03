import type { SessionHistory } from '@lody/shared';
import { isContainer, type LoroDoc, type LoroList, type LoroMap, type LoroText } from 'loro-crdt';
import { TURN_SUMMARY_HEAD_CHARS, type TurnSummary } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Summary of a hydrated turn: one pass over its items. */
export function summarizeTurn(entry: Pick<SessionHistory, 'items'>): TurnSummary {
  let headText = '';
  let textChars = 0;
  let toolCalls = 0;
  let thoughts = 0;
  const items = Array.isArray(entry.items) ? entry.items : [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (type === 'text') {
      const text = typeof raw.text === 'string' ? raw.text : '';
      textChars += text.length;
      if (!headText && text.trim()) headText = text.slice(0, TURN_SUMMARY_HEAD_CHARS);
    } else if (type === 'thought') {
      thoughts += 1;
      textChars += typeof raw.text === 'string' ? raw.text.length : 0;
    } else if (type === 'tool_call') {
      toolCalls += 1;
    } else if (type === 'proposed_plan') {
      textChars += typeof raw.markdown === 'string' ? raw.markdown.length : 0;
    }
  }
  return { headText, textChars, toolCalls, thoughts };
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
export function summarizeTurnShallow(doc: LoroDoc, turnMap: LoroMap): TurnSummary {
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
  void doc;
  return { headText, textChars, toolCalls, thoughts };
}
