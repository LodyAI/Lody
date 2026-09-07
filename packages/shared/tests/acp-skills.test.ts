import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENTS_GLOBAL_SKILL_DIR,
  ALL_KNOWN_GLOBAL_SKILL_DIRS,
  ALL_KNOWN_SYSTEM_SKILL_DIRS,
  DEFAULT_GLOBAL_SKILL_DIR,
  DEFAULT_PROJECT_SKILL_DIR,
  applyProjectSkillsResultBudget,
  compareProjectSkillScope,
  extractProjectSkillMetadata,
  getRegisteredGlobalSkillDirs,
  getRegisteredSkillDirs,
  getRegisteredSystemSkillDirs,
  getSkillMarkdownBody,
  getSkillScanCandidateDirs,
  isRegisteredSkillAgentType,
  parseSkillFrontmatter,
} from '../src/acp/skills';
import { BUILTIN_AGENTS } from '../src/ai';

describe('getSkillMarkdownBody', () => {
  it('strips a leading frontmatter block and returns the trimmed body', () => {
    const md = '---\nname: x\ndescription: y\n---\n# Title\n\nBody text.\n';
    expect(getSkillMarkdownBody(md)).toBe('# Title\n\nBody text.');
  });

  it('returns the whole content when there is no frontmatter', () => {
    expect(getSkillMarkdownBody('# Just a body\n')).toBe('# Just a body');
  });

  it('returns empty string when the file is only frontmatter', () => {
    expect(getSkillMarkdownBody('---\nname: x\n---\n')).toBe('');
  });
});

describe('project skills helpers', () => {
  it('always includes the default project skill directory in scan candidates', () => {
    expect(getSkillScanCandidateDirs()).toContain(DEFAULT_PROJECT_SKILL_DIR);
    expect(getSkillScanCandidateDirs()).toContain('agent/skills');
    expect(getSkillScanCandidateDirs()).toContain('.claude/skills');
    expect(getSkillScanCandidateDirs()).toContain('.qwen/skills');
    expect(getSkillScanCandidateDirs()).toContain('skills/.system');
  });

  it('maps registered agents to provider-specific project directories', () => {
    const dirs = getRegisteredSkillDirs([
      { cliType: 'builtin', agentType: 'codex' },
      { cliType: 'builtin', agentType: 'claude' },
      { cliType: 'registry', agentType: 'qwen-code' },
      { cliType: 'registry', agentType: 'eve' },
      { cliType: 'custom', agentType: 'team-agent' },
    ]);

    expect([...dirs].sort()).toEqual(
      [DEFAULT_PROJECT_SKILL_DIR, '.claude/skills', '.qwen/skills', 'agent/skills'].sort()
    );
  });

  it('includes project .agents/skills only for agents with verified support', () => {
    const agents = [
      'amp-acp',
      'auggie',
      'autohand',
      'codex',
      'codex-acp',
      'cortex-code',
      'cursor',
      'fast-agent',
      'gemini',
      'github-copilot-cli',
      'goose',
      'kilo',
      'kimi',
      'kimi-code',
      'opencode',
      'pi-acp',
    ];

    for (const agentType of agents) {
      expect(
        getRegisteredSkillDirs([{ cliType: 'registry', agentType }]).has(DEFAULT_PROJECT_SKILL_DIR)
      ).toBe(true);
    }
  });

  it('does not assign project .agents/skills to unsupported or unconfirmed agents', () => {
    const agents = [
      'agoragentic-acp',
      'claude',
      'cline',
      'codebuddy-code',
      'deepagents',
      'devin',
      'factory-droid',
      'mistral-vibe',
      'qoder',
      'qwen-code',
      'team-agent',
    ];

    for (const agentType of agents) {
      expect(
        getRegisteredSkillDirs([{ cliType: 'registry', agentType }]).has(DEFAULT_PROJECT_SKILL_DIR)
      ).toBe(false);
    }
    expect([
      ...getRegisteredSkillDirs([{ cliType: 'registry', agentType: 'factory-droid' }]),
    ]).toEqual(['.factory/skills', '.agent/skills']);
  });

  it('includes all known current-user global directories in scan candidates', () => {
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).toContain(DEFAULT_AGENTS_GLOBAL_SKILL_DIR);
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).toContain(DEFAULT_GLOBAL_SKILL_DIR);
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).toContain('~/.claude/skills');
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).toContain('~/.cline/skills');
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).toContain('~/.kilo/skills');
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).toContain('~/.config/goose/skills');
  });

  it('maps registered agents to verified current-user global directories for UI annotation', () => {
    const agents = [
      { cliType: 'builtin' as const, agentType: 'codex' },
      { cliType: 'builtin' as const, agentType: 'claude' },
      { cliType: 'registry' as const, agentType: 'goose' },
      { cliType: 'registry' as const, agentType: 'opencode' },
      { cliType: 'custom' as const, agentType: 'team-agent' },
    ];

    expect([...getRegisteredGlobalSkillDirs(agents)].sort()).toEqual([
      DEFAULT_AGENTS_GLOBAL_SKILL_DIR,
      '~/.claude/skills',
      '~/.config/goose/skills',
      '~/.config/opencode/skills',
    ]);
    expect([
      ...getRegisteredGlobalSkillDirs([{ cliType: 'registry', agentType: 'amp-acp' }]),
    ]).toEqual([DEFAULT_GLOBAL_SKILL_DIR, '~/.claude/skills']);
  });

  it('does not assign the standard global alias to agents without verified support', () => {
    expect([
      ...getRegisteredGlobalSkillDirs([{ cliType: 'registry', agentType: 'cline' }]),
    ]).toEqual(['~/.cline/skills']);
    // Project dirs but no global dir at all — distinct from an all-empty mapping.
    expect([
      ...getRegisteredGlobalSkillDirs([{ cliType: 'registry', agentType: 'promptscript' }]),
    ]).toEqual([]);
    expect([
      ...getRegisteredSkillDirs([{ cliType: 'registry', agentType: 'promptscript' }]),
    ]).toEqual([DEFAULT_PROJECT_SKILL_DIR]);
    expect([
      ...getRegisteredGlobalSkillDirs([{ cliType: 'registry', agentType: 'deepagents' }]),
    ]).toEqual([]);
  });

  it('maps pi, grok, kimi, and deepseek to the shared ~/.agents/skills dir their engines scan', () => {
    for (const agentType of [
      'pi',
      'pi-acp',
      'grok',
      'kimi',
      'kimi-code',
      'kimi-code-cli',
      'deepseek',
    ]) {
      expect(
        getRegisteredGlobalSkillDirs([{ cliType: 'registry', agentType }]).has(
          DEFAULT_AGENTS_GLOBAL_SKILL_DIR
        )
      ).toBe(true);
    }
  });

  it('maps kimi to the .kimi-code brand dirs its engine scans, not the .kimi ones', () => {
    for (const agentType of ['kimi', 'kimi-code', 'kimi-code-cli']) {
      const agent = { cliType: 'registry' as const, agentType };
      expect([...getRegisteredSkillDirs([agent])].sort()).toEqual(
        [DEFAULT_PROJECT_SKILL_DIR, '.kimi-code/skills'].sort()
      );
      expect(getRegisteredGlobalSkillDirs([agent]).has('~/.kimi-code/skills')).toBe(true);
    }
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).not.toContain('~/.kimi/skills');
    expect(getSkillScanCandidateDirs()).not.toContain('.kimi/skills');
  });

  it('registers every builtin agent type so none falls back to an unfiltered menu', () => {
    for (const { agentType } of BUILTIN_AGENTS) {
      expect(isRegisteredSkillAgentType(agentType)).toBe(true);
    }
  });

  it('exposes codex built-in system skill dirs separate from global dirs', () => {
    expect(ALL_KNOWN_SYSTEM_SKILL_DIRS).toContain('~/.codex/skills/.system');
    // System dirs are their own scope; they must not leak into the global list.
    expect(ALL_KNOWN_GLOBAL_SKILL_DIRS).not.toContain('~/.codex/skills/.system');
  });

  it('maps only codex agents to their system skill directory', () => {
    expect([...getRegisteredSystemSkillDirs([{ cliType: 'builtin', agentType: 'codex' }])]).toEqual(
      ['~/.codex/skills/.system']
    );
    expect([
      ...getRegisteredSystemSkillDirs([{ cliType: 'registry', agentType: 'codex-acp' }]),
    ]).toEqual(['~/.codex/skills/.system']);
    expect([
      ...getRegisteredSystemSkillDirs([{ cliType: 'builtin', agentType: 'claude' }]),
    ]).toEqual([]);
    expect([
      ...getRegisteredSystemSkillDirs([{ cliType: 'registry', agentType: 'goose' }]),
    ]).toEqual([]);
  });

  it('orders skill scopes project → global → system', () => {
    expect(compareProjectSkillScope('project', 'global')).toBeLessThan(0);
    expect(compareProjectSkillScope('global', 'system')).toBeLessThan(0);
    expect(compareProjectSkillScope('system', 'project')).toBeGreaterThan(0);
    expect(['system', 'project', 'global'].sort(compareProjectSkillScope)).toEqual([
      'project',
      'global',
      'system',
    ]);
  });

  it('parses shallow frontmatter and nested metadata fields', () => {
    expect(
      parseSkillFrontmatter(`---
name: "Review Bot"
description: Checks risky diffs
metadata:
  version: 1.2.3
  author: Team AI
allowed-tools:
  - Read
---
# Body
`)
    ).toEqual({
      name: 'Review Bot',
      description: 'Checks risky diffs',
      metadata: {
        version: '1.2.3',
        author: 'Team AI',
      },
    });
  });

  it('extracts display metadata with documented fallbacks', () => {
    expect(
      extractProjectSkillMetadata(
        `---
description: Helps with tests
version: 2.0.0
metadata:
  author: QA
---
Body
`,
        'test-helper'
      )
    ).toEqual({
      name: 'test-helper',
      description: 'Helps with tests',
      version: '2.0.0',
      author: 'QA',
    });
  });

  it('fails on malformed frontmatter instead of silently guessing', () => {
    expect(() =>
      parseSkillFrontmatter(`---
name Skill
---
`)
    ).toThrow('Invalid SKILL.md frontmatter line');
  });

  it('drops skill content after the aggregate response budget is exhausted', () => {
    const groups = [
      {
        scope: 'project' as const,
        dir: '.agents/skills',
        truncated: false,
        skills: [
          {
            id: '.agents/skills/one',
            name: 'one',
            relativePath: '.agents/skills/one/SKILL.md',
            isSymlink: false,
            content: '1234',
          },
          {
            id: '.agents/skills/two',
            name: 'two',
            relativePath: '.agents/skills/two/SKILL.md',
            isSymlink: false,
            content: '5678',
          },
        ],
      },
    ];

    expect(applyProjectSkillsResultBudget(groups, { maxContentBytes: 4 })).toEqual([
      {
        scope: 'project',
        dir: '.agents/skills',
        truncated: false,
        skills: [
          {
            id: '.agents/skills/one',
            name: 'one',
            relativePath: '.agents/skills/one/SKILL.md',
            isSymlink: false,
            content: '1234',
          },
          {
            id: '.agents/skills/two',
            name: 'two',
            relativePath: '.agents/skills/two/SKILL.md',
            isSymlink: false,
          },
        ],
      },
    ]);
    expect(groups[0]?.skills[1]?.content).toBe('5678');
  });

  it('drops skills after the aggregate skill count budget is exhausted', () => {
    const groups = [
      {
        scope: 'project' as const,
        dir: '.agents/skills',
        truncated: false,
        skills: [
          {
            id: '.agents/skills/one',
            name: 'one',
            relativePath: '.agents/skills/one/SKILL.md',
            isSymlink: false,
          },
          {
            id: '.agents/skills/two',
            name: 'two',
            relativePath: '.agents/skills/two/SKILL.md',
            isSymlink: false,
          },
        ],
      },
      {
        scope: 'project' as const,
        dir: '.claude/skills',
        truncated: false,
        skills: [
          {
            id: '.claude/skills/three',
            name: 'three',
            relativePath: '.claude/skills/three/SKILL.md',
            isSymlink: false,
          },
          {
            id: '.claude/skills/four',
            name: 'four',
            relativePath: '.claude/skills/four/SKILL.md',
            isSymlink: false,
          },
        ],
      },
    ];

    expect(applyProjectSkillsResultBudget(groups, { maxSkills: 3 })).toEqual([
      groups[0],
      {
        scope: 'project',
        dir: '.claude/skills',
        truncated: true,
        skills: [
          {
            id: '.claude/skills/three',
            name: 'three',
            relativePath: '.claude/skills/three/SKILL.md',
            isSymlink: false,
          },
        ],
      },
    ]);
    expect(groups[1]?.skills).toHaveLength(2);
  });

  it('rejects invalid aggregate content budgets', () => {
    expect(() => applyProjectSkillsResultBudget([], { maxContentBytes: -1 })).toThrow(
      'Invalid project skills content budget'
    );
    expect(() => applyProjectSkillsResultBudget([], { maxSkills: -1 })).toThrow(
      'Invalid project skills skill count budget'
    );
  });
});
