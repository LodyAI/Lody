import { describe, expect, it } from 'vitest';
import {
  buildAppActionLink,
  buildSessionLink,
  isAppResourceLink,
  parseAppActionLink,
  parseSessionLink,
  resolveSessionLinkId,
} from '../src/session-link';
import { normalizeSessionLinksForExport } from '../src/session-link-export';

describe('session resource links', () => {
  it.each([
    ['See session://abc.', 'See lody://session/abc?workspace=ws.'],
    ['**session://abc**', '**lody://session/abc?workspace=ws**'],
    ['_session://abc_', '_lody://session/abc?workspace=ws_'],
    ['session://abc，后续', 'lody://session/abc?workspace=ws，后续'],
    ['https://example.test/session://abc', 'https://example.test/session://abc'],
    ['No links or only https://example.test', 'No links or only https://example.test'],
  ])('normalizes prose without absorbing Markdown delimiters: %s', (source, expected) => {
    expect(normalizeSessionLinksForExport(source, 'ws')).toBe(expected);
  });
  it('exports portable links without rebinding explicit workspaces or changing code', () => {
    const source = [
      '[@Old](session://Child_A)',
      '[Other](lody-oss://session/B?workspace=foreign)',
      '`session://inline` and ``session://double``',
      '`multiline\nsession://example`',
      '> ```md\n> [Example](session://quoted)\n> ```',
      '<!-- session://comment -->',
      '[External](https://example.test/?next=session://keep)',
      '```md',
      '[Example](session://example)',
      '```',
      '    session://indented',
      'session://invalid/path',
    ].join('\n');
    expect(normalizeSessionLinksForExport(source, 'ws_1')).toBe(
      source
        .replace('session://Child_A', 'lody://session/Child_A?workspace=ws_1')
        .replace('lody-oss://', 'lody://')
    );
    expect(normalizeSessionLinksForExport('[Old](session://A)')).toBe('[Old](lody://session/A)');
  });
  it('emits only the exact conversation ID, including when normalizing a legacy selector', () => {
    const target = { sessionId: 'Root_A', workspaceId: 'lw_One', tabSessionId: 'Child_B' };
    const canonical = 'lody://session/Child_B?workspace=lw_One';
    expect(buildSessionLink(target)).toBe(canonical);
    expect(parseSessionLink(canonical)).toEqual({ sessionId: 'Child_B', workspaceId: 'lw_One' });
    expect(resolveSessionLinkId(canonical, 'lw_One')).toBe('Child_B');
    const legacy = 'lody://session/Root_A?workspace=lw_One&tab=Child_B';
    expect(parseSessionLink(legacy)).toEqual(target);
    expect(buildSessionLink(parseSessionLink(legacy)!)).toBe(canonical);
    expect(normalizeSessionLinksForExport(`[Conversation](${legacy})`)).toBe(
      `[Conversation](${canonical})`
    );
    expect(buildSessionLink({ sessionId: 'Root_A', workspaceId: 'lw_One' })).toBe(
      'lody://session/Root_A?workspace=lw_One'
    );
  });

  it.each(['lody', 'lody-oss', 'ai.lody.nightly'])(
    'reads %s resources and emits the common scheme',
    (scheme) => {
      const target = parseSessionLink(`${scheme}://session/Ab_c?workspace=ws_1`);
      expect(target).toEqual({ sessionId: 'Ab_c', workspaceId: 'ws_1' });
      expect(buildSessionLink(target!)).toBe('lody://session/Ab_c?workspace=ws_1');
    }
  );

  it('retains legacy references and enforces the MCP workspace boundary', () => {
    expect(parseSessionLink('session://Ab_c/')).toEqual({ sessionId: 'Ab_c' });
    expect(resolveSessionLinkId('session://Ab_c', 'ws_1')).toBe('Ab_c');
    expect(resolveSessionLinkId('lody://session/Ab_c?workspace=ws_1', 'ws_1')).toBe('Ab_c');
    expect(() => resolveSessionLinkId('lody://session/Ab_c?workspace=ws_2', 'ws_1')).toThrow(
      'different workspace'
    );
    expect(() => resolveSessionLinkId('lody://session/root?tab=child', 'ws_1')).toThrow(
      'child session ID'
    );
  });
});

describe('Today page links', () => {
  it('reads a member page link, including an encoded local user id', async () => {
    const { parseTodayLink } = await import('../src/session-link');
    expect(parseTodayLink('lody://today/local%3Aabc/2026-11-20?workspace=lw_1')).toEqual({
      userId: 'local:abc',
      date: '2026-11-20',
      workspaceId: 'lw_1',
    });
  });

  it('rejects non-canonical encodings, impossible dates, extra parameters and traversal', async () => {
    const { parseTodayLink } = await import('../src/session-link');
    expect(parseTodayLink('lody://today/local%3aabc/2026-11-20?workspace=w')).toBeNull();
    expect(parseTodayLink('lody://today/u1/2026-02-30?workspace=w')).toBeNull();
    expect(parseTodayLink('lody://today/u1/2026-11-20?workspace=w&x=1')).toBeNull();
    expect(parseTodayLink('lody://today/../2026-11-20?workspace=w')).toBeNull();
    expect(parseTodayLink('lody://session/abc?workspace=w')).toBeNull();
  });
});

describe('in-app settings and schedules action links', () => {
  it('parses and builds agent creation, preset, registry, custom and edit links across schemes', () => {
    expect(
      parseAppActionLink('lody://settings/agents?create=codex&machine=mac_1&workspace=ws_1')
    ).toEqual({
      kind: 'settings',
      tab: 'agents',
      workspaceId: 'ws_1',
      machineId: 'mac_1',
      create: { kind: 'builtin', agentType: 'codex' },
    });
    expect(
      parseAppActionLink('ai.lody.nightly://settings/agents?create=glm-over-claude-code')
    ).toEqual({
      kind: 'settings',
      tab: 'agents',
      create: { kind: 'preset', presetId: 'glm-over-claude-code' },
    });
    expect(parseAppActionLink('lody-oss://settings/agents?create=registry:opencode')).toEqual({
      kind: 'settings',
      tab: 'agents',
      create: { kind: 'registry', agentType: 'opencode' },
    });
    expect(parseAppActionLink('lody://settings/agents?create=custom')).toEqual({
      kind: 'settings',
      tab: 'agents',
      create: { kind: 'custom' },
    });
    const edit = parseAppActionLink('lody://settings/agents?config=cfg_9&machine=mac_1');
    expect(edit).toEqual({
      kind: 'settings',
      tab: 'agents',
      configId: 'cfg_9',
      machineId: 'mac_1',
    });
    expect(buildAppActionLink(edit!)).toBe('lody://settings/agents?machine=mac_1&config=cfg_9');
  });

  it('parses roles, mcp, projects, prompt-shortcuts, general tabs and schedules', () => {
    expect(parseAppActionLink('lody://settings/agent-roles?create=1&machine=m1')).toEqual({
      kind: 'settings',
      tab: 'agent-roles',
      machineId: 'm1',
      create: true,
    });
    expect(parseAppActionLink('lody://settings/mcp?server=srv_1')).toEqual({
      kind: 'settings',
      tab: 'mcp',
      serverId: 'srv_1',
    });
    const gh = parseAppActionLink('lody://settings/projects?repo=LodyAI/Lody&page=skills');
    expect(gh).toEqual({
      kind: 'settings',
      tab: 'projects',
      repoFullName: 'LodyAI/Lody',
      page: 'skills',
    });
    expect(parseAppActionLink(buildAppActionLink(gh!))).toEqual(gh);
    expect(
      parseAppActionLink(
        'lody://settings/projects?machine=m1&local=proj_1&page=conversations'
      )
    ).toEqual({
      kind: 'settings',
      tab: 'projects',
      machineId: 'm1',
      localProjectId: 'proj_1',
      page: 'conversations',
    });
    expect(parseAppActionLink('lody://settings/projects?add=local&machine=m1')).toEqual({
      kind: 'settings',
      tab: 'projects',
      machineId: 'm1',
      add: 'local',
    });
    expect(parseAppActionLink('lody://settings/prompt-shortcuts?create=1')).toEqual({
      kind: 'settings',
      tab: 'prompt-shortcuts',
      create: true,
    });
    expect(parseAppActionLink('lody://settings/workspace?workspace=ws_2')).toEqual({
      kind: 'settings',
      tab: 'workspace',
      workspaceId: 'ws_2',
    });
    expect(parseAppActionLink('lody://schedules?create=1')).toEqual({
      kind: 'schedules',
      create: true,
    });
    expect(parseAppActionLink('lody://schedules?schedule=sch_1')).toEqual({
      kind: 'schedules',
      scheduleId: 'sch_1',
    });
    expect(isAppResourceLink('lody://settings/agents?create=codex')).toBe(true);
    expect(isAppResourceLink('lody://schedules?create=1')).toBe(true);
  });

  it('rejects secret/command injection parameters, conflicts, unknown tabs and non-canonical encodings', () => {
    expect(
      parseAppActionLink('lody://settings/agents?create=custom&command=sh')
    ).toBeNull();
    expect(
      parseAppActionLink('lody://settings/agents?create=codex&apiKey=sk-secret')
    ).toBeNull();
    expect(
      parseAppActionLink('lody://settings/mcp?create=1&url=https://evil.example')
    ).toBeNull();
    expect(parseAppActionLink('lody://settings/workspace?panel=e2ee')).toBeNull();
    expect(parseAppActionLink('lody://settings/agents?create=codex&config=cfg_1')).toBeNull();
    expect(parseAppActionLink('lody://settings/agents?create=sorbet')).toBeNull();
    expect(parseAppActionLink('lody://settings/lody-agent')).toBeNull();
    expect(parseAppActionLink('lody://settings/projects?repo=LodyAI/..&page=skills')).toBeNull();
    expect(
      parseAppActionLink('lody://settings/projects?repo=LodyAI%2fLody&page=skills')
    ).toBeNull();
    expect(
      parseAppActionLink('lody://settings/projects?repo=LodyAI/Lody&page=conversations')
    ).toBeNull();
    expect(parseAppActionLink('lody://settings/projects?local=proj_1')).toBeNull();
    expect(parseAppActionLink('lody://settings/unknown-tab')).toBeNull();
    expect(parseAppActionLink('lody://schedules/?create=1')).toBeNull();
    expect(parseAppActionLink('lody://schedules?schedule=new')).toBeNull();
    expect(parseAppActionLink('lody://schedules?create=1&schedule=sch_1')).toBeNull();
    expect(parseAppActionLink('https://lody.ai/settings/agents?create=codex')).toBeNull();
  });
});
