import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  canAccessShortcutDomain,
  createShortcutInvocation,
  expandShortcut,
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
  getShortcutMentionGate,
  getShortcutMentionScopeIssues,
  parsePromptShortcut,
  projectShortcutIndex,
  PromptShortcutDocument,
  PromptShortcutError,
  resolveShortcutAvailability,
  type PromptShortcut,
  type PromptShortcutScope,
  type PromptShortcutTarget,
} from '../src/prompt-shortcuts';

function template(overrides: Partial<PromptShortcut> = {}): PromptShortcut {
  return {
    v: 1,
    id: 'review',
    workspaceId: 'workspace',
    ownerUserId: 'alice',
    visibility: 'private',
    name: 'Review',
    slug: 'review',
    prompt: 'Review !{topic}',
    mentions: [],
    scope: {},
    revision: 'r1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (!(error instanceof PromptShortcutError)) throw error;
    return error.code;
  }
  throw new Error('Expected a shortcut error');
}

describe('shortcut template and scope', () => {
  it('allows a context-neutral Role without assuming its execution provider', () => {
    const prompt = '@Reviewer !{topic}';
    const role: PromptShortcutTarget = { kind: 'agent_role', agentRoleId: 'role-1' };
    expect(
      parsePromptShortcut(
        template({ prompt, mentions: [{ start: 0, end: 9, label: '@Reviewer', target: role }] })
      ).scope
    ).toEqual({});
    expect(getShortcutMentionGate('agent_role', {})).toEqual({ enabled: true, missing: [] });
  });

  it('disables scoped sources before activation, then enables only compatible source types', () => {
    expect(getShortcutMentionGate('file', {})).toEqual({ enabled: false, missing: ['project'] });
    expect(getShortcutMentionGate('global_skill', {})).toEqual({
      enabled: false,
      missing: ['machineId', 'providerKey'],
    });
    const scope: PromptShortcutScope = {
      project: { kind: 'local', id: 'project', machineId: 'mac' },
      machineId: 'mac',
    };
    expect(getShortcutMentionGate('file', scope).enabled).toBe(true);
    expect(getShortcutMentionGate('issue', scope).enabled).toBe(false);
    expect(getShortcutMentionGate('project_skill', scope).enabled).toBe(false);
    expect(
      getShortcutMentionGate('project_skill', { ...scope, providerKey: 'codex:codex' }).enabled
    ).toBe(true);
  });

  it('does not infer or mutate scope when checking a machine/provider-bound mention', () => {
    const scope = {};
    expect(
      getShortcutMentionScopeIssues(scope, {
        kind: 'skill',
        source: 'global',
        machineId: 'mac',
        path: '/skills/review/SKILL.md',
        compatibleProviders: ['codex:codex'],
      })
    ).toEqual([
      { code: 'missing_scope', axis: 'machineId' },
      { code: 'missing_scope', axis: 'providerKey' },
    ]);
    expect(scope).toEqual({});
  });

  it('rejects absent scope, wrong machine and stale labels', () => {
    const target: PromptShortcutTarget = {
      kind: 'file',
      path: 'a.ts',
      project: { kind: 'local', id: 'project', machineId: 'mac' },
    };
    const file = template({
      prompt: '@a.ts',
      mentions: [{ start: 0, end: 5, label: '@a.ts', target }],
    });
    expect(errorCode(() => parsePromptShortcut(file))).toBe('missing_scope');
    expect(
      errorCode(() =>
        parsePromptShortcut({ ...file, scope: { project: target.project, machineId: 'other' } })
      )
    ).toBe('scope_mismatch');
    const role = { kind: 'agent_role' as const, agentRoleId: 'role' };
    expect(
      errorCode(() =>
        parsePromptShortcut(
          template({ mentions: [{ start: 0, end: 6, label: 'Wrong!', target: role }] })
        )
      )
    ).toBe('invalid_ranges');
  });

  it('rejects incomplete skill sources rather than treating them as workspace-wide', () => {
    expect(
      errorCode(() =>
        parsePromptShortcut(
          template({
            prompt: '$review',
            scope: { providerKey: 'codex:codex' },
            mentions: [
              {
                start: 0,
                end: 7,
                label: '$review',
                target: {
                  kind: 'skill',
                  source: 'project',
                  path: 'SKILL.md',
                  compatibleProviders: ['codex:codex'],
                },
              },
            ],
          })
        )
      )
    ).toBe('invalid_template');
  });

  it('checks permissions before consulting dependencies and distinguishes unknown dependencies', () => {
    let consulted = false;
    const input = {
      shortcut: template(),
      dependencies: [{ kind: 'agent_role' as const, agentRoleId: 'role' }],
      context: { workspaceId: 'workspace', userId: 'bob', scope: {} },
      canRead: true,
      resolveDependency: () => {
        consulted = true;
        return { kind: 'unknown' as const, reason: 'loading' };
      },
    };
    expect(resolveShortcutAvailability(input)).toEqual({
      kind: 'unavailable',
      reason: 'permission_denied',
    });
    expect(consulted).toBe(false);
    expect(
      resolveShortcutAvailability({ ...input, context: { ...input.context, userId: 'alice' } })
    ).toEqual({ kind: 'unknown', reason: 'loading' });
    expect(consulted).toBe(true);
  });
});

describe('shortcut compilation', () => {
  it('preserves mention offsets after multiline Unicode text', () => {
    const prompt = '中文🙂\nsecond line @Reviewer';
    const invocation = createShortcutInvocation(
      'i1',
      template({
        prompt,
        mentions: [
          {
            start: prompt.indexOf('@Reviewer'),
            end: prompt.indexOf('@Reviewer') + 9,
            label: '@Reviewer',
            target: { kind: 'agent_role', agentRoleId: 'role' },
          },
        ],
      })
    );
    const output = expandShortcut(invocation);
    expect(output.text).toBe('中文🙂\nsecond line @Reviewer');
    expect(output.text.slice(output.mentions[0]!.start, output.mentions[0]!.end)).toBe('@Reviewer');
  });

  it('snapshots do not alias mutable catalog objects', () => {
    const source = template();
    const invocation = createShortcutInvocation('i1', source);
    source.prompt = 'changed';
    expect(invocation.snapshot.prompt).toBe('Review !{topic}');
  });
});

describe('LoroDoc saved revisions', () => {
  it('survives binary export/import with text and mentions coherent', () => {
    const original = new PromptShortcutDocument(new LoroDoc());
    original.save(template({ prompt: '长'.repeat(50_000) }), []);
    const restored = new PromptShortcutDocument(new LoroDoc());
    restored.doc.import(original.doc.export({ mode: 'snapshot' }));
    expect(restored.read()).toEqual(original.read());
    expect(projectShortcutIndex(restored.read()!, 'doc-1')).not.toHaveProperty('prompt');
    expect(JSON.stringify(projectShortcutIndex(restored.read()!, 'doc-1')).length).toBeLessThan(
      1000
    );
  });

  it('detects concurrent offline saves after CRDT merge and explicitly resolves both branches', () => {
    const left = new PromptShortcutDocument(new LoroDoc());
    left.doc.setPeerId('1');
    left.save(template(), []);
    const right = new PromptShortcutDocument(new LoroDoc());
    right.doc.setPeerId('2');
    right.doc.import(left.doc.export({ mode: 'snapshot' }));
    left.save(template({ revision: 'left', prompt: 'Left !{topic}' }), ['r1']);
    right.save(template({ revision: 'right', prompt: 'Right !{topic}' }), ['r1']);
    left.doc.import(right.doc.export({ mode: 'update', from: left.doc.version() }));
    right.doc.import(left.doc.export({ mode: 'update', from: right.doc.version() }));
    expect(left.heads().map((head) => head.revision)).toEqual(['left', 'right']);
    expect(errorCode(() => left.read())).toBe('conflict');
    expect(errorCode(() => right.read())).toBe('conflict');
    expect(
      errorCode(() => left.save(template({ revision: 'left', prompt: 'Left !{topic}' }), ['r1']))
    ).toBe('conflict');
    left.save(template({ revision: 'resolved', prompt: 'Resolved !{topic}' }), ['left', 'right']);
    right.doc.import(left.doc.export({ mode: 'update', from: right.doc.version() }));
    expect(right.read()?.prompt).toBe('Resolved !{topic}');
    expect(right.read()).toEqual(left.read());
  });

  it('rejects stale editors, reused revisions and document identity changes', () => {
    const document = new PromptShortcutDocument(new LoroDoc());
    document.save(template(), []);
    expect(document.save(template(), [])).toEqual(template());
    expect(errorCode(() => document.save(template({ revision: 'r2' }), []))).toBe('conflict');
    expect(errorCode(() => document.save(template({ prompt: 'Different !{topic}' }), []))).toBe(
      'conflict'
    );
    expect(
      errorCode(() => document.save(template({ revision: 'r2', visibility: 'workspace' }), ['r1']))
    ).toBe('invalid_template');
  });
});

describe('shortcut access domains', () => {
  it('isolates private content from workspace-wide stream tokens and prevents identifier injection', () => {
    const domain = {
      workspaceId: 'workspace',
      ownerUserId: 'alice',
      visibility: 'private' as const,
    };
    expect(getShortcutIndexStreamId(domain)).not.toMatch(/^workspace:/);
    expect(getShortcutBodyStreamId('body')).not.toMatch(/^workspace:/);
    expect(getShortcutIndexStreamId({ ...domain, ownerUserId: 'alice:workspace' })).toContain(
      'alice%3Aworkspace'
    );
    expect(
      canAccessShortcutDomain({ domain, userId: 'bob', isWorkspaceMember: true, operation: 'read' })
    ).toBe(false);
    expect(
      canAccessShortcutDomain({
        domain,
        userId: 'alice',
        isWorkspaceMember: true,
        operation: 'write',
      })
    ).toBe(true);
    expect(
      canAccessShortcutDomain({
        domain: { ...domain, visibility: 'workspace' },
        userId: 'bob',
        isWorkspaceMember: true,
        operation: 'read',
      })
    ).toBe(true);
    expect(
      canAccessShortcutDomain({
        domain: { ...domain, visibility: 'workspace' },
        userId: 'bob',
        isWorkspaceMember: true,
        operation: 'write',
      })
    ).toBe(false);
    expect(
      canAccessShortcutDomain({
        domain,
        userId: 'alice',
        isWorkspaceMember: false,
        operation: 'write',
      })
    ).toBe(false);
  });
});
