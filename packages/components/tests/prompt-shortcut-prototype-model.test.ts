import { describe, expect, it } from 'vitest';

import {
  PROTOTYPE_LABELS,
  PROTOTYPE_MENTION_CATALOG,
  PROTOTYPE_WORK_CONTEXT,
  findShortcut,
} from '../src/components/prototypes/prompt-shortcuts/prompt-shortcut-fixtures';
import {
  collectPlaceholderNames,
  compileShortcut,
  findBrokenReferences,
  findMissingVariables,
  findOutOfScopeReferences,
  isWorkspaceWideScope,
  resolveEligibility,
  resolveVariableRows,
  segmentBlock,
  type PrototypeScope,
} from '../src/components/prototypes/prompt-shortcuts/prompt-shortcut-model';

/**
 * The prototype's derived states are what the Storybook stories are arguing
 * about, so they get the same treatment as production logic: no timers, no
 * randomness, one closed fixture set.
 */

describe('placeholders', () => {
  it('collects each name once across the template, in document order', () => {
    const names = collectPlaceholderNames(
      'Review !{pr_url} now\n\nFocus on !{focus}, then re-check !{pr_url}',
      PROTOTYPE_MENTION_CATALOG
    );
    expect(names).toEqual(['pr_url', 'focus']);
  });

  it('treats an escaped token as literal text and drops the backslash', () => {
    const segments = segmentBlock('Write \\!{literal} verbatim', PROTOTYPE_MENTION_CATALOG);
    expect(segments.some((segment) => segment.kind === 'placeholder')).toBe(false);
    expect(segments.map((segment) => (segment.kind === 'text' ? segment.text : '')).join('')).toBe(
      'Write !{literal} verbatim'
    );
  });

  it('rejects a name that does not match the grammar', () => {
    expect(collectPlaceholderNames('!{9lives} !{ok_name}', PROTOTYPE_MENTION_CATALOG)).toEqual([
      'ok_name',
    ]);
  });
});

const scope = (partial: Partial<PrototypeScope> = {}): PrototypeScope => ({
  projectId: null,
  machineId: null,
  agentId: null,
  ...partial,
});

describe('scope', () => {
  it('is workspace-wide when the author set nothing', () => {
    expect(isWorkspaceWideScope(findShortcut('standup').scope)).toBe(true);
  });

  it('is exactly what the author set, whatever the template references', () => {
    // `/standup` references nothing and `/review-pr` references four things.
    // Neither fact moves the scope — only the author does.
    expect(findShortcut('review-pr').scope).toEqual({
      projectId: 'proj-lody',
      machineId: 'machine-mac-mini',
      agentId: 'agent-codex',
    });
  });
});

describe('out-of-scope references', () => {
  it('flags a file whose project the scope excludes', () => {
    const found = findOutOfScopeReferences(
      'Compare @crates/loro/src/lib.rs',
      PROTOTYPE_MENTION_CATALOG,
      scope({ projectId: 'proj-lody' })
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dimension: 'project', needs: 'proj-loro' });
  });

  it('flags a skill no allowed agent supports', () => {
    const found = findOutOfScopeReferences(
      'Run $rust-bench',
      PROTOTYPE_MENTION_CATALOG,
      scope({ agentId: 'agent-cursor' })
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dimension: 'agent' });
  });

  it('accepts everything while the axis is unset', () => {
    // Two files from two projects used to be a hard conflict. With an
    // author-set scope, an unset axis simply allows both.
    expect(
      findOutOfScopeReferences(
        'Compare @docs/review-checklist.md with @crates/loro/src/lib.rs',
        PROTOTYPE_MENTION_CATALOG,
        scope()
      )
    ).toEqual([]);
  });

  it('is separate from a reference that no longer resolves', () => {
    const text = 'Walk me through @src/legacy/migrate.ts';
    expect(findOutOfScopeReferences(text, PROTOTYPE_MENTION_CATALOG, scope())).toEqual([]);
    expect(findBrokenReferences(text, PROTOTYPE_MENTION_CATALOG).map((e) => e.label)).toEqual([
      'src/legacy/migrate.ts',
    ]);
  });
});

describe('eligibility', () => {
  const resolve = (slug: string, context = PROTOTYPE_WORK_CONTEXT) =>
    resolveEligibility(findShortcut(slug), PROTOTYPE_MENTION_CATALOG, context, PROTOTYPE_LABELS);

  it('is available in the context the author scoped it to', () => {
    expect(resolve('review-pr')).toEqual({ kind: 'available' });
  });

  it('is available anywhere when the scope is unset', () => {
    expect(resolve('standup', { ...PROTOTYPE_WORK_CONTEXT, projectId: 'proj-loro' })).toEqual({
      kind: 'available',
    });
  });

  it('reports the project the author pinned rather than falling back', () => {
    expect(resolve('rust-bench')).toMatchObject({
      kind: 'unavailable',
      reason: 'project_mismatch',
      detail: 'loro-dev/loro',
    });
  });

  it('will not substitute another online machine for the one it pins', () => {
    const elsewhere = { ...PROTOTYPE_WORK_CONTEXT, machineId: 'machine-macbook' };
    expect(resolve('review-pr', elsewhere)).toMatchObject({
      kind: 'unavailable',
      reason: 'machine_mismatch',
    });
  });

  it('says machine_offline when the pinned machine is current but asleep', () => {
    expect(resolve('review-pr', { ...PROTOTYPE_WORK_CONTEXT, onlineMachineIds: [] })).toMatchObject(
      { kind: 'unavailable', reason: 'machine_offline' }
    );
  });

  it('blocks a reference the author-set scope cannot satisfy', () => {
    expect(resolve('cross-repo-audit')).toMatchObject({
      kind: 'unavailable',
      reason: 'reference_out_of_scope',
      detail: 'crates/loro/src/lib.rs',
    });
  });

  it('reports a deleted reference before anything about context', () => {
    expect(resolve('legacy-migration')).toMatchObject({
      kind: 'unavailable',
      reason: 'dependency_missing',
    });
  });

  it('never reports available while the context is still loading', () => {
    expect(resolve('standup', { ...PROTOTYPE_WORK_CONTEXT, loading: true })).toEqual({
      kind: 'unknown',
      reason: 'context_loading',
    });
  });
});

describe('compile', () => {
  const shortcut = findShortcut('review-pr');

  it('produces one message, paragraph breaks and all', () => {
    const { text } = compileShortcut(shortcut, PROTOTYPE_MENTION_CATALOG, {
      pr_url: 'PR-1',
      focus: 'locking',
    });
    expect(text.split('\n\n')).toHaveLength(3);
    expect(text).toContain('Review PR-1 against');
  });

  it('keeps mention spans aligned after a long value is substituted', () => {
    const long = 'x'.repeat(500);
    const { text, mentions } = compileShortcut(shortcut, PROTOTYPE_MENTION_CATALOG, {
      pr_url: long,
      focus: 'locking',
    });
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect(text.slice(mention.start, mention.end)).toBe(mention.token);
    }
  });

  it('substitutes a value literally without re-parsing it', () => {
    const { text } = compileShortcut(shortcut, PROTOTYPE_MENTION_CATALOG, {
      pr_url: '!{focus} @docs/review-checklist.md',
      focus: 'locking',
    });
    expect(text).toContain('Review !{focus} @docs/review-checklist.md against');
  });

  it('leaves an unfilled token in place so the send gate can still see it', () => {
    const { text } = compileShortcut(shortcut, PROTOTYPE_MENTION_CATALOG, { pr_url: 'PR-1' });
    expect(text).toContain('!{focus}');
  });
});

describe('variables', () => {
  it('counts a required value as missing until it or its default is non-empty', () => {
    const shortcut = findShortcut('triage-issue');
    const rows = resolveVariableRows(shortcut, PROTOTYPE_MENTION_CATALOG);
    expect(rows.map((row) => row.name)).toEqual(['issue_url', 'severity', 'reporter_notes']);
    // `severity` has a default and `reporter_notes` is optional.
    expect(findMissingVariables(rows, {}).map((row) => row.name)).toEqual(['issue_url']);
    expect(findMissingVariables(rows, { issue_url: '#1' })).toEqual([]);
  });

  it('derives a row for a token with no author metadata', () => {
    const rows = resolveVariableRows(
      { ...findShortcut('standup'), prompt: 'Say !{undeclared}' },
      PROTOTYPE_MENTION_CATALOG
    );
    expect(rows).toEqual([{ name: 'undeclared', required: true, multiline: false }]);
  });
});
