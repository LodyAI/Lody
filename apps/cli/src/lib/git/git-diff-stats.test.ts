import { describe, expect, it } from 'vitest';
import { isWorkspaceDirty, type GitRunner } from './git-diff-stats';

describe('git diff stats', () => {
  it('returns undefined (unknown, NOT clean) when git status throws — a transient spawn failure', async () => {
    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') throw new Error('spawn git ENOMEM');
      throw new Error(`Unexpected git args: ${key}`);
    };

    // Must NOT be `false`: a transient failure that read as "clean" hid the
    // Create PR / Commit & Push actions on genuinely dirty sessions.
    await expect(isWorkspaceDirty(runGit)).resolves.toBeUndefined();
  });
});
