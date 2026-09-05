import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  canAccessShortcutDomain,
  createShortcutInvocation,
  deriveShortcutVariables,
  expandShortcut,
  expandShortcutComposer,
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
  getShortcutMentionGate,
  getShortcutMentionScopeIssues,
  parsePromptShortcut,
  projectShortcutIndex,
  PromptShortcutDocument,
  PromptShortcutError,
  resolveShortcutAvailability,
  updateShortcutInvocation,
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
    variables: [{ name: 'topic' }],
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
  it('derives required variables in first occurrence order and removes obsolete defaults', () => {
    expect(
      deriveShortcutVariables('!{b} !{a} !{b} \\!{literal}', [
        { name: 'unused', defaultValue: 'gone' },
        { name: 'a', defaultValue: 'preserved' },
      ])
    ).toEqual([{ name: 'b' }, { name: 'a', defaultValue: 'preserved' }]);
  });

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

  it('rejects absent scope, wrong machine, stale labels, placeholder overlaps and malformed variables', () => {
    const target: PromptShortcutTarget = {
      kind: 'file',
      path: 'a.ts',
      project: { kind: 'local', id: 'project', machineId: 'mac' },
    };
    const file = template({
      prompt: '@a.ts',
      variables: [],
      mentions: [{ start: 0, end: 5, label: '@a.ts', target }],
    });
    expect(errorCode(() => parsePromptShortcut(file))).toBe('missing_scope');
    expect(
      errorCode(() =>
        parsePromptShortcut({ ...file, scope: { project: target.project, machineId: 'other' } })
      )
    ).toBe('scope_mismatch');
    expect(errorCode(() => parsePromptShortcut(template({ variables: [] })))).toBe(
      'invalid_template'
    );
    const role = { kind: 'agent_role' as const, agentRoleId: 'role' };
    expect(
      errorCode(() =>
        parsePromptShortcut(
          template({ mentions: [{ start: 0, end: 6, label: 'Wrong!', target: role }] })
        )
      )
    ).toBe('invalid_ranges');
    expect(
      errorCode(() =>
        parsePromptShortcut(
          template({ mentions: [{ start: 7, end: 15, label: '!{topic}', target: role }] })
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
            variables: [],
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
  it('budgets repeated variable expansion in UTF-8 before constructing the expanded text', () => {
    const large = createShortcutInvocation('large', template({ prompt: '!{topic}'.repeat(1000) }));
    large.values.topic = '界'.repeat(300);
    expect(errorCode(() => expandShortcut(large))).toBe('size_limit');
    const exact = createShortcutInvocation('exact', template({ prompt: '!{topic}'.repeat(3) }));
    exact.values.topic = '界';
    expect(errorCode(() => expandShortcut(exact, false, 8))).toBe('size_limit');
    expect(expandShortcut(exact, false, 9).text).toBe('界界界');
  });

  it('substitutes repeated variables once and treats injected syntax literally', () => {
    const invocation = createShortcutInvocation(
      'i1',
      template({ prompt: '!{topic} / !{topic} / \\!{literal}' })
    );
    invocation.values.topic = '!{x} @Role $skill\nline two';
    expect(expandShortcut(invocation)).toEqual({
      text: '!{x} @Role $skill\nline two / !{x} @Role $skill\nline two / !{literal}',
      mentions: [],
      unresolved: [],
    });
  });

  it('tracks only expanded missing variables and allows empty/default clearing', () => {
    const invocation = createShortcutInvocation(
      'i1',
      template({
        prompt: '!{topic} \\!{literal}',
        variables: [{ name: 'topic', defaultValue: 'default' }],
      })
    );
    expect(expandShortcut(invocation).text).toBe('default !{literal}');
    invocation.values.topic = ' ';
    expect(errorCode(() => expandShortcut(invocation))).toBe('missing_variables');
    expect(expandShortcut(invocation, true)).toEqual({
      text: '!{topic} !{literal}',
      mentions: [],
      unresolved: [{ start: 0, end: 8, name: 'topic', invocationId: 'i1' }],
    });
  });

  it('preserves mention offsets after multiline Unicode values', () => {
    const prompt = '!{topic} @Reviewer';
    const invocation = createShortcutInvocation(
      'i1',
      template({
        prompt,
        mentions: [
          {
            start: 9,
            end: 18,
            label: '@Reviewer',
            target: { kind: 'agent_role', agentRoleId: 'role' },
          },
        ],
      })
    );
    invocation.values.topic = '中文🙂\nsecond line';
    const output = expandShortcut(invocation);
    expect(output.text).toBe('中文🙂\nsecond line @Reviewer');
    expect(output.text.slice(output.mentions[0]!.start, output.mentions[0]!.end)).toBe('@Reviewer');
  });

  it('expands multiple chips in place without adding separators or sharing values', () => {
    const first = createShortcutInvocation('i1', template());
    const second = createShortcutInvocation('i2', template());
    first.values.topic = 'first';
    second.values.topic = 'second';
    expect(
      expandShortcutComposer({
        text: 'Before /review between /review after !{literal}',
        mentions: [],
        invocations: [
          { start: 7, end: 14, invocation: first },
          { start: 23, end: 30, invocation: second },
        ],
        maxBytes: 1000,
      }).text
    ).toBe('Before Review first between Review second after !{literal}');
  });

  it('retains same-name values including intentional empty values on reload, but resets on replacement', () => {
    const original = createShortcutInvocation('i1', template());
    original.values.topic = '';
    const updated = template({
      prompt: '!{topic} !{new}',
      revision: 'r2',
      variables: [
        { name: 'topic', defaultValue: 'not used' },
        { name: 'new', defaultValue: 'seed' },
      ],
    });
    expect(updateShortcutInvocation(original, updated).values).toEqual({ topic: '', new: 'seed' });
    expect(updateShortcutInvocation(original, { ...updated, id: 'different' }).values).toEqual({
      topic: 'not used',
      new: 'seed',
    });
    expect(original.snapshot.revision).toBe('r1');
  });

  it('snapshots do not alias mutable catalog objects', () => {
    const source = template();
    const invocation = createShortcutInvocation('i1', source);
    source.prompt = 'changed';
    source.variables[0]!.defaultValue = 'changed';
    expect(invocation.snapshot.prompt).toBe('Review !{topic}');
    expect(invocation.snapshot.variables).toEqual([{ name: 'topic' }]);
  });

  it('rejects stale ranges, overlapping chips and oversized UTF-8 output without truncating', () => {
    const invocation = createShortcutInvocation('i1', template());
    invocation.values.topic = '中文';
    expect(
      errorCode(() =>
        expandShortcutComposer({
          text: '/review',
          mentions: [],
          invocations: [{ start: 0, end: 7, invocation }],
          maxBytes: 12,
        })
      )
    ).toBe('size_limit');
    expect(
      errorCode(() =>
        expandShortcutComposer({
          text: '/wrong!',
          mentions: [],
          invocations: [{ start: 0, end: 7, invocation }],
          maxBytes: 100,
        })
      )
    ).toBe('invalid_ranges');
    expect(
      errorCode(() =>
        expandShortcutComposer({
          text: '/review',
          mentions: [],
          invocations: [
            { start: 0, end: 7, invocation },
            { start: 0, end: 7, invocation },
          ],
          maxBytes: 100,
        })
      )
    ).toBe('invalid_ranges');
  });
});

describe('LoroDoc saved revisions', () => {
  it('survives binary export/import with text, mentions and variables coherent', () => {
    const original = new PromptShortcutDocument(new LoroDoc());
    original.save(template({ prompt: '长'.repeat(50_000), variables: [] }), []);
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

  it('publishes only the current state, never earlier private revisions', () => {
    const original = new PromptShortcutDocument(new LoroDoc());
    original.save(template({ prompt: 'private draft', variables: [] }), []);
    original.save(template({ revision: 'r2', prompt: 'publishable', variables: [] }), ['r1']);
    const published = PromptShortcutDocument.fromPublishedState({
      ...original.read()!,
      visibility: 'workspace',
    });
    expect(published.read()?.prompt).toBe('publishable');
    expect(published.doc.getMap('revisions').keys()).toEqual(['r2']);
    expect(JSON.stringify(published.doc.toJSON())).not.toContain('private draft');
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
