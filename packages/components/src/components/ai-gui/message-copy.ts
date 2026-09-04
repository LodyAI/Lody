import {
  applyTextRewrites,
  sanitizeMessageTextSpans,
  type MessageContent,
  type MessageTextSpan,
  type MessageTextSpanKind,
} from '@lody/shared';

export const USER_TEXT_RENDER_LINE_LIMIT = 10;
export const USER_TEXT_RENDER_CHAR_LIMIT = 900;

/**
 * Items that are never folded into a turn's work region: attachments the agent
 * produced, the plan surfaces, the goal marker, and the "Exited Plan Mode"
 * switch that closes a plan turn.
 *
 * ONE list, used for both questions it answers — "does this item fold?" and
 * "is this item part of the tail that trails the answer?". They were two lists
 * (the tail one held only `image_group` and `switch_mode`), so a turn ending in
 * a `file` or a `proposed_plan` found no trailing tail, reported no visible
 * answer text, and folded the answer itself into "Worked for …". Attachments
 * now sort BELOW the plan, which puts a `file` last far more often, so the two
 * lists have to agree.
 */
const isNeverCollapsedAssistantItem = (content: MessageContent | undefined): boolean =>
  content?.type === 'image_group' ||
  content?.type === 'image' ||
  content?.type === 'file' ||
  content?.type === 'plan' ||
  content?.type === 'goal' ||
  content?.type === 'proposed_plan' ||
  (content?.type === 'tool_call' && content.kind === 'switch_mode');

/**
 * The answer is the final contiguous run of text before the never-collapsed
 * tail, not necessarily the last item. Every adjacent text block in that run
 * stays visible; a non-text item is the boundary between work and the answer.
 */
const getFinalTextRunStart = (items: MessageContent[]): number => {
  let index = items.length - 1;

  while (index >= 0 && isNeverCollapsedAssistantItem(items[index])) {
    index -= 1;
  }

  if (items[index]?.type !== 'text') {
    return items.length;
  }

  while (index > 0 && items[index - 1]?.type === 'text') {
    index -= 1;
  }

  return index;
};

export const shouldCollapseAssistantMessageItem = ({
  content,
  index,
  items,
  isTurnFinished,
}: {
  content: MessageContent;
  index: number;
  items: MessageContent[];
  isTurnFinished: boolean;
}): boolean => {
  const itemCount = items.length;
  const visibleTextRunStart = getFinalTextRunStart(items);

  return (
    isTurnFinished &&
    itemCount > 1 &&
    index < itemCount - 1 &&
    !(content.type === 'text' && index >= visibleTextRunStart) &&
    !isNeverCollapsedAssistantItem(content)
  );
};

// Copyable text = plain `text` answers plus `proposed_plan` markdown. The plan
// is the meaningful payload of a plan-only turn, so the message-footer copy
// button must pick it up to stay consistent with every other message's copy
// action (a plan-only message would otherwise show no footer copy button).
// Extend the dispatch here when another content variant carries copyable text.
const getCopyableItemText = (content: MessageContent): string =>
  content.type === 'text' ? content.text : content.type === 'proposed_plan' ? content.markdown : '';

export const getTextContentFromMessageItems = (items: MessageContent[]): string =>
  items
    .map(getCopyableItemText)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');

/**
 * Span kinds that are copied as what the user wrote, not as what the agent read.
 *
 * Only `agent_role`. Its rewritten region is an instruction addressed to the
 * agent ("use lody mcp to create a session with agent role[...]") that means
 * nothing outside this conversation, while the chip on screen says `@Reviewer` —
 * so copying the bubble has to produce the latter.
 *
 * The other kinds stay expanded on purpose: a pasted-text span IS the content
 * the user wants when they copy, and a skill or session mention expands to a
 * path or an id that remains meaningful pasted elsewhere.
 */
const COPY_AS_LABEL_SPAN_KINDS: ReadonlySet<MessageTextSpanKind> = new Set(['agent_role']);

/**
 * Replace those regions with their label, so the copied text reads like the
 * bubble. The label omits the `@` (the chip's glyph carries the type), so it is
 * put back here — the composer form is what the reader recognises.
 */
export const collapseMentionSpansForCopy = (
  text: string,
  spans: readonly MessageTextSpan[] | undefined
): string => {
  const resolved = sanitizeMessageTextSpans(text, spans)?.filter((span) =>
    COPY_AS_LABEL_SPAN_KINDS.has(span.kind)
  );
  if (!resolved || resolved.length === 0) return text;

  // Offsets are described against the original text and spliced in one pass, so
  // this path never chains its own offset math.
  return applyTextRewrites(
    text,
    resolved.map(({ start, end, label }) => ({ start, end, replacement: `@${label}` }))
  ).text;
};

/**
 * The text a copy action should produce.
 *
 * Deliberately not `getTextContentFromMessageItems`: that one also seeds
 * edit-and-resend, where the composer must get the text the agent actually
 * received — a `@Reviewer` token with no committed mention range would be sent
 * verbatim as a word.
 */
export const getCopyTextFromMessageItems = (items: MessageContent[]): string =>
  items
    .map((content) =>
      content.type === 'text'
        ? collapseMentionSpansForCopy(content.text, content.spans)
        : getCopyableItemText(content)
    )
    .filter((text) => text.trim().length > 0)
    .join('\n\n');

export const hasTextContentFromMessageItems = (items: MessageContent[]): boolean =>
  items.some((content) => content.type === 'text' && content.text.trim().length > 0);

/**
 * The slice of a user message shown before "Show more", measured in what the
 * reader actually sees rather than in raw characters.
 *
 * A mention span costs its LABEL, not its text. That distinction is the whole
 * point for pasted text: a paste only becomes a draft above
 * `LARGE_PASTED_TEXT_MIN_CHAR_COUNT` (1024) characters, which is already past
 * this 900-character budget, so charging it by its raw length guaranteed that
 * every collapsed message containing a paste cut somewhere inside the blob.
 * The span then failed its `end <= text.length` check, was dropped, and the
 * bubble rendered 900 characters of raw pasted log — the exact thing the chip
 * exists to hide, shown only in the collapsed state.
 *
 * So a span is never cut. It is taken whole into the output text (the chip
 * covers that region, and expanding reveals it) while costing only its label
 * against the budget. Newlines inside a span do not count toward the line limit
 * for the same reason: a collapsed blob occupies one chip, not forty lines.
 */
export const getUserTextRenderSlice = (
  text: string,
  spans?: readonly { start: number; end: number; label: string }[]
): { text: string; spans?: MessageTextSpan[]; isTruncated: boolean } => {
  // No spans is not a special case: the loop below simply does not run, and the
  // tail slice past it is exactly the whole-text slice such a message needs.
  const resolved = sanitizeMessageTextSpans(text, spans) ?? [];

  let out = '';
  let copiedTo = 0;
  let charsUsed = 0;
  let linesUsed = 0;
  const keptSpans: MessageTextSpan[] = [];

  for (const span of resolved) {
    const run = sliceUserTextRun(
      text.slice(copiedTo, span.start),
      USER_TEXT_RENDER_CHAR_LIMIT - charsUsed,
      linesUsed
    );
    out += run.text;
    charsUsed += run.text.length;
    linesUsed += run.lineBreaks;
    if (run.isTruncated) {
      return { text: out, spans: keptSpans.length > 0 ? keptSpans : undefined, isTruncated: true };
    }

    // The label is what this region costs the reader; the region itself comes
    // along whole so the chip has something to cover.
    if (charsUsed + span.label.length > USER_TEXT_RENDER_CHAR_LIMIT) {
      return { text: out, spans: keptSpans.length > 0 ? keptSpans : undefined, isTruncated: true };
    }
    keptSpans.push({ ...span, start: out.length, end: out.length + (span.end - span.start) });
    out += text.slice(span.start, span.end);
    charsUsed += span.label.length;
    copiedTo = span.end;
  }

  const tail = sliceUserTextRun(
    text.slice(copiedTo),
    USER_TEXT_RENDER_CHAR_LIMIT - charsUsed,
    linesUsed
  );
  out += tail.text;
  return {
    text: out,
    spans: keptSpans.length > 0 ? keptSpans : undefined,
    isTruncated: tail.isTruncated,
  };
};

/** Cuts one span-free run at whichever of the two budgets runs out first. */
const sliceUserTextRun = (
  text: string,
  charBudget: number,
  linesUsed: number
): { text: string; isTruncated: boolean; lineBreaks: number } => {
  const charLimitEnd = Math.max(0, Math.min(text.length, charBudget));
  let lineBreaks = 0;

  for (let index = 0; index < charLimitEnd; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    lineBreaks += 1;
    if (linesUsed + lineBreaks >= USER_TEXT_RENDER_LINE_LIMIT) {
      return { text: text.slice(0, index), isTruncated: true, lineBreaks };
    }
  }

  if (charLimitEnd < text.length) {
    return { text: text.slice(0, charLimitEnd), isTruncated: true, lineBreaks };
  }
  return { text, isTruncated: false, lineBreaks };
};

export const getVisibleAssistantTextContent = (
  items: MessageContent[],
  isTurnFinished: boolean
): string =>
  getTextContentFromMessageItems(
    items.filter(
      (content, index) =>
        !shouldCollapseAssistantMessageItem({
          content,
          index,
          items,
          isTurnFinished,
        })
    )
  );
