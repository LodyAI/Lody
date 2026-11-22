# Today conversation mentions: one marked character in node text

Status: implemented
Translation: current

[中文](2026-11-20-today-inline-mentions.zh.md)

## Abstract

Today first referenced a conversation with a whole-row node kind (`sessionId` in the
node's data), which could not hold text before or after the reference. The owner asked
for inline mentions inside sentences, so each mention is now one U+FFFC character of the
node's `LoroText` carrying the mark `mention = {kind, id}` with `expand: 'none'`, and the
row kind is removed (no Today data had shipped). The format keeps a mention atomic under
concurrent edits, undo and cross-node moves, at the cost that every reader and writer of
node text must go through the rich helpers instead of `toString()` slicing.

## Decision

- A mention is exactly one U+FFFC with the `mention` mark; `readTodayText` and
  `insertTodayRich` (`packages/shared/src/today-outline.ts`) are the only reader and
  writer. Split, merge and paste move rich text with them, never plain strings.
- Writers call `configureTodayTextStyles` (inside `openTodayOutline`) before marking:
  Loro rejects a mark without a configured style. Peers that never configured it still
  merge correctly because `expand` travels with each mark op.
- Readers split delta spans per character: two adjacent mentions of one conversation
  merge into a single span. A mark on any other character is ignored; an unmarked U+FFFC
  reads as a placeholder (`kind: ''`) and is never written back as a mark.
- The Lexical binding diffs rich text (character and mention per position), so deleting
  one of two adjacent mentions, or replacing one in place, writes the right splice.
- Plain text (copy, Convert to task prompt) writes `[@Title](lody://session/<id>?workspace=<id>)`;
  the clipboard payload is `v: 2` with mentions and still reads `v: 1` session rows.

## Alternatives

- Marking the title text: concurrent inserts inside the title inherit the mark, a partial
  delete leaves half a mention, and the stored title goes stale.
- A separate list of ranges: every edit must shift offsets by hand, which neither Loro's
  concurrent merge nor its undo keeps in step.
- Storing the link text: not atomic, variable length, and concurrent edits can split it.

## Consequences

Each mention is one caret position on both sides (Lexical's `MentionDecoratorNode` has
text U+FFFC), so offsets need no conversion. Probed on loro-crdt 1.17: undo restores the
character with its mark; one peer deleting a mention while another types after it leaves
no residue; `sliceDelta`/`applyDelta` carry attributes.

## Verification

`packages/shared/tests/today-outline.test.ts` (split, merge, paste, adjacent mentions,
unconfigured peer, concurrent delete, undo), `packages/components/tests/today-editor.test.ts`
(rich binding, mention keys), `packages/components/tests/today-block-selection.test.ts`
(clipboard v1/v2, links), and the `Today/With conversations` story. Not verified: IME
composition directly before or on a selected mention in WebKit.
