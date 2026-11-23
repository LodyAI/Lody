import { describe, expect, it } from 'vitest';

import {
  mergePendingDiffStoreEvents,
  pendingEventFromAgentEditEvidence,
  pendingEventFromStandardDiffEvidence,
} from './code-collab-v2-diff-evidence';

const WORKSPACE_ROOT = '/workspace';

describe('Code Collab v2 ACP diff evidence normalization', () => {
  it('reconstructs full old text from Claude/opencode/Kimi replacement fragments', async () => {
    const event = await pendingEventFromStandardDiffEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      diff: {
        path: '/workspace/target.txt',
        oldText: 'alpha old line',
        newText: 'alpha new line',
      },
      readCurrentText: async () => 'alpha new line\nbeta stays\n',
    });

    expect(event).toEqual({
      path: '/workspace/target.txt',
      oldText: 'alpha old line\nbeta stays\n',
      newText: 'alpha new line\nbeta stays\n',
      oldTextEvidence: 'strong',
    });
  });

  it('drops ambiguous repeated replacement fragments instead of treating them as full files', async () => {
    const event = await pendingEventFromStandardDiffEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      diff: {
        path: '/workspace/target.txt',
        oldText: 'old',
        newText: 'new',
      },
      readCurrentText: async () => 'new\nnew\n',
    });

    expect(event).toBeNull();
  });

  it('does not accept standard-null evidence when the current file does not match newText', async () => {
    const event = await pendingEventFromStandardDiffEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      diff: {
        path: '/workspace/target.txt',
        oldText: null,
        newText: 'alpha new line\n',
      },
      readCurrentText: async () => 'alpha old line\n',
    });

    expect(event).toBeNull();
  });

  it('lets later strong evidence repair a tentative standard-null oldText', () => {
    const merged = mergePendingDiffStoreEvents([
      {
        path: '/workspace/target.txt',
        oldText: null,
        newText: 'alpha new line\nbeta stays\n',
        oldTextEvidence: 'standard-null',
      },
      {
        path: '/workspace/target.txt',
        oldText: 'alpha old line\nbeta stays\n',
        newText: 'alpha new line\nbeta stays\n',
        oldTextEvidence: 'strong',
      },
    ]);

    expect(merged).toEqual([
      {
        path: '/workspace/target.txt',
        oldText: 'alpha old line\nbeta stays\n',
        newText: 'alpha new line\nbeta stays\n',
      },
    ]);
  });
});

describe('pendingEventFromAgentEditEvidence', () => {
  it('prefers the agent-reported pre-image over chaining', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: '/workspace/a.ts', changeType: 'update', contentOldText: 'reported old\n' },
      latestText: { status: 'tracked', text: 'chained old\n' },
      readCurrentText: async () => 'new\n',
    });
    expect(event).toMatchObject({
      oldText: 'reported old\n',
      newText: 'new\n',
      oldTextEvidence: 'strong',
    });
  });

  it('reconstructs old text from a single fragment replacement', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: '/workspace/a.ts', changeType: 'update', oldString: 'foo', newString: 'bar' },
      latestText: { status: 'untracked' },
      readCurrentText: async () => 'x bar y\n',
    });
    expect(event).toMatchObject({
      oldText: 'x foo y\n',
      newText: 'x bar y\n',
      oldTextEvidence: 'strong',
    });
  });

  it('rejects an untracked update with no pre-image instead of seeding a fake empty diff', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: '/workspace/a.ts', changeType: 'update' },
      latestText: { status: 'untracked' },
      readCurrentText: async () => 'whole file\n',
    });
    expect(event).toBeNull();
  });

  it('skips an untracked delete with no pre-image', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: '/workspace/a.ts', changeType: 'delete' },
      latestText: { status: 'untracked' },
      readCurrentText: async () => null,
    });
    expect(event).toBeNull();
  });
});
