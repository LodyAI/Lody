import { describe, expect, it } from 'vitest';
import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

import {
  applyTextRewrites,
  sanitizeMessageTextSpans,
  type MessageTextSpan,
} from '../src/message-text-spans';
import {
  historyItemsToInputBlocks,
  inputBlocksToHistoryItems,
  normalizeSessionInputBlocks,
} from '../src/session-input';
import { SessionInputBlocksSchema } from '../src/message-schemas';
import { sessionDocSchema } from '../src/schema';
import type { MessageContent, SessionId, SessionInputBlock } from '../src/ai';
import type { SessionDoc, SessionHistoryInput } from '../src/schema';

const TEXT = 'Compare @src/a.ts against #482';
const FILE_SPAN: MessageTextSpan = {
  start: 8,
  end: 17,
  kind: 'file',
  label: '@src/a.ts',
  target: 'src/a.ts',
};
const ISSUE_SPAN: MessageTextSpan = { start: 26, end: 30, kind: 'issue', label: '#482' };

describe('sanitizeMessageTextSpans', () => {
  it('drops the later of two overlapping spans, because renderers slice in order', () => {
    const overlapping = { start: 12, end: 20, kind: 'issue' as const, label: 'overlap' };
    expect(sanitizeMessageTextSpans(TEXT, [FILE_SPAN, overlapping, ISSUE_SPAN])).toEqual([
      FILE_SPAN,
      ISSUE_SPAN,
    ]);
  });

  it('keeps a frozen mark, and drops one that is not one short glyph', () => {
    // The mark is what a bubble paints instead of the kind's icon, so the only
    // real bar is that it cannot smuggle a line of text into a chip.
    expect(sanitizeMessageTextSpans(TEXT, [{ ...FILE_SPAN, mark: '🔍' }])).toEqual([
      { ...FILE_SPAN, mark: '🔍' },
    ]);
    expect(sanitizeMessageTextSpans(TEXT, [{ ...FILE_SPAN, mark: '' }])).toEqual([FILE_SPAN]);
    expect(sanitizeMessageTextSpans(TEXT, [{ ...FILE_SPAN, mark: 42 }])).toEqual([FILE_SPAN]);
    expect(sanitizeMessageTextSpans(TEXT, [{ ...FILE_SPAN, mark: 'x'.repeat(17) }])).toEqual([
      FILE_SPAN,
    ]);
  });
});

describe('applyTextRewrites', () => {
  it('shifts later spans by the length every earlier replacement added', () => {
    const source = 'run $review-diff on @src/a.ts';
    const result = applyTextRewrites(source, [
      {
        start: 4,
        end: 16,
        replacement: 'use /review-diff [Skill Path](.claude/skills/review-diff/SKILL.md)',
        span: { kind: 'skill', label: '$review-diff', target: 'review-diff' },
      },
      { start: 20, end: 29, span: { kind: 'file', label: '@src/a.ts', target: 'src/a.ts' } },
    ]);

    expect(result.text).toBe(
      'run use /review-diff [Skill Path](.claude/skills/review-diff/SKILL.md) on @src/a.ts'
    );
    // Both spans must still slice their own text back out of the *output*.
    for (const span of result.spans ?? []) {
      expect(result.text.slice(span.start, span.end).length).toBe(span.end - span.start);
    }
    const [skill, file] = result.spans ?? [];
    expect(result.text.slice(skill!.start, skill!.end)).toBe(
      'use /review-diff [Skill Path](.claude/skills/review-diff/SKILL.md)'
    );
    expect(result.text.slice(file!.start, file!.end)).toBe('@src/a.ts');
  });

  it('covers a replacement much longer than its placeholder', () => {
    const blob = 'x'.repeat(4182);
    const source = 'see [Pasted] please';
    const result = applyTextRewrites(source, [
      {
        start: 4,
        end: 12,
        replacement: blob,
        span: { kind: 'pasted_text', label: 'Pasted 4,182 chars' },
      },
    ]);
    expect(result.text).toBe(`see ${blob} please`);
    expect(result.spans).toEqual([
      { start: 4, end: 4 + blob.length, kind: 'pasted_text', label: 'Pasted 4,182 chars' },
    ]);
    expect(result.text.slice(4, 4 + blob.length)).toBe(blob);
  });
});

describe('session input block plumbing', () => {
  const block: SessionInputBlock = { type: 'text', text: TEXT, spans: [FILE_SPAN, ISSUE_SPAN] };

  it('carries a frozen mark all the way to a normalized block', () => {
    // The strict span schema and `sanitizeMessageTextSpans` have to agree on
    // every field. When they did not, the send path rejected the whole block
    // list over one unknown key and `normalizeSessionInputBlocks` fell back to
    // its empty prompt — the composer answered a real message with "please
    // enter something to discuss".
    const marked: SessionInputBlock = {
      type: 'text',
      text: TEXT,
      spans: [{ ...FILE_SPAN, mark: '🔍' }],
    };
    expect(SessionInputBlocksSchema.safeParse([marked]).success).toBe(true);
    expect(normalizeSessionInputBlocks([marked], '')).toEqual([marked]);
  });

  it('round-trips spans through history items and back', () => {
    const items = inputBlocksToHistoryItems([block]);
    expect(items[0]).toEqual({ type: 'text', text: TEXT, spans: [FILE_SPAN, ISSUE_SPAN] });
    expect(historyItemsToInputBlocks(items)).toEqual([block]);
  });

  it('re-anchors spans when the block text is trimmed on the way into history', () => {
    const padded: SessionInputBlock = {
      type: 'text',
      text: `  ${TEXT}  `,
      spans: [
        { ...FILE_SPAN, start: FILE_SPAN.start + 2, end: FILE_SPAN.end + 2 },
        { ...ISSUE_SPAN, start: ISSUE_SPAN.start + 2, end: ISSUE_SPAN.end + 2 },
      ],
    };
    expect(inputBlocksToHistoryItems([padded])[0]).toEqual({
      type: 'text',
      text: TEXT,
      spans: [FILE_SPAN, ISSUE_SPAN],
    });
  });

  it('discards spans a peer wrote that do not fit the stored text', () => {
    // Straight off the session document's untyped catchall — never schema-checked.
    const fromPeer = [{ type: 'text', text: TEXT, spans: [{ start: 0, end: 999, kind: 'file' }] }];
    expect(historyItemsToInputBlocks(fromPeer)).toEqual([{ type: 'text', text: TEXT }]);
  });

  it('leaves a pre-spans history item untouched', () => {
    expect(historyItemsToInputBlocks([{ type: 'text', text: TEXT }])).toEqual([
      { type: 'text', text: TEXT },
    ]);
  });
});

describe('session document persistence', () => {
  const entryWith = (items: MessageContent[]): SessionHistoryInput => ({
    id: 'h1',
    role: 'user',
    items,
    timestamp: '2026-08-12T00:00:00.000Z',
    status: 'pending',
    read: false,
    userId: 'user-1',
    fileDiff: [],
    finished: true,
  });

  const withMirror = (run: (mirror: Mirror<typeof sessionDocSchema>, doc: Loro) => void) => {
    const doc = new Loro();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    try {
      run(mirror, doc);
    } finally {
      mirror.dispose();
    }
  };

  const items = inputBlocksToHistoryItems([
    { type: 'text', text: TEXT, spans: [FILE_SPAN, ISSUE_SPAN] },
  ]) as MessageContent[];

  // `spans` is not declared in `historyMessageItemSchema`; it rides the
  // `.catchall(...)` that keeps the item forward-compatible. That catchall is
  // documented as risky for nested objects, so the nesting is covered here
  // rather than assumed.

  it('survives a snapshot export/import, which is where catchall inference has bitten before', () => {
    const doc = new Loro();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    mirror.setState((prev) => ({ ...prev, history: [entryWith(items)] }));
    const snapshot = doc.export({ mode: 'snapshot' });
    mirror.dispose();

    const revivedDoc = new Loro();
    revivedDoc.import(snapshot);
    const revived = new Mirror({
      doc: revivedDoc,
      schema: sessionDocSchema,
      throwOnValidationError: true,
    });
    try {
      const persisted = revived.getState().history[0]?.items?.[0] as MessageContent & {
        spans?: unknown;
      };
      expect(persisted.spans).toEqual([FILE_SPAN, ISSUE_SPAN]);
    } finally {
      revived.dispose();
    }
  });

  it('keeps spans intact when a later single-field update lands on the turn', () => {
    withMirror((mirror) => {
      mirror.setState((prev) => ({ ...prev, history: [entryWith(items)] }));
      mirror.setState((prev) => ({
        ...prev,
        history: prev.history.map((turn) => ({ ...turn, status: 'sent' as const })),
      }));

      const persisted = mirror.getState().history[0]?.items?.[0] as MessageContent & {
        spans?: unknown;
      };
      expect(persisted.spans).toEqual([FILE_SPAN, ISSUE_SPAN]);
    });
  });
});
