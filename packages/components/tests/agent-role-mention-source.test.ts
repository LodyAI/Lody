import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  DEFAULT_AGENT_ROLE_EMOJI,
  applyTextRewrites,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { buildAgentRoleCandidates } from '../src/components/mentions/mention-registry';
import {
  buildAgentRoleMentionContext,
  buildAgentRoleMentionItems,
  buildAgentRoleMentionPrompt,
  buildAgentRoleMentionRewrites,
  hydrateAgentRoleMentionsFromText,
  resolveAgentRoleMentionScope,
  selectAgentRoleMentionCandidates,
  type AgentRoleMentionItem,
} from '../src/components/mentions/mention-agent-role-source';

const machineId = 'machine-1' as MachineId;

const role = (overrides: Partial<AgentRole> = {}): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6', configOptionValues: { thought_level: 'high' } },
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const agentConfig = { cliType: 'builtin', agentType: 'codex', env: {}, name: 'Codex' } as const;

const items = (...roles: AgentRole[]): AgentRoleMentionItem[] =>
  buildAgentRoleMentionItems(roles, {
    machine: () => ({ name: 'Studio' }),
    agentConfig: () => agentConfig,
  });

describe('agent role mention work context', () => {
  it('pins a local project to its own machine', () => {
    expect(
      buildAgentRoleMentionContext({
        mentionSource: {
          kind: 'local',
          machineId: 'machine-2' as MachineId,
          workspaceId: 'w' as WorkspaceId,
          localProjectId: 'p' as LocalProjectId,
        },
        currentMachineId: machineId,
      })
    ).toEqual({ kind: 'machine', machineId: 'machine-2' });
  });

  it('retains local-project pinning while a live provider serves its files', () => {
    expect(
      buildAgentRoleMentionContext({
        mentionSource: {
          kind: 'provider',
          localProject: {
            machineId: 'machine-2' as MachineId,
            localProjectId: 'p' as LocalProjectId,
          },
          githubRepoFullName: 'loro-dev/lody',
        },
        currentMachineId: machineId,
      })
    ).toEqual({ kind: 'machine', machineId: 'machine-2' });
  });

  it('lets a github project reach every authorized machine', () => {
    const context = buildAgentRoleMentionContext({
      mentionSource: { kind: 'github', repoFullName: 'loro-dev/lody' },
      currentMachineId: machineId,
    });
    expect(context).toEqual({ kind: 'github' });
    const authorized = new Set([machineId, 'machine-2' as MachineId]);
    expect(resolveAgentRoleMentionScope(context, authorized)).toEqual({
      kind: 'authorized_machines',
      machineIds: authorized,
    });
  });

  it('pins a github session that is checked out on a machine', () => {
    expect(
      buildAgentRoleMentionContext({
        mentionSource: {
          kind: 'github',
          repoFullName: 'loro-dev/lody',
          localWorktree: {
            machineId: 'machine-3' as MachineId,
            repoKey: 'repo',
            sessionId: 's' as SessionId,
          },
        },
        currentMachineId: machineId,
      })
    ).toEqual({ kind: 'machine', machineId: 'machine-3' });
  });

  it('keeps a plain chat on the current machine, and offers nothing without one', () => {
    expect(
      buildAgentRoleMentionContext({ mentionSource: undefined, currentMachineId: machineId })
    ).toEqual({ kind: 'machine', machineId });
    expect(
      resolveAgentRoleMentionScope(
        buildAgentRoleMentionContext({ mentionSource: undefined, currentMachineId: undefined }),
        new Set([machineId])
      )
    ).toEqual({ kind: 'machine', machineId: null });
  });
});

describe('agent role candidates', () => {
  it('derives the token from the name, whitespace and all', () => {
    expect(items(role({ name: 'Code Reviewer' }))[0]?.slug).toBe('Code-Reviewer');
  });

  it('ranks a prefix match over a substring one, on token or name', () => {
    const list = items(
      role({ id: 'a' as AgentRoleId, name: 'Deep reviewer' }),
      role({ id: 'b' as AgentRoleId, name: 'Reviewer' })
    );
    expect(selectAgentRoleMentionCandidates(list, 'rev').map((item) => item.slug)).toEqual([
      'Reviewer',
      'Deep-reviewer',
    ]);
    expect(selectAgentRoleMentionCandidates(list, 'nope')).toEqual([]);
  });

  it('caps the row count', () => {
    const many = items(
      ...Array.from({ length: 60 }, (_unused, index) =>
        role({ id: `role-${index}` as AgentRoleId, name: `Reviewer ${index}` })
      )
    );
    expect(selectAgentRoleMentionCandidates(many, '')).toHaveLength(50);
  });
});

describe('agent role menu rows', () => {
  it('carries the role own mark instead of the category glyph', () => {
    const [candidate] = buildAgentRoleCandidates(items(role({ emoji: '🔍' })), '');
    expect(candidate).toMatchObject({
      iconEmoji: '🔍',
      // The name alone: the emoji is the row's icon, not a prefix on the text.
      title: 'Code Reviewer',
      insertText: '@Code-Reviewer',
      value: 'role-1',
    });
    // Nothing restated in the detail: the pane heads itself with the same mark
    // and name.
    expect(candidate?.detail?.title).toBeUndefined();
  });

  it('hands the Role to the shared pane instead of restating it as rows', () => {
    const withPrompt = role({ promptPrefix: 'Check correctness before style.' });
    const [candidate] = buildAgentRoleCandidates(items(withPrompt), '');
    // The pane reads the Role itself — including its instruction — resolving
    // each stored id against the BOUND agent's capabilities. Generic rows here
    // could only print those ids raw, which is how this menu ended up labelling
    // the permission mode "Reasoning".
    expect(candidate?.detail?.agentRole).toEqual({
      role: withPrompt,
      agentConfig,
      machine: { name: 'Studio' },
      // Named because this menu spans machines, unlike the composer's list.
      machineLabel: 'Studio',
    });
    expect(candidate?.detail?.rows).toBeUndefined();
    // No badges at all: every Role the menu offers is one this user may run, so
    // visibility changes nothing about accepting it.
    expect(candidate?.detail?.badges).toBeUndefined();
  });

  it('falls back to the shared default mark', () => {
    const [candidate] = buildAgentRoleCandidates(items(role({ emoji: undefined })), '');
    expect(candidate?.iconEmoji).toBe(DEFAULT_AGENT_ROLE_EMOJI);
  });
});

describe('agent role before-send expansion', () => {
  const text = 'please @Code-Reviewer this diff';
  const mention = { start: 7, end: 21, kind: 'agent_role', value: 'role-1' };

  it('rewrites the range into an id-bearing instruction and keeps the chip label', () => {
    const expanded = applyTextRewrites(
      text,
      buildAgentRoleMentionRewrites(text, [mention], items(role()))
    );
    expect(expanded.text).toBe(
      `please ${buildAgentRoleMentionPrompt({ id: 'role-1', name: 'Code Reviewer' })} this diff`
    );
    expect(expanded.spans).toEqual([
      {
        start: 7,
        end: 7 + buildAgentRoleMentionPrompt({ id: 'role-1', name: 'Code Reviewer' }).length,
        kind: 'agent_role',
        label: 'Code-Reviewer',
        target: 'role-1',
        // Frozen with the span so the bubble paints without the catalog.
        mark: '🔍',
      },
    ]);
  });

  it('carries no run configuration into the instruction', () => {
    const prompt = buildAgentRoleMentionPrompt({ id: 'role-1', name: 'Code Reviewer' });
    expect(prompt).not.toContain('gpt-5.6');
    expect(prompt).not.toContain('machine-1');
    expect(prompt).not.toContain('config-1');
  });

  it('leaves a role that is no longer offered as plain text', () => {
    expect(buildAgentRoleMentionRewrites(text, [mention], [])).toEqual([]);
  });
});

describe('agent role draft hydration', () => {
  it('recognises a known token and yields a range carrying the role id', () => {
    expect(hydrateAgentRoleMentionsFromText('ping @Code-Reviewer now', items(role()))).toEqual({
      mentions: [{ value: 'role-1', start: 5, end: 19, kind: 'agent_role' }],
      values: ['role-1'],
    });
  });

  it('leaves a token the file source already knows to the file hydrator', () => {
    expect(
      hydrateAgentRoleMentionsFromText(
        'open @Code-Reviewer',
        items(role()),
        new Set(['Code-Reviewer'])
      ).mentions
    ).toEqual([]);
  });

  it('claims nothing when no role is offered', () => {
    expect(hydrateAgentRoleMentionsFromText('@Code-Reviewer', [])).toEqual({
      mentions: [],
      values: [],
    });
  });
});
