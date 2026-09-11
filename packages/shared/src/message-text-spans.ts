/**
 * Mention spans carried alongside a `text` message item.
 *
 * A user prompt is rewritten on its way to the agent: `$skill` becomes a skill
 * instruction, `@session:` becomes an MCP call, and a pasted-text placeholder
 * becomes the whole pasted blob. The stored `text` is that rewritten string —
 * it has to be, because it is the exact string the agent receives — so by the
 * time the transcript renders it, every trace of what the user actually typed
 * is gone.
 *
 * A span records the mapping the rewrite already computed and used to throw
 * away: this region of the final text stands for that mention. One string,
 * two readers — the agent reads the text, the transcript paints a chip over
 * the region and shows the user's own wording back to them.
 *
 * ## Offsets
 *
 * `start`/`end` are UTF-16 code unit indices (plain JS string indices) into
 * the sibling `text`, half-open. Producer and consumer must agree on the unit;
 * everything here indexes the same way `String.prototype.slice` does.
 *
 * ## Trust
 *
 * Spans ride the session document's `.catchall(...)`, which performs no
 * validation, so they arrive unvalidated from whatever wrote them — including
 * a future or a buggy client. `sanitizeMessageTextSpans` is the only supported
 * way to read them, and every boundary that touches a text item runs it.
 */

/** Mention categories a span can stand for. Mirrors the composer's kinds. */
export const MESSAGE_TEXT_SPAN_KINDS = [
  'file',
  'dir',
  'issue',
  'pr',
  'skill',
  'session',
  'command',
  'agent_role',
  'pasted_text',
] as const;

export type MessageTextSpanKind = (typeof MESSAGE_TEXT_SPAN_KINDS)[number];

export type MessageTextSpan = {
  /** UTF-16 code unit offset into the sibling `text`, inclusive. */
  start: number;
  /** UTF-16 code unit offset into the sibling `text`, exclusive. */
  end: number;
  kind: MessageTextSpanKind;
  /**
   * What the chip shows — the composer's form (`@src/a.ts`, `$review-diff`,
   * `Pasted 4,182 chars`), never the rewritten form sitting in `text`.
   */
  label: string;
  /** What activating the chip resolves to: a repo path, an issue number, a session id. */
  target?: string;
  /**
   * A glyph shown in place of the kind's icon — an Agent Role's emoji today.
   *
   * FROZEN here rather than resolved when the transcript renders: the mark is
   * part of what the user sent, so renaming or re-marking the Role afterwards
   * must not repaint history, and painting a bubble must not depend on a
   * mutable catalog being loaded.
   */
  mark?: string;
};

/**
 * A mark is decoration, so the only real bar is that it cannot smuggle a line of
 * text into a chip. Sized for one emoji, including a ZWJ sequence.
 *
 * Exported because the SEND path validates the same field with a strict zod
 * schema: two different bars there would mean a span this reader keeps is a
 * span that schema rejects — and rejecting one field drops the whole text
 * block, which reads as "you typed nothing".
 */
export const MAX_MESSAGE_TEXT_SPAN_MARK_LENGTH = 16;

const SPAN_KINDS: ReadonlySet<string> = new Set(MESSAGE_TEXT_SPAN_KINDS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A plain JS string index, as `String.prototype.slice` takes. */
export const isTextOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isOffset = isTextOffset;

/**
 * Sort by position and drop every range that overlaps an earlier one.
 *
 * The one ordering rule this feature has, stated once. Every consumer of a
 * range set — the transcript's chip splitter, the composer's highlighter, the
 * before-send rewriter, the draft restorer — walks the ranges in order and
 * slices the text between them, so two ranges claiming the same character have
 * no well-defined result. The earlier one wins because it is the one already
 * rendered by the time the conflict is discovered.
 */
export const dropOverlappingRanges = <T extends { start: number; end: number }>(
  ranges: readonly T[]
): T[] => {
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: T[] = [];
  let lastEnd = 0;
  for (const range of ordered) {
    if (range.start < lastEnd) continue;
    kept.push(range);
    lastEnd = range.end;
  }
  return kept;
};

/**
 * Drop every span that does not describe a real, non-overlapping region of
 * `text`, and return the survivors sorted by `start`.
 *
 * Returns `undefined` rather than `[]` when nothing survives so callers can
 * omit the field entirely instead of persisting an empty array into the
 * session document.
 *
 * Overlaps are resolved by keeping the earlier span: renderers walk spans in
 * order and slice the text between them, so two spans claiming the same
 * character have no well-defined rendering.
 */
export const sanitizeMessageTextSpans = (
  text: string,
  spans: unknown
): MessageTextSpan[] | undefined => {
  if (!Array.isArray(spans) || spans.length === 0) return undefined;

  const candidates: MessageTextSpan[] = [];
  for (const span of spans) {
    if (!isRecord(span)) continue;
    const { start, end, kind, label, target, mark } = span;
    if (!isOffset(start) || !isOffset(end)) continue;
    if (end <= start || end > text.length) continue;
    if (typeof kind !== 'string' || !SPAN_KINDS.has(kind)) continue;
    if (typeof label !== 'string' || label.length === 0) continue;
    if (target !== undefined && typeof target !== 'string') continue;
    const keptMark =
      typeof mark === 'string' &&
      mark.length > 0 &&
      mark.length <= MAX_MESSAGE_TEXT_SPAN_MARK_LENGTH
        ? mark
        : undefined;

    candidates.push({
      start,
      end,
      kind: kind as MessageTextSpanKind,
      label,
      ...(target === undefined ? {} : { target }),
      ...(keptMark === undefined ? {} : { mark: keptMark }),
    });
  }

  const kept = dropOverlappingRanges(candidates);
  return kept.length > 0 ? kept : undefined;
};

/**
 * One edit to the composer text on its way to the agent.
 *
 * `replacement` is what the agent should read; `span` is what the transcript
 * should show instead. Either may be omitted: a mention that needs no rewrite
 * (`@src/a.ts`, `#482`) supplies only `span`, and an edit nobody needs to see
 * supplies only `replacement`.
 */
export type TextRewrite = {
  /** Offset into the *source* text, inclusive. */
  start: number;
  /** Offset into the *source* text, exclusive. */
  end: number;
  /** Replaces `[start, end)` in the output. Defaults to the source slice. */
  replacement?: string;
  /** Marks the replaced region as a mention in the output. */
  span?: { kind: MessageTextSpanKind; label: string; target?: string; mark?: string };
};

/**
 * Apply every rewrite in one pass, and report where each one landed.
 *
 * The point is to not chain offset math. Expanding `$skill` and then
 * `@session:` and then a pasted blob means three rewrites of three different
 * lengths, and mapping a span through each of them in turn is how off-by-N bugs
 * get in. So every producer describes its edits against the *original* text,
 * and the output offsets are computed once, here, from the running delta.
 *
 * Rewrites are applied in source order; one that overlaps an earlier one is
 * dropped, matching `sanitizeMessageTextSpans` — the output has to stay
 * sliceable by non-overlapping spans.
 */
export const applyTextRewrites = (
  text: string,
  rewrites: readonly TextRewrite[]
): { text: string; spans?: MessageTextSpan[] } => {
  const ordered = [...rewrites]
    .filter(
      (rewrite) =>
        isOffset(rewrite.start) &&
        isOffset(rewrite.end) &&
        rewrite.end > rewrite.start &&
        rewrite.end <= text.length
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let out = '';
  let copiedTo = 0;
  const spans: MessageTextSpan[] = [];

  for (const rewrite of ordered) {
    if (rewrite.start < copiedTo) continue;

    out += text.slice(copiedTo, rewrite.start);
    const replacement = rewrite.replacement ?? text.slice(rewrite.start, rewrite.end);
    const spanStart = out.length;
    out += replacement;
    copiedTo = rewrite.end;

    if (rewrite.span && replacement.length > 0) {
      spans.push({ start: spanStart, end: spanStart + replacement.length, ...rewrite.span });
    }
  }

  out += text.slice(copiedTo);
  // Re-run the shared validation rather than trusting the arithmetic above:
  // a caller-supplied label or kind still has to pass the same bar as one that
  // arrived from a peer.
  return { text: out, spans: sanitizeMessageTextSpans(out, spans) };
};

/**
 * Re-anchor spans after `text` has been trimmed.
 *
 * Text blocks are trimmed on their way into history. Trimming the head moves
 * every character left, so offsets captured against the untrimmed string would
 * land one whole prefix early — silently, and only for prompts that happen to
 * start with whitespace. Shifting here and re-sanitizing against the trimmed
 * text is what keeps that from being a class of bug nobody reproduces.
 */
export const reanchorMessageTextSpansForTrim = (
  originalText: string,
  trimmedText: string,
  spans: unknown
): MessageTextSpan[] | undefined => {
  if (!Array.isArray(spans) || spans.length === 0) return undefined;

  const leading = originalText.length - originalText.trimStart().length;
  if (leading === 0) return sanitizeMessageTextSpans(trimmedText, spans);

  const shifted = spans.map((span) =>
    isRecord(span) && isOffset(span.start) && isOffset(span.end)
      ? { ...span, start: span.start - leading, end: span.end - leading }
      : span
  );
  return sanitizeMessageTextSpans(trimmedText, shifted);
};
