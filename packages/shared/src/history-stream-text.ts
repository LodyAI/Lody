import type { MessageContent } from './ai';
import { LODY_INTERNAL_PROMPT_SCAN_TAIL, sanitizeLodyInternalInstructions } from './goal';
import { isDraft, original } from 'immer';

export const shouldDedupeHistoryChunk = (chunk: string): boolean =>
  chunk.length >= 48 || chunk.includes('\n');
const shouldDedupeChunk = shouldDedupeHistoryChunk;

const streamChunkSuffix = (current: string, incoming: string, tail = current): string => {
  if (!incoming) return '';
  if (!current) return incoming;

  // Some emitters send snapshots instead of deltas. If `incoming` is a snapshot that already
  // contains `current`, keep only the snapshot.
  if (incoming.length >= current.length && incoming.startsWith(current)) {
    return incoming.slice(current.length);
  }

  // On reconnect/retry, the same chunk may be re-sent. Avoid duplicating large chunks.
  if (
    shouldDedupeChunk(incoming) &&
    (incoming.length <= tail.length ? tail : current).endsWith(incoming)
  ) {
    return '';
  }

  if (!shouldDedupeChunk(incoming)) {
    return incoming;
  }

  // Best-effort overlap merge to handle partial replays where the boundary is not aligned.
  const maxWindow = 4096;
  const minOverlap = 24;
  const maxOverlap = Math.min(current.length, incoming.length, maxWindow);
  for (let overlap = maxOverlap; overlap >= minOverlap; overlap--) {
    if (tail.slice(-overlap) === incoming.slice(0, overlap)) {
      return incoming.slice(overlap);
    }
  }

  return incoming;
};

type StreamText = Extract<MessageContent, { type: 'text' | 'thought' }>;
type TextAnalysis = {
  source: string;
  clean: boolean;
  tags: boolean;
  closes: boolean;
  tail: string;
};
const textAnalysis = new WeakMap<object, TextAnalysis>();
const textTailLength = Math.max(4096, LODY_INTERNAL_PROMPT_SCAN_TAIL, '<proposed_plan>'.length - 1);
const containsAssistantTags = (text: string) =>
  text.includes('<thinking>') || text.includes('<proposed_plan>');
const containsClosingTags = (text: string) =>
  text.includes('</thinking>') || text.includes('</proposed_plan>');
const analyzeText = (item: StreamText): TextAnalysis => {
  const key = isDraft(item) ? (original(item) ?? item) : item;
  const cached = textAnalysis.get(key);
  if (cached?.source === item.text) return cached;
  const analysis = {
    source: item.text,
    clean: sanitizeLodyInternalInstructions(item.text) === item.text,
    tags: containsAssistantTags(item.text),
    closes: containsClosingTags(item.text),
    tail: item.text.slice(-textTailLength),
  };
  textAnalysis.set(key, analysis);
  return analysis;
};

export const mergeHistoryStreamText = (item: StreamText, delta: string) => {
  // Malformed stored fields retain the old reducer's repair/refusal behavior.
  if (typeof item.text !== 'string') {
    // Runtime history can predate the declared schema. Retain its existing JS
    // coercion/refusal path rather than silently converting malformed values.
    const stored = item.text as string;
    const merged =
      !stored || delta.startsWith(stored)
        ? delta
        : stored + streamChunkSuffix(stored, delta);
    return { item: { ...item, text: sanitizeLodyInternalInstructions(merged) }, suffix: undefined };
  }
  const prior = analyzeText(item);
  const suffix = streamChunkSuffix(item.text, delta, prior?.tail);
  const merged = (item.text || '') + suffix;
  const boundary = prior ? prior.tail + suffix : undefined;
  const clean =
    prior !== undefined &&
    boundary !== undefined &&
    prior.clean &&
    sanitizeLodyInternalInstructions(boundary) === boundary;
  const text = clean ? merged : sanitizeLodyInternalInstructions(merged);
  const next: StreamText = { ...item, text };
  if (clean && prior && boundary !== undefined)
    textAnalysis.set(next, {
      source: text,
      clean: true,
      tags: prior.tags || containsAssistantTags(boundary),
      closes: prior.closes || containsClosingTags(boundary),
      tail: boundary.slice(-textTailLength),
    });
  return { item: next, suffix: clean ? suffix : undefined };
};

export const hasAssistantTextTags = (item: StreamText): boolean => {
  const analysis = analyzeText(item);
  // Both existing structural parsers require a complete closing delimiter.
  return analysis.tags && analysis.closes;
};

/** Validation changes object identity, never the already checked string's bytes. */
export function inheritHistoryStreamText(input: unknown, parsed: unknown): void {
  if (!input || !parsed || typeof input !== 'object' || typeof parsed !== 'object') return;
  const source = isDraft(input) ? (original(input) ?? input) : input;
  const analysis = textAnalysis.get(source);
  if (analysis && 'text' in parsed && parsed.text === analysis.source)
    textAnalysis.set(parsed, analysis);
}
