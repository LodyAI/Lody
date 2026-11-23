import { describe, expect, it } from 'vitest';
import { applyTextRewrites, reanchorMessageTextSpansForTrim } from '@lody/shared';
import { buildVerbatimMentionRewrites } from '../src/components/mentions/mention-expansion';
import {
  buildSkillMentionRewrites,
  type SkillMentionItem,
} from '../src/components/mentions/mention-skill-source';
import { buildSessionMentionRewrites } from '../src/components/mentions/mention-session-source';
import { buildPastedTextRewrites, type PastedTextDraft } from '../src/lib/pasted-text-draft';
import type { Mention as MentionRange } from '../src/ui/mention/index';
import {
  latchHydrationText,
  mergeHydratedMentions,
  shouldRunHydration,
} from '../src/components/mentions/mention-hydration';
import {
  sanitizeMentionRanges,
  toPersistedMentionRanges,
} from '../src/components/mentions/mention-persistence';

describe('mention-prompt-spans', () => {
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
          {
            value: 'src/a.ts',
            start: text.indexOf('@src/a.ts'),
            end: text.indexOf('@src/a.ts') + 9,
            kind: 'file',
          },
          {
            value: 'sess-9f2c',
            start: text.indexOf('@my-run'),
            end: text.indexOf('@my-run') + 7,
            kind: 'session',
          },
          { value: '42', start: text.indexOf('#42'), end: text.indexOf('#42') + 3, kind: 'issue' },
        ],
      });

      // The agent sees every expansion.
      expect(result.text).toContain(PASTED_BLOB);
      expect(result.text).toContain('use /review [Skill Path](.claude/skills/review/SKILL.md)');
      expect(result.text).toContain('[@my-run](lody://session/sess-9f2c)');

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

    it('survives the trim the send path applies before building the text block', () => {
      const text = '\n  see @src/a.ts  \n';
      const result = expand({
        text,
        mentions: [
          {
            value: 'src/a.ts',
            start: text.indexOf('@src/a.ts'),
            end: text.indexOf('@src/a.ts') + 9,
            kind: 'file',
          },
        ],
      });
      const trimmed = result.text.trim();
      const spans = reanchorMessageTextSpansForTrim(result.text, trimmed, result.spans);
      expect(trimmed.slice(spans![0]!.start, spans![0]!.end)).toBe('@src/a.ts');
    });
  });
});

describe('mention-hydration', () => {
  /**
   * A persisted draft does not exist on the composer's first render: the landing
   * draft lives in `atomWithStorage`, which initialises with its default and only
   * reads storage in `onMount`. So the first text a hydrator sees is `''`, and
   * the whole question is whether it commits to that.
   */
  describe('when a hydrator commits to a text', () => {
    it('ignores the empty first render and latches the draft that arrives after it', () => {
      let latched = latchHydrationText('', '');
      expect(latched).toBe('');
      expect(shouldRunHydration(latched, '', false)).toBe(false);

      // The stored draft lands a tick later.
      latched = latchHydrationText(latched, 'see @src/a.ts');
      expect(latched).toBe('see @src/a.ts');
      expect(shouldRunHydration(latched, 'see @src/a.ts', false)).toBe(true);
    });

    it('waits while the text differs from the snapshot the offsets were measured against', () => {
      expect(shouldRunHydration('see @src/a.ts', 'see @src/a.ts and more', false)).toBe(false);
    });

    it('waits while the mention menu is open, which is about to commit its own range', () => {
      expect(shouldRunHydration('see @src/a.ts', 'see @src/a.ts', true)).toBe(false);
    });
  });

  describe('merging hydrated ranges', () => {
    const file = { start: 4, end: 11, value: 'fix-ci', kind: 'file' };

    it('rejects a range overlapping one already present, not just an identical one', () => {
      // A path and a session slug are the same shape, so `@fix-ci` can be a known
      // file to one hydrator and a known session to another, at different ends.
      // Both surviving means the renderer silently drops one and the draft stores
      // the pair.
      const session = { start: 4, end: 11, value: 'ses_1', kind: 'session' };
      expect(mergeHydratedMentions([file], [session])).toEqual([file]);
      expect(mergeHydratedMentions([file], [{ ...session, end: 13 }])).toEqual([file]);
      expect(mergeHydratedMentions([file], [{ ...session, start: 8, end: 20 }])).toEqual([file]);
    });

    it('lets what is already there win, which is what makes scanning the fallback', () => {
      const restored = { start: 4, end: 11, value: 'ses_1', kind: 'session' };
      // Restored-from-draft is present first; a scanner may only fill gaps.
      expect(mergeHydratedMentions([restored], [file])).toEqual([restored]);
    });
  });
});

describe('mention-persistence', () => {
  const TEXT = 'see @src/a.ts and #482';

  describe('toPersistedMentionRanges', () => {
    it('drops pasted text, which the pasted-text drafts already own', () => {
      // Persisting both would let the two disagree the moment one is edited.
      expect(
        toPersistedMentionRanges([{ start: 0, end: 8, value: 'paste-1', kind: 'pasted_text' }])
      ).toEqual([]);
    });
  });

  describe('sanitizeMentionRanges', () => {
    const file = { start: 4, end: 13, value: 'src/a.ts', kind: 'file' };
    const issue = { start: 18, end: 22, value: '#482', kind: 'issue' };

    it('drops a range whose offsets no longer fit, rather than clamping it', () => {
      // Stored against text that has since been edited elsewhere. Decorating the
      // wrong characters is worse than decorating none.
      expect(sanitizeMentionRanges('short', [file])).toEqual([]);
    });

    it('drops the later of two overlapping ranges', () => {
      expect(sanitizeMentionRanges(TEXT, [file, { ...issue, start: 8 }])).toEqual([file]);
    });
  });
});
