import { describe, expect, it } from 'vitest';
import {
  shortcutMentionRanges,
  shortcutTemplateMentions,
} from '../src/components/mentions/shortcut-template-ranges';
import { shortcutTemplateCategories } from '../src/components/mentions/mention-shortcut-template';
import type { MentionCategory } from '../src/components/mentions/mention-registry';

describe('Shortcut template mention policy', () => {
  it('disables unscoped categories, removes sessions/commands, and never invokes disabled sources', () => {
    const ids = ['file', 'issue', 'pr', 'skill', 'agent_role', 'session', 'command'] as const;
    const categories: MentionCategory[] = ids.map((id) => ({
      id,
      namespace: id,
      label: id,
      icon: id,
      status: 'ready',
      activation: {
        sourceKey: 'file',
        activate: () => {
          throw new Error('should not activate');
        },
      },
      getCandidates: () => {
        throw new Error('should not rank');
      },
    }));
    const result = shortcutTemplateCategories({
      categories,
      scope: {},
      skills: [],
      allowedDirs: null,
      disabledReason: 'Select scope',
    });
    expect(result.map((category) => [category.id, category.status])).toEqual([
      ['file', 'disabled'],
      ['issue', 'disabled'],
      ['pr', 'disabled'],
      ['skill', 'disabled'],
      ['agent_role', 'ready'],
    ]);
    for (const category of result.filter((item) => item.status === 'disabled')) {
      expect(category.activation).toBeUndefined();
      expect(category.getCandidates('query')).toEqual([]);
    }
  });
  it('freezes project identity on selection and does not rebind it when editor scope changes', () => {
    const file: MentionCategory = {
      id: 'file',
      namespace: 'file',
      label: 'Files',
      icon: 'file',
      status: 'ready',
      getCandidates: () => [
        {
          value: 'src/app.ts',
          label: 'src/app.ts',
          insertText: '@src/app.ts',
          kind: 'file',
          icon: 'file',
          title: 'src/app.ts',
        },
      ],
    };
    const category = shortcutTemplateCategories({
      categories: [file],
      scope: { project: { kind: 'github', repository: 'org/original' } },
      skills: [],
      allowedDirs: null,
      disabledReason: '',
    })[0]!;
    const candidate = category.getCandidates('')[0]!;
    const mention = shortcutTemplateMentions('@src/app.ts', [
      { start: 0, end: 11, value: candidate.value, kind: candidate.kind },
    ])[0]!;
    expect(mention.target).toEqual({
      kind: 'file',
      project: { kind: 'github', repository: 'org/original' },
      path: 'src/app.ts',
    });
    expect(shortcutTemplateMentions(mention.label, shortcutMentionRanges([mention]))).toEqual([
      mention,
    ]);
  });
});
