import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  mergePendingDiffStoreEvents,
  pendingEventFromAgentEditEvidence,
  pendingEventFromStandardDiffEvidence,
  pendingEventFromWriteTextFileEvidence,
} from './code-collab-v2-diff-evidence';

const WORKSPACE_ROOT = path.resolve('/workspace');

describe('Code Collab v2 ACP diff evidence normalization', () => {
  it('keeps Codex-style full-file standard diff evidence', async () => {
    const event = await pendingEventFromStandardDiffEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      diff: {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: 'alpha old line\nbeta stays\n',
        newText: 'alpha new line\nbeta stays\n',
      },
      readCurrentText: async () => 'alpha new line\nbeta stays\n',
    });

    expect(event).toEqual({
      path: path.join(WORKSPACE_ROOT, 'target.txt'),
      oldText: 'alpha old line\nbeta stays\n',
      newText: 'alpha new line\nbeta stays\n',
      oldTextEvidence: 'strong',
    });
  });

  it('reconstructs full old text from Claude/opencode/Kimi replacement fragments', async () => {
    const event = await pendingEventFromStandardDiffEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      diff: {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: 'alpha old line',
        newText: 'alpha new line',
      },
      readCurrentText: async () => 'alpha new line\nbeta stays\n',
    });

    expect(event).toEqual({
      path: path.join(WORKSPACE_ROOT, 'target.txt'),
      oldText: 'alpha old line\nbeta stays\n',
      newText: 'alpha new line\nbeta stays\n',
      oldTextEvidence: 'strong',
    });
  });

  it('drops ambiguous repeated replacement fragments instead of treating them as full files', async () => {
    const event = await pendingEventFromStandardDiffEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      diff: {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: 'old',
        newText: 'new',
      },
      readCurrentText: async () => 'new\nnew\n',
    });

    expect(event).toBeNull();
  });

  it('records fs/write_text_file evidence as strong full-file evidence', () => {
    expect(
      pendingEventFromWriteTextFileEvidence({
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: 'alpha old line\nbeta stays\n',
        newText: 'alpha new line\nbeta stays\n',
      })
    ).toEqual({
      path: path.join(WORKSPACE_ROOT, 'target.txt'),
      oldText: 'alpha old line\nbeta stays\n',
      newText: 'alpha new line\nbeta stays\n',
      oldTextEvidence: 'strong',
    });
  });

  it('does not accept standard-null evidence when the current file does not match newText', async () => {
    const event = await pendingEventFromStandardDiffEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      diff: {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
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
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: null,
        newText: 'alpha new line\nbeta stays\n',
        oldTextEvidence: 'standard-null',
      },
      {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: 'alpha old line\nbeta stays\n',
        newText: 'alpha new line\nbeta stays\n',
        oldTextEvidence: 'strong',
      },
    ]);

    expect(merged).toEqual([
      {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: 'alpha old line\nbeta stays\n',
        newText: 'alpha new line\nbeta stays\n',
      },
    ]);
  });

  it('keeps strong create evidence from fs/write_text_file across later edits', () => {
    const merged = mergePendingDiffStoreEvents([
      {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: null,
        newText: 'draft\n',
        oldTextEvidence: 'strong',
      },
      {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: 'draft\n',
        newText: 'final\n',
        oldTextEvidence: 'strong',
      },
    ]);

    expect(merged).toEqual([
      {
        path: path.join(WORKSPACE_ROOT, 'target.txt'),
        oldText: null,
        newText: 'final\n',
      },
    ]);
  });
});

describe('pendingEventFromAgentEditEvidence', () => {
  it('chains old text from the previous recorded state', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: path.join(WORKSPACE_ROOT, 'a.ts'), changeType: 'update' },
      latestText: { status: 'tracked', text: 'old\n' },
      readCurrentText: async () => 'new\n',
    });
    expect(event).toEqual({
      path: path.join(WORKSPACE_ROOT, 'a.ts'),
      oldText: 'old\n',
      newText: 'new\n',
      oldTextEvidence: 'strong',
    });
  });

  it('prefers the agent-reported pre-image over chaining', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: {
        path: path.join(WORKSPACE_ROOT, 'a.ts'),
        changeType: 'update',
        contentOldText: 'reported old\n',
      },
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
      edit: {
        path: path.join(WORKSPACE_ROOT, 'a.ts'),
        changeType: 'update',
        oldString: 'foo',
        newString: 'bar',
      },
      latestText: { status: 'untracked' },
      readCurrentText: async () => 'x bar y\n',
    });
    expect(event).toMatchObject({
      oldText: 'x foo y\n',
      newText: 'x bar y\n',
      oldTextEvidence: 'strong',
    });
  });

  it('treats a first-seen created file as added (old absent)', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: path.join(WORKSPACE_ROOT, 'new.ts'), changeType: 'add' },
      latestText: { status: 'untracked' },
      readCurrentText: async () => 'created\n',
    });
    expect(event).toMatchObject({
      oldText: null,
      newText: 'created\n',
      oldTextEvidence: 'strong',
    });
  });

  it('rejects an untracked update with no pre-image instead of seeding a fake empty diff', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: path.join(WORKSPACE_ROOT, 'a.ts'), changeType: 'update' },
      latestText: { status: 'untracked' },
      readCurrentText: async () => 'whole file\n',
    });
    expect(event).toBeNull();
  });

  it('records a chained deletion as new=null', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: path.join(WORKSPACE_ROOT, 'a.ts'), changeType: 'delete' },
      latestText: { status: 'tracked', text: 'gone\n' },
      readCurrentText: async () => null,
    });
    expect(event).toMatchObject({
      oldText: 'gone\n',
      newText: null,
      oldTextEvidence: 'strong',
    });
  });

  it('skips an untracked delete with no pre-image', async () => {
    const event = await pendingEventFromAgentEditEvidence({
      workspaceRoot: WORKSPACE_ROOT,
      edit: { path: path.join(WORKSPACE_ROOT, 'a.ts'), changeType: 'delete' },
      latestText: { status: 'untracked' },
      readCurrentText: async () => null,
    });
    expect(event).toBeNull();
  });
});
