import { describe, expect, it } from 'vitest';
import {
  applyTextRewrites,
  DEFAULT_AGENTS_GLOBAL_SKILL_DIR,
  type ProjectSkill,
  type ProjectSkillGroup,
} from '@lody/shared';
import {
  buildSkillMentionItems,
  buildSkillMentionRewrites,
  getAllowedSkillMentionDirs,
  getSkillMentionToken,
  hydrateSkillMentionsFromText,
  mergeMentionSkillState,
  selectSkillMentionCandidates,
} from '../src/components/mentions/mention-skill-source';

/** What the send path does with these rewrites, so the test asserts that. */
const expandInText = (
  text: string,
  items: Parameters<typeof buildSkillMentionRewrites>[1],
  allowedDirs: ReadonlySet<string> | null
) => applyTextRewrites(text, buildSkillMentionRewrites(text, items, allowedDirs)).text;

function skill(overrides: Partial<ProjectSkill> & { relativePath: string }): ProjectSkill {
  return {
    id: overrides.relativePath,
    name: overrides.name ?? 'skill',
    relativePath: overrides.relativePath,
    isSymlink: overrides.isSymlink ?? false,
    ...overrides,
  };
}

const GROUPS: ProjectSkillGroup[] = [
  {
    scope: 'project',
    dir: '.agents/skills',
    truncated: false,
    skills: [
      skill({ name: 'code-review', relativePath: '.agents/skills/code-review/SKILL.md' }),
      skill({ name: 'deep-research', relativePath: '.agents/skills/deep-research/SKILL.md' }),
    ],
  },
  {
    scope: 'project',
    dir: '.claude/skills',
    truncated: false,
    skills: [
      skill({ name: 'code-review', relativePath: '.claude/skills/code-review/SKILL.md' }),
      skill({ name: 'claude-only', relativePath: '.claude/skills/claude-only/SKILL.md' }),
    ],
  },
  {
    scope: 'project',
    dir: '.qwen/skills',
    truncated: false,
    skills: [skill({ name: 'qwen-only', relativePath: '.qwen/skills/qwen-only/SKILL.md' })],
  },
  {
    scope: 'global',
    dir: '~/.claude/skills',
    truncated: false,
    skills: [
      skill({ name: 'code-review', relativePath: '~/.claude/skills/code-review/SKILL.md' }),
      skill({
        name: 'global-only',
        relativePath: '~/.claude/skills/global-only/SKILL.md',
        absolutePath: '/home/user/.claude/skills/global-only/SKILL.md',
      }),
    ],
  },
];

describe('getSkillMentionToken', () => {
  it('uses the frontmatter name when whitespace-free', () => {
    expect(getSkillMentionToken({ name: 'code-review', relativePath: 'x/SKILL.md' })).toBe(
      'code-review'
    );
  });

  it('falls back to the directory basename when the name has spaces', () => {
    expect(
      getSkillMentionToken({ name: 'Deep Research', relativePath: '.agents/skills/deep/SKILL.md' })
    ).toBe('deep');
  });
});

describe('mergeMentionSkillState', () => {
  it('does not let an empty successful scope hide another scope failure', () => {
    expect(
      mergeMentionSkillState([
        { status: 'ready' },
        { status: 'error', error: 'Global skill scan failed' },
      ])
    ).toEqual({ status: 'error', error: 'Global skill scan failed' });
  });

  it('keeps loading and refreshing ahead of a settled scope error', () => {
    expect(
      mergeMentionSkillState([{ status: 'loading' }, { status: 'error', error: 'failed' }])
    ).toEqual({ status: 'loading' });
    expect(
      mergeMentionSkillState([{ status: 'refreshing' }, { status: 'error', error: 'failed' }])
    ).toEqual({ status: 'refreshing' });
  });
});

describe('buildSkillMentionItems', () => {
  it('keeps every skill (including cross-dir duplicates) with its dir', () => {
    const items = buildSkillMentionItems(GROUPS);
    // 7 skills total across the four groups, not deduped here.
    expect(items).toHaveLength(7);
    expect(
      items
        .filter((i) => i.token === 'code-review')
        .map((i) => i.dir)
        .sort()
    ).toEqual(['.agents/skills', '.claude/skills', '~/.claude/skills']);
  });
});

describe('getAllowedSkillMentionDirs', () => {
  it('returns no whitelist when the agent is unknown or only partly identified', () => {
    expect(getAllowedSkillMentionDirs(undefined)).toBeNull();
    expect(getAllowedSkillMentionDirs({ cliType: 'custom' })).toBeNull();
    expect(getAllowedSkillMentionDirs({ agentType: 'claude' })).toBeNull();
  });

  it('returns no whitelist for an unregistered agent type instead of an empty one', () => {
    // An empty-but-present whitelist filters every candidate out; `null` keeps
    // them. Custom agents get generated `custom-<uuid>` types.
    const allowed = getAllowedSkillMentionDirs({ cliType: 'custom', agentType: 'custom-2f1a' });
    expect(allowed).toBeNull();

    const items = buildSkillMentionItems(GROUPS);
    expect(selectSkillMentionCandidates(items, '', allowed).map((i) => i.token)).toEqual([
      'claude-only',
      'code-review',
      'deep-research',
      'global-only',
      'qwen-only',
    ]);
  });

  it('keeps an explicit empty whitelist for a registered agent that reads no skills', () => {
    const allowed = getAllowedSkillMentionDirs({ cliType: 'registry', agentType: 'deepagents' });
    expect(allowed).not.toBeNull();
    expect([...(allowed ?? [])]).toEqual([]);
    expect(selectSkillMentionCandidates(buildSkillMentionItems(GROUPS), '', allowed)).toEqual([]);
  });

  it('offers ~/.agents/skills to grok, pi, and kimi', () => {
    for (const agentType of ['grok', 'pi-acp', 'kimi-code']) {
      expect(getAllowedSkillMentionDirs({ cliType: 'registry', agentType })).toContain(
        DEFAULT_AGENTS_GLOBAL_SKILL_DIR
      );
    }
  });
});

describe('selectSkillMentionCandidates', () => {
  const items = buildSkillMentionItems(GROUPS);

  it('dedupes by token and returns all when no provider filter', () => {
    const result = selectSkillMentionCandidates(items, '', null);
    expect(result.map((i) => i.token)).toEqual([
      'claude-only',
      'code-review',
      'deep-research',
      'global-only',
      'qwen-only',
    ]);
  });

  it('filters to the selected provider directories', () => {
    // Claude provider → .claude/skills + ~/.claude/skills (not .agents/skills or .qwen/skills).
    const allowed = new Set(['.claude/skills', '~/.claude/skills']);
    const result = selectSkillMentionCandidates(items, '', allowed);
    const tokens = result.map((i) => i.token);
    expect(tokens).toContain('code-review');
    expect(tokens).not.toContain('deep-research');
    expect(tokens).toContain('claude-only');
    expect(tokens).toContain('global-only');
    expect(tokens).not.toContain('qwen-only');
  });

  it('allows project .agents/skills when the selected provider supports it', () => {
    const result = selectSkillMentionCandidates(items, '', new Set(['.agents/skills']));
    const tokens = result.map((i) => i.token);
    expect(tokens).toContain('code-review');
    expect(tokens).toContain('deep-research');
    expect(tokens).not.toContain('claude-only');
    expect(tokens).not.toContain('qwen-only');
  });

  it('includes global skill subdirectories under the selected provider root only', () => {
    const nestedItems = buildSkillMentionItems([
      ...GROUPS,
      {
        scope: 'global',
        dir: '~/.agents/skills/.system',
        truncated: false,
        skills: [
          skill({
            name: 'standard-system',
            relativePath: '~/.agents/skills/.system/standard-system/SKILL.md',
          }),
        ],
      },
      {
        scope: 'global',
        dir: '~/.agents/skills-extra',
        truncated: false,
        skills: [
          skill({
            name: 'standard-extra',
            relativePath: '~/.agents/skills-extra/standard-extra/SKILL.md',
          }),
        ],
      },
    ]);

    const result = selectSkillMentionCandidates(nestedItems, '', new Set(['~/.agents/skills']));
    const tokens = result.map((i) => i.token);
    expect(tokens).toContain('standard-system');
    expect(tokens).not.toContain('standard-extra');
  });

  it('prefers project skills over global duplicates', () => {
    const result = selectSkillMentionCandidates(items, 'code-review', null);
    expect(result[0]).toMatchObject({
      token: 'code-review',
      scope: 'project',
      dir: '.agents/skills',
    });
  });

  it('ranks prefix matches ahead of substring matches', () => {
    const result = selectSkillMentionCandidates(items, 'co', null);
    expect(result[0]?.token).toBe('code-review');
  });
});

describe('hydrateSkillMentionsFromText', () => {
  it('rebuilds ranges for known $tokens only', () => {
    const known = new Set(['code-review', 'deep-research']);
    const text = 'run $code-review then $unknown and $deep-research';
    const { mentions, values } = hydrateSkillMentionsFromText(text, known);
    expect(values.sort()).toEqual(['code-review', 'deep-research']);
    expect(mentions).toHaveLength(2);
    const first = mentions[0]!;
    expect(text.slice(first.start, first.end)).toBe('$code-review');
  });
});

describe('buildSkillMentionRewrites', () => {
  const items = buildSkillMentionItems(GROUPS);

  it('expands project skill tokens to relative skill paths', () => {
    expect(expandInText('run $deep-research', items, null)).toBe(
      'run use /deep-research [Skill Path](.agents/skills/deep-research/SKILL.md)'
    );
  });

  it('expands global skill tokens to absolute skill paths when present', () => {
    const result = expandInText(
      'run $global-only',
      items,
      new Set(['~/.claude/skills'])
    );

    expect(result).toBe(
      'run use /global-only [Skill Path](/home/user/.claude/skills/global-only/SKILL.md)'
    );
  });

  it('uses the selected provider directories before resolving duplicate tokens', () => {
    const result = expandInText(
      'run $code-review',
      items,
      new Set(['.claude/skills'])
    );

    expect(result).toBe('run use /code-review [Skill Path](.claude/skills/code-review/SKILL.md)');
  });

  it('does not expand an already annotated skill token again', () => {
    const text = 'run $deep-research [Skill Path](.agents/skills/deep-research/SKILL.md)';

    expect(expandInText(text, items, null)).toBe(text);
  });
});

describe('system scope skills', () => {
  const SYSTEM_GROUP: ProjectSkillGroup = {
    scope: 'system',
    dir: '~/.codex/skills/.system',
    truncated: false,
    skills: [
      skill({
        name: 'imagegen',
        relativePath: '~/.codex/skills/.system/imagegen/SKILL.md',
        absolutePath: '/home/user/.codex/skills/.system/imagegen/SKILL.md',
      }),
    ],
  };

  it('expands system skill tokens to their absolute SKILL.md path', () => {
    const items = buildSkillMentionItems([SYSTEM_GROUP]);
    expect(expandInText('run $imagegen', items, null)).toBe(
      'run use /imagegen [Skill Path](/home/user/.codex/skills/.system/imagegen/SKILL.md)'
    );
  });

  it('orders duplicate tokens project → global → system', () => {
    const items = buildSkillMentionItems([
      {
        scope: 'system',
        dir: '~/.codex/skills/.system',
        truncated: false,
        skills: [skill({ name: 'dup', relativePath: '~/.codex/skills/.system/dup/SKILL.md' })],
      },
      {
        scope: 'project',
        dir: '.agents/skills',
        truncated: false,
        skills: [skill({ name: 'dup', relativePath: '.agents/skills/dup/SKILL.md' })],
      },
      {
        scope: 'global',
        dir: '~/.claude/skills',
        truncated: false,
        skills: [skill({ name: 'dup', relativePath: '~/.claude/skills/dup/SKILL.md' })],
      },
    ]);

    expect(items.map((item) => item.scope)).toEqual(['project', 'global', 'system']);
  });
});
