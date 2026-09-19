import { describe, expect, it } from 'vitest';
import {
  captureGitWorkingTreeDiffBaseline,
  getGitDiffStats,
  isWorkspaceDirty,
  parseGitNumstat,
  resolveGitMergeBase,
  sumLineChange,
  type GitRunner,
} from './git-diff-stats';

describe('git diff stats', () => {
  it('parses git diff --numstat output', () => {
    const output = [
      '10\t2\tsrc/app.ts',
      '0\t1\tREADME.md',
      '0\t0\tREADME.md',
      '-\t-\tassets/image.png',
      '',
    ].join('\n');

    expect(parseGitNumstat(output)).toEqual([
      { filePath: 'src/app.ts', add: 10, del: 2 },
      { filePath: 'README.md', add: 0, del: 1 },
      { filePath: 'README.md', add: 0, del: 0 },
      { filePath: 'assets/image.png', add: 0, del: 0 },
    ]);
  });

  it('sums line changes', () => {
    const diffs = [
      { filePath: 'a.ts', add: 2, del: 1 },
      { filePath: 'b.ts', add: 3, del: 4 },
    ];

    expect(sumLineChange(diffs)).toEqual({ add: 5, del: 5 });
  });

  it('returns empty turn fileDiff without a turn baseline and still computes base lineChange', async () => {
    const baseNumstat = ['5\t1\ta.ts', '0\t2\tb.ts', ''].join('\n');

    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');

      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';

      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'main^{commit}') return 'deadbeef\n';
        throw new Error(`Unknown revision: ${args[2] ?? ''}`);
      }

      if (key === 'merge-base main HEAD') return 'abc123\n';
      if (key === 'diff --numstat --no-renames abc123 HEAD') return baseNumstat;

      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(getGitDiffStats(runGit, { preferredBaseBranch: 'main' })).resolves.toEqual({
      baseRef: 'main',
      mergeBase: 'abc123',
      commitFileDiff: [],
      baseDiffStats: {
        allChange: { add: 5, del: 3 },
      },
    });
  });

  it('returns null when no base ref can be proven', async () => {
    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        throw new Error(`Unknown revision: ${args[2] ?? ''}`);
      }
      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(resolveGitMergeBase(runGit, 'main')).resolves.toBeNull();
    await expect(getGitDiffStats(runGit, { preferredBaseBranch: 'main' })).resolves.toBeNull();
  });

  it('returns null when merge-base cannot be proven', async () => {
    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'main^{commit}') return 'deadbeef\n';
        throw new Error(`Unknown revision: ${args[2] ?? ''}`);
      }
      if (key === 'merge-base main HEAD') throw new Error('merge-base failed');
      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(resolveGitMergeBase(runGit, 'main')).resolves.toBeNull();
    await expect(getGitDiffStats(runGit, { preferredBaseBranch: 'main' })).resolves.toBeNull();
  });

  it('uses baseCommitHash to diff against working tree when provided', async () => {
    const baseNumstat = ['5\t1\ta.ts', ''].join('\n');
    // This simulates diff from baseCommitHash to working tree (includes uncommitted changes)
    const workingTreeDiffNumstat = ['3\t1\ta.ts', '10\t0\tnew-file.ts', ''].join('\n');

    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');

      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';

      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'main^{commit}') return 'deadbeef\n';
        throw new Error(`Unknown revision: ${args[2] ?? ''}`);
      }

      if (key === 'merge-base main HEAD') return 'abc123\n';
      if (key === 'diff --numstat --no-renames abc123 HEAD') return baseNumstat;
      // This is the key: diff from baseCommitHash to working tree (no HEAD specified)
      if (key === 'diff --numstat --no-renames def456') return workingTreeDiffNumstat;
      if (key === 'ls-files --others --exclude-standard -z') return '';

      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(
      getGitDiffStats(runGit, { preferredBaseBranch: 'main', baseCommitHash: 'def456' })
    ).resolves.toEqual({
      baseRef: 'main',
      mergeBase: 'abc123',
      commitFileDiff: [
        { filePath: 'a.ts', add: 3, del: 1 },
        { filePath: 'new-file.ts', add: 10, del: 0 },
      ],
      baseDiffStats: {
        allChange: { add: 5, del: 1 },
      },
    });
  });

  it('captures working-tree dirty file fingerprints for turn-start filtering', async () => {
    const modifiedHash = 'a'.repeat(40);
    const untrackedHash = 'b'.repeat(40);
    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');

      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
      if (key === 'diff --name-status --no-renames -z HEAD') {
        return ['M', 'src/changed.ts', 'D', 'src/deleted.ts', ''].join('\0');
      }
      if (key === 'ls-files --others --exclude-standard -z') {
        return ['src/new.ts', ''].join('\0');
      }
      if (key === 'hash-object -- src/changed.ts src/new.ts') {
        return `${modifiedHash}\n${untrackedHash}\n`;
      }

      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(captureGitWorkingTreeDiffBaseline(runGit)).resolves.toEqual({
      'src/changed.ts': { status: 'M', objectHash: modifiedHash },
      'src/deleted.ts': { status: 'D', objectHash: null },
      'src/new.ts': { status: '??', objectHash: untrackedHash },
    });
  });

  it('filters unchanged turn-start dirty files from fallback turn fileDiff', async () => {
    const unchangedHash = 'a'.repeat(40);
    const changedBeforeHash = 'b'.repeat(40);
    const changedAfterHash = 'c'.repeat(40);
    const untrackedHash = 'd'.repeat(40);
    const baseNumstat = ['5\t1\ta.ts', ''].join('\n');
    const workingTreeDiffNumstat = [
      '1\t0\tpreexisting.ts',
      '2\t1\tchanged-dirty.ts',
      '4\t0\tpreexisting-untracked.ts',
      '10\t0\tnew-file.ts',
      '',
    ].join('\n');

    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');

      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';

      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'main^{commit}') return 'deadbeef\n';
        throw new Error(`Unknown revision: ${args[2] ?? ''}`);
      }

      if (key === 'merge-base main HEAD') return 'abc123\n';
      if (key === 'diff --numstat --no-renames abc123 HEAD') return baseNumstat;
      if (key === 'diff --numstat --no-renames def456') return workingTreeDiffNumstat;
      if (key === 'ls-files --others --exclude-standard -z') return '';
      if (key === 'hash-object -- preexisting.ts changed-dirty.ts preexisting-untracked.ts') {
        return `${unchangedHash}\n${changedAfterHash}\n${untrackedHash}\n`;
      }

      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(
      getGitDiffStats(runGit, {
        preferredBaseBranch: 'main',
        baseCommitHash: 'def456',
        turnStartWorkingTreeDiff: {
          'preexisting.ts': { status: 'M', objectHash: unchangedHash },
          'changed-dirty.ts': { status: 'M', objectHash: changedBeforeHash },
          'preexisting-untracked.ts': { status: '??', objectHash: untrackedHash },
        },
      })
    ).resolves.toEqual({
      baseRef: 'main',
      mergeBase: 'abc123',
      commitFileDiff: [
        { filePath: 'changed-dirty.ts', add: 2, del: 1 },
        { filePath: 'new-file.ts', add: 10, del: 0 },
      ],
      baseDiffStats: {
        allChange: { add: 5, del: 1 },
      },
    });
  });

  it('excludes untracked files from base stats and filters unchanged turn-start untracked files', async () => {
    const preexistingUntrackedHash = 'a'.repeat(40);
    const changedUntrackedBeforeHash = 'b'.repeat(40);
    const changedUntrackedAfterHash = 'c'.repeat(40);
    const newUntrackedHash = 'd'.repeat(40);
    const baseNumstat = ['5\t1\ta.ts', ''].join('\n');
    const workingTreeDiffNumstat = ['2\t0\ttracked.ts', ''].join('\n');

    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');

      if (key === 'rev-parse --is-inside-work-tree') return 'true\n';

      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'main^{commit}') return 'deadbeef\n';
        throw new Error(`Unknown revision: ${args[2] ?? ''}`);
      }

      if (key === 'merge-base main HEAD') return 'abc123\n';
      if (key === 'diff --numstat --no-renames abc123 HEAD') return baseNumstat;
      if (key === 'diff --numstat --no-renames def456') return workingTreeDiffNumstat;
      if (key === 'ls-files --others --exclude-standard -z') {
        return [
          'preexisting-untracked.ts',
          'changed-untracked.ts',
          'new-untracked.ts',
          'unreadable-untracked.ts',
          '',
        ].join('\0');
      }
      if (
        key ===
        [
          'hash-object',
          '--',
          'preexisting-untracked.ts',
          'changed-untracked.ts',
          'new-untracked.ts',
          'unreadable-untracked.ts',
        ].join(' ')
      ) {
        return `${preexistingUntrackedHash}\n${changedUntrackedAfterHash}\n${newUntrackedHash}\n`;
      }

      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(
      getGitDiffStats(runGit, {
        preferredBaseBranch: 'main',
        baseCommitHash: 'def456',
        turnStartWorkingTreeDiff: {
          'preexisting-untracked.ts': { status: '??', objectHash: preexistingUntrackedHash },
          'changed-untracked.ts': { status: '??', objectHash: changedUntrackedBeforeHash },
        },
        countWorkingTreeFileLines: async (filePath) => {
          switch (filePath) {
            case 'preexisting-untracked.ts':
              return 4;
            case 'changed-untracked.ts':
              return 6;
            case 'new-untracked.ts':
              return 3;
            case 'unreadable-untracked.ts':
              return null;
            default:
              return null;
          }
        },
      })
    ).resolves.toEqual({
      baseRef: 'main',
      mergeBase: 'abc123',
      commitFileDiff: [
        { filePath: 'tracked.ts', add: 2, del: 0 },
        { filePath: 'changed-untracked.ts', add: 6, del: 0 },
        { filePath: 'new-untracked.ts', add: 3, del: 0 },
        { filePath: 'unreadable-untracked.ts', add: 0, del: 0 },
      ],
      baseDiffStats: {
        allChange: { add: 5, del: 1 },
      },
    });
  });
});

describe('isWorkspaceDirty', () => {
  it('runs only `git status --porcelain` (no separate worktree pre-probe)', async () => {
    const calls: string[] = [];
    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'status --porcelain') return ' M src/app.ts\n';
      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(isWorkspaceDirty(runGit)).resolves.toBe(true);
    expect(calls).toEqual(['status --porcelain']);
  });

  it('returns true when there are uncommitted changes', async () => {
    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') return ' M src/app.ts\n';
      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(isWorkspaceDirty(runGit)).resolves.toBe(true);
  });

  it('returns false when working tree is clean', async () => {
    const runGit: GitRunner = async (args) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') return '';
      throw new Error(`Unexpected git args: ${key}`);
    };

    await expect(isWorkspaceDirty(runGit)).resolves.toBe(false);
  });

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
