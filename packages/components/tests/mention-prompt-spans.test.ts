import { describe, expect, it } from 'vitest';
import { applyTextRewrites, reanchorMessageTextSpansForTrim } from '@lody/shared';

import { buildVerbatimMentionRewrites } from '../src/components/mentions/mention-expansion';
import { buildSkillMentionRewrites } from '../src/components/mentions/mention-skill-source';
import { buildSessionMentionRewrites } from '../src/components/mentions/mention-session-source';
import { buildPastedTextRewrites } from '../src/lib/pasted-text-draft';
import type { SkillMentionItem } from '../src/components/mentions/mention-skill-source';
import type { PastedTextDraft } from '../src/lib/pasted-text-draft';
import type { Mention as MentionRange } from '../src/ui/mention/index';

/**
 * The before-send rewrite, assembled the way the two send paths assemble it.
 *
 * The hook itself only supplies data (project skills, session slugs); the
 * composition under test is the part that can silently produce a span pointing
 * at the wrong characters, so it is exercised directly rather than through a
 * rendered composer.
 */

const skillItem = (token: string, relativePath: string): SkillMentionItem => ({
  token,
  dir: '.claude/skills',
  scope: 'project',
  skill: { name: token, relativePath, description: '' } as SkillMentionItem['skill'],
});

const PASTED_BLOB = 'line one\nline two\nline three';

const expand = ({
  text,
  mentions = [],
  drafts = [],
  skills = [],
}: {
  text: string;
  mentions?: MentionRange[];
  drafts?: PastedTextDraft[];
  skills?: SkillMentionItem[];
}) =>
  applyTextRewrites(text, [
    ...buildPastedTextRewrites(drafts),
    ...buildSkillMentionRewrites(text, skills, null),
    ...buildSessionMentionRewrites(text, mentions),
    ...buildVerbatimMentionRewrites(text, mentions),
  ]);

/** Every span must still slice its own label's region out of the OUTPUT. */
const expectSpansAddressOutput = (result: ReturnType<typeof expand>) => {
  for (const span of result.spans ?? []) {
    expect(span.end).toBeLessThanOrEqual(result.text.length);
    expect(result.text.slice(span.start, span.end)).not.toBe('');
  }
};

describe('before-send mention rewrite', () => {
  it('leaves text with no mentions completely alone', () => {
    expect(expand({ text: 'just a prompt' })).toEqual({ text: 'just a prompt', spans: undefined });
  });

  it('records a verbatim mention without touching the text', () => {
    const text = 'look at @src/a.ts';
    const result = expand({
      text,
      mentions: [{ value: 'src/a.ts', start: 8, end: 17, kind: 'file' }],
    });
    expect(result.text).toBe(text);
    expect(result.spans).toEqual([
      { start: 8, end: 17, kind: 'file', label: '@src/a.ts', target: 'src/a.ts' },
    ]);
  });

  it('ignores a range whose kind owns its own rewrite, so the two cannot collide', () => {
    const text = 'run $review on it';
    const result = expand({
      text,
      // The composer records a `skill` range for `$review`; the skill builder
      // rewrites the same region. Only one of them may claim it.
      mentions: [{ value: 'review', start: 4, end: 11, kind: 'skill' }],
      skills: [skillItem('review', '.claude/skills/review/SKILL.md')],
    });
    expect(result.text).toBe(
      'run use /review [Skill Path](.claude/skills/review/SKILL.md) on it'
    );
    expect(result.spans).toHaveLength(1);
    expect(result.spans?.[0]).toMatchObject({ kind: 'skill', label: '$review' });
    expectSpansAddressOutput(result);
  });

  it('keeps every span addressing the output when rewrites of different lengths mix', () => {
    const text = 'see @src/a.ts and [Pasted] then $review for @my-run and #42';
    const drafts: PastedTextDraft[] = [
      {
        id: 'paste-1',
        text: PASTED_BLOB,
        displayText: '[Pasted]',
        start: text.indexOf('[Pasted]'),
        end: text.indexOf('[Pasted]') + '[Pasted]'.length,
      },
    ];
    const result = expand({
      text,
      drafts,
      skills: [skillItem('review', '.claude/skills/review/SKILL.md')],
      mentions: [
        { value: 'src/a.ts', start: text.indexOf('@src/a.ts'), end: text.indexOf('@src/a.ts') + 9, kind: 'file' },
        { value: 'sess-9f2c', start: text.indexOf('@my-run'), end: text.indexOf('@my-run') + 7, kind: 'session' },
        { value: '42', start: text.indexOf('#42'), end: text.indexOf('#42') + 3, kind: 'issue' },
      ],
    });

    // The agent sees every expansion.
    expect(result.text).toContain(PASTED_BLOB);
    expect(result.text).toContain('use /review [Skill Path](.claude/skills/review/SKILL.md)');
    expect(result.text).toContain('use lody mcp to query session[id: sess-9f2c] history');

    // The transcript sees what the user typed, in order, addressing the output.
    expect(result.spans?.map((span) => [span.kind, span.label])).toEqual([
      ['file', '@src/a.ts'],
      ['pasted_text', '[Pasted]'],
      ['skill', '$review'],
      ['session', 'my-run'],
      ['issue', '#42'],
    ]);
    expectSpansAddressOutput(result);
    expect(result.text.slice(result.spans![1]!.start, result.spans![1]!.end)).toBe(PASTED_BLOB);
    expect(result.text.slice(result.spans![4]!.start, result.spans![4]!.end)).toBe('#42');
  });

  it('leaves a session token with no committed range alone', () => {
    // Typed by hand, or hydrated against nothing: with no range there is no id,
    // and a stale token the agent can ignore beats a guessed session.
    const text = 'for @my-run, ok';
    expect(expand({ text })).toEqual({ text, spans: undefined });
  });

  it('does not depend on the order the contributors run in', () => {
    const text = 'a [Pasted] b $review c';
    const drafts: PastedTextDraft[] = [
      { id: 'p', text: PASTED_BLOB, displayText: '[Pasted]', start: 2, end: 10 },
    ];
    const skills = [skillItem('review', '.claude/skills/review/SKILL.md')];

    const pastedFirst = applyTextRewrites(text, [
      ...buildPastedTextRewrites(drafts),
      ...buildSkillMentionRewrites(text, skills, null),
    ]);
    const skillFirst = applyTextRewrites(text, [
      ...buildSkillMentionRewrites(text, skills, null),
      ...buildPastedTextRewrites(drafts),
    ]);
    expect(skillFirst).toEqual(pastedFirst);
  });

  it('survives the trim the send path applies before building the text block', () => {
    const text = '\n  see @src/a.ts  \n';
    const result = expand({
      text,
      mentions: [{ value: 'src/a.ts', start: text.indexOf('@src/a.ts'), end: text.indexOf('@src/a.ts') + 9, kind: 'file' }],
    });
    const trimmed = result.text.trim();
    const spans = reanchorMessageTextSpansForTrim(result.text, trimmed, result.spans);
    expect(trimmed.slice(spans![0]!.start, spans![0]!.end)).toBe('@src/a.ts');
  });

  it('drops a stale range that no longer fits the text it was recorded against', () => {
    const result = expand({
      text: 'short',
      mentions: [{ value: 'gone', start: 40, end: 60, kind: 'file' }],
    });
    expect(result).toEqual({ text: 'short', spans: undefined });
  });
});
