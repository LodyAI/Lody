import { describe, expect, it, vi } from 'vitest';
import type { ISession } from '@/session/session-manager';
import type { Logger } from '@/utils/logger';
import { detectPullRequestForBranch } from './pr-detector';

describe('detectPullRequestForBranch', () => {
  const pr = {
    number: 1,
    url: 'https://github.com/owner/repo/pull/1',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feature',
    baseRefName: 'main',
    isCrossRepository: false,
  };

  async function detect(
    branchName: string,
    repo: unknown,
    prs: unknown,
    error = false,
    repoFailure?: 'exec' | 'json'
  ) {
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      setLevel: vi.fn(),
      setDebug: vi.fn(),
      child: () => logger,
      close: async () => {},
    };
    const session = {
      exec: vi.fn(async (_command: string, args: string[]) => {
        if (error) throw new Error('gh unavailable');
        if (args[0] === 'repo') {
          if (repoFailure === 'exec') throw new Error('repo lookup unavailable');
          if (repoFailure === 'json') return 'invalid JSON';
        }
        return JSON.stringify(args[0] === 'repo' ? repo : prs);
      }),
    } as unknown as ISession;
    return detectPullRequestForBranch({
      session,
      workdir: '/repo',
      repoFullName: 'owner/repo',
      branchName,
      logger,
    });
  }

  it('does not discover an open fork PR on the default branch', async () => {
    expect(
      await detect('main', { defaultBranchRef: { name: 'main' } }, [
        { ...pr, headRefName: 'main', isCrossRepository: true },
      ])
    ).toBeNull();
    expect(await detect('main', { defaultBranchRef: { name: 'main' } }, [pr])).toBeNull();
  });

  it('ignores fork PRs while retaining same-repository feature PRs', async () => {
    expect(
      await detect('feature', { defaultBranchRef: { name: 'main' } }, [
        { ...pr, number: 2, isCrossRepository: true },
        { ...pr, isDraft: true },
      ])
    ).toMatchObject({
      prNumber: 1,
      status: 'draft',
      branch: 'feature',
    });
    expect(
      await detect('feature', { defaultBranchRef: null }, [{ ...pr, isCrossRepository: true }])
    ).toBeNull();
  });

  it('handles empty, malformed and failed GitHub responses without inventing an association', async () => {
    expect(await detect('feature', { defaultBranchRef: null }, [])).toBeNull();
    expect(await detect('feature', {}, [{ ...pr, isCrossRepository: 'false' }])).toBeNull();
    expect(await detect('feature', {}, [], true)).toBeNull();
  });

  it('does not infer a default branch from malformed repository metadata', async () => {
    expect(await detect('feature', { defaultBranchRef: {} }, [pr])).toMatchObject({ prNumber: 1 });
  });

  it.each(['exec', 'json'] as const)(
    'keeps detecting PRs after default-branch lookup %s failure',
    async (failure) => {
      expect(await detect('feature', {}, [pr], false, failure)).toMatchObject({
        prNumber: 1,
        status: 'open',
        branch: 'feature',
      });
    }
  );
});
