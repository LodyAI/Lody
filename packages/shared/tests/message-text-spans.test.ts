import { describe, expect, it } from 'vitest';
import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

import {
  applyTextRewrites,
  reanchorMessageTextSpansForTrim,
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
  it('keeps well-formed spans sorted by start', () => {
    expect(sanitizeMessageTextSpans(TEXT, [ISSUE_SPAN, FILE_SPAN])).toEqual([
      FILE_SPAN,
      ISSUE_SPAN,
    ]);
  });

  it('returns undefined rather than an empty array so callers can omit the field', () => {
    expect(sanitizeMessageTextSpans(TEXT, [])).toBeUndefined();
    expect(sanitizeMessageTextSpans(TEXT, undefined)).toBeUndefined();
    expect(sanitizeMessageTextSpans(TEXT, 'nope')).toBeUndefined();
    expect(sanitizeMessageTextSpans(TEXT, [{ start: 0, end: 0, kind: 'file', label: 'x' }])).toBe(
      undefined
    );
  });

  it('drops spans that do not describe a real region of the text', () => {
    const spans = [
      { ...FILE_SPAN, end: TEXT.length + 1 }, // past the end
      { ...FILE_SPAN, start: 12, end: 9 }, // inverted
      { ...FILE_SPAN, start: 1.5 }, // non-integer
      { ...FILE_SPAN, start: -1 }, // negative
      { ...FILE_SPAN, kind: 'not-a-kind' }, // unknown kind
      { ...FILE_SPAN, label: '' }, // empty label
      { ...FILE_SPAN, target: 42 }, // wrong target type
      'not an object',
      null,
      ISSUE_SPAN,
    ];
    expect(sanitizeMessageTextSpans(TEXT, spans)).toEqual([ISSUE_SPAN]);
  });

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

  it('allows a span that starts exactly where the previous one ends', () => {
    const text = 'ab';
    const spans = [
      { start: 0, end: 1, kind: 'file' as const, label: 'a' },
      { start: 1, end: 2, kind: 'file' as const, label: 'b' },
    ];
    expect(sanitizeMessageTextSpans(text, spans)).toHaveLength(2);
  });
});

describe('reanchorMessageTextSpansForTrim', () => {
  it('shifts offsets left by the leading whitespace the trim removes', () => {
    const original = `\n\n  ${TEXT}  `;
    const leading = original.length - original.trimStart().length;
    const shifted = [
      { ...FILE_SPAN, start: FILE_SPAN.start + leading, end: FILE_SPAN.end + leading },
      { ...ISSUE_SPAN, start: ISSUE_SPAN.start + leading, end: ISSUE_SPAN.end + leading },
    ];

    expect(reanchorMessageTextSpansForTrim(original, original.trim(), shifted)).toEqual([
      FILE_SPAN,
      ISSUE_SPAN,
    ]);
  });

  it('drops spans that the trim swallowed', () => {
    const original = `   ${TEXT}`;
    // A span over the leading whitespace has nothing left to point at.
    const doomed = [{ start: 0, end: 3, kind: 'file' as const, label: 'gone' }];
    expect(reanchorMessageTextSpansForTrim(original, original.trim(), doomed)).toBeUndefined();
  });
});

describe('applyTextRewrites', () => {
  it('records where an identity rewrite landed', () => {
    expect(
      applyTextRewrites(TEXT, [
        { start: 8, end: 17, span: { kind: 'file', label: '@src/a.ts', target: 'src/a.ts' } },
      ])
    ).toEqual({ text: TEXT, spans: [FILE_SPAN] });
  });

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

  it('applies a rewrite that carries no span', () => {
    const result = applyTextRewrites('a b', [{ start: 0, end: 1, replacement: 'zzz' }]);
    expect(result).toEqual({ text: 'zzz b', spans: undefined });
  });

  it('drops a rewrite that overlaps an earlier one', () => {
    const result = applyTextRewrites(TEXT, [
      { start: 8, end: 17, span: { kind: 'file', label: '@src/a.ts' } },
      { start: 12, end: 20, replacement: 'NOPE', span: { kind: 'issue', label: 'overlap' } },
    ]);
    expect(result.text).toBe(TEXT);
    expect(result.spans).toHaveLength(1);
  });

  it('emits no span for a replacement that deletes its region', () => {
    const result = applyTextRewrites(TEXT, [
      { start: 8, end: 17, replacement: '', span: { kind: 'file', label: 'gone' } },
    ]);
    expect(result.text).toBe('Compare  against #482');
    expect(result.spans).toBeUndefined();
  });

  it('is a no-op without rewrites', () => {
    expect(applyTextRewrites(TEXT, [])).toEqual({ text: TEXT, spans: undefined });
  });
});

describe('session input block plumbing', () => {
  const block: SessionInputBlock = { type: 'text', text: TEXT, spans: [FILE_SPAN, ISSUE_SPAN] };

  it('accepts spans through the strict input-block schema', () => {
    const parsed = SessionInputBlocksSchema.safeParse([block]);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data[0]).toEqual(block);
  });

  it('still accepts a text block with no spans at all', () => {
    const parsed = SessionInputBlocksSchema.safeParse([{ type: 'text', text: TEXT }]);
    expect(parsed.success).toBe(true);
  });

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

  it('rejects a malformed span rather than silently stripping it', () => {
    const parsed = SessionInputBlocksSchema.safeParse([
      { type: 'text', text: TEXT, spans: [{ start: 0, end: 4, kind: 'file' }] },
    ]);
    expect(parsed.success).toBe(false);
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
  it('persists spans through the schema catchall', () => {
    withMirror((mirror) => {
      expect(() => {
        mirror.setState((prev) => ({ ...prev, history: [entryWith(items)] }));
      }).not.toThrow();

      const persisted = mirror.getState().history[0]?.items?.[0] as MessageContent & {
        spans?: unknown;
      };
      expect(persisted.type).toBe('text');
      expect(persisted.spans).toEqual([FILE_SPAN, ISSUE_SPAN]);
    });
  });

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
