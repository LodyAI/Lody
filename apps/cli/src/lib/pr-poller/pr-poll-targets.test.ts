import { describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import {
  computeDiscoveryFingerprint,
  enumeratePrPollTargets,
  getCurrentPullRequest,
  resolveDiscoveryBranch,
  type AliveSessionMeta,
} from './pr-poll-targets';

const sid = (value: string): SessionId => value as SessionId;

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { userId: 'user-1', ...overrides } as SessionMeta;
}

function alive(sessionId: string, meta: SessionMeta): AliveSessionMeta {
  return { sessionId: sid(sessionId), meta };
}

const githubProject = { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'];

describe('enumeratePrPollTargets', () => {
  it('collects open/draft PRs as status targets with parsed repo + number', () => {
    const [entry] = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          pullRequests: [
            { url: 'https://github.com/owner/repo/pull/42', status: 'open' },
            { url: 'https://github.com/owner/repo/pull/43', status: 'draft' },
          ],
        })
      ),
    ]);

    expect(entry?.ownerSessionId).toBe(sid('s1'));
    expect(entry?.statusTargets).toEqual([
      {
        url: 'https://github.com/owner/repo/pull/42',
        repoFullName: 'owner/repo',
        prNumber: 42,
        status: 'open',
      },
      {
        url: 'https://github.com/owner/repo/pull/43',
        repoFullName: 'owner/repo',
        prNumber: 43,
        status: 'draft',
      },
    ]);
  });

  it('excludes terminal PRs (merged/closed) from status targets', () => {
    const [entry] = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          pullRequests: [
            { url: 'https://github.com/owner/repo/pull/1', status: 'merged' },
            { url: 'https://github.com/owner/repo/pull/2', status: 'closed' },
          ],
        })
      ),
    ]);

    expect(entry?.statusTargets).toEqual([]);
  });

  it('skips PR entries whose url does not parse as a GitHub PR url', () => {
    const [entry] = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          pullRequests: [
            { url: 'https://gitlab.com/owner/repo/pull/1', status: 'open' },
            { url: 'not-a-url', status: 'open' },
            { url: 'https://github.com/owner/repo/pull/7', status: 'open' },
          ],
        })
      ),
    ]);

    expect(entry?.statusTargets).toHaveLength(1);
    expect(entry?.statusTargets[0]?.prNumber).toBe(7);
  });

  it('normalizes child tabs to their owner session (parentSessionId ?? sessionId)', () => {
    const entries = enumeratePrPollTargets([
      alive(
        'owner',
        makeMeta({
          pullRequests: [{ url: 'https://github.com/owner/repo/pull/9', status: 'open' }],
        })
      ),
      alive('child-a', makeMeta({ parentSessionId: sid('owner') })),
      alive('child-b', makeMeta({ parentSessionId: sid('owner') })),
    ]);

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.ownerSessionId).toBe(sid('owner'));
    expect(entry?.memberSessionIds).toEqual([sid('owner'), sid('child-a'), sid('child-b')]);
    expect(entry?.statusTargets).toHaveLength(1);
  });

  it('takes the newest lastMessageAt across owner and child tabs', () => {
    const [entry] = enumeratePrPollTargets([
      alive('owner', makeMeta({ lastMessageAt: 100 })),
      alive('child', makeMeta({ parentSessionId: sid('owner'), lastMessageAt: 500 })),
    ]);

    expect(entry?.lastMessageAtMs).toBe(500);
  });

  it('skips a child tab whose owner meta is not in the alive set', () => {
    const entries = enumeratePrPollTargets([
      alive('child', makeMeta({ parentSessionId: sid('missing-owner') })),
    ]);

    expect(entries).toEqual([]);
  });

  it('excludes archived owners entirely', () => {
    const entries = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          isArchived: true,
          pullRequests: [{ url: 'https://github.com/owner/repo/pull/9', status: 'open' }],
        })
      ),
    ]);

    expect(entries).toEqual([]);
  });

  it('emits a discovery target for a session with repo + branch but no PR', () => {
    const [entry] = enumeratePrPollTargets([
      alive('s1', makeMeta({ project: githubProject, branchName: 'feat/x' })),
    ]);

    expect(entry?.statusTargets).toEqual([]);
    expect(entry?.discoveryTarget).toEqual({ repoFullName: 'owner/repo', branch: 'feat/x' });
    expect(entry?.runtimeBranch).toBe('feat/x');
  });

  it('keeps the discovery target when an open PR is already associated (newer-PR detection)', () => {
    const [entry] = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          project: githubProject,
          branchName: 'feat/x',
          pullRequests: [{ url: 'https://github.com/owner/repo/pull/9', status: 'open' }],
        })
      ),
    ]);

    expect(entry?.statusTargets).toHaveLength(1);
    expect(entry?.discoveryTarget).toEqual({ repoFullName: 'owner/repo', branch: 'feat/x' });
  });

  it('idle-terminal: no discovery when the current PR is terminal and the context fingerprint matches', () => {
    const meta = makeMeta({
      project: githubProject,
      branchName: 'feat/x',
      pullRequests: [{ url: 'https://github.com/owner/repo/pull/9', status: 'merged' }],
    });
    const fingerprint = computeDiscoveryFingerprint('owner/repo', 'feat/x');

    const [idle] = enumeratePrPollTargets([alive('s1', meta)], { s1: fingerprint });
    expect(idle?.discoveryTarget).toBeNull();

    // A branch switch changes the fingerprint → discovery resumes.
    const [resumed] = enumeratePrPollTargets(
      [alive('s1', { ...meta, branchName: 'feat/next' })],
      { s1: fingerprint }
    );
    expect(resumed?.discoveryTarget).toEqual({ repoFullName: 'owner/repo', branch: 'feat/next' });

    // No recorded fingerprint (fresh daemon) → one discovery is still allowed.
    const [fresh] = enumeratePrPollTargets([alive('s1', meta)]);
    expect(fresh?.discoveryTarget).toEqual({ repoFullName: 'owner/repo', branch: 'feat/x' });
  });

  it('does NOT fall back to baseBranch when branchName is missing', () => {
    // baseBranch is the session's starting ref (often `main`); querying PRs
    // headed by it could permanently associate an unrelated PR.
    const [entry] = enumeratePrPollTargets([
      alive('s1', makeMeta({ project: githubProject, baseBranch: 'main' })),
    ]);

    expect(entry?.discoveryTarget).toBeNull();
    expect(entry?.runtimeBranch).toBeNull();
  });

  it('skips PR discovery and status polling for a direct local project', () => {
    const [entry] = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          project: {
            kind: 'local',
            githubRepoFullName: 'owner/local-repo',
          } as SessionMeta['project'],
          branchName: 'fix/y',
          pullRequests: [
            { url: 'https://github.com/owner/local-repo/pull/7', status: 'open' },
          ],
        })
      ),
    ]);

    expect(entry?.statusTargets).toEqual([]);
    expect(entry?.discoveryTarget).toBeNull();
  });

  it('resolves the GitHub repo for local-project worktrees', () => {
    const [entry] = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          project: {
            kind: 'local',
            githubRepoFullName: 'owner/local-repo',
            useWorktree: true,
          } as SessionMeta['project'],
          branchName: 'fix/y',
        })
      ),
    ]);

    expect(entry?.discoveryTarget).toEqual({
      repoFullName: 'owner/local-repo',
      branch: 'fix/y',
    });
  });

  it('honors legacy isWorktree metadata for local-project discovery', () => {
    const [entry] = enumeratePrPollTargets([
      alive(
        's1',
        makeMeta({
          project: {
            kind: 'local',
            githubRepoFullName: 'owner/local-repo',
          } as SessionMeta['project'],
          isWorktree: true,
          branchName: 'fix/y',
        })
      ),
    ]);

    expect(entry?.discoveryTarget).toEqual({
      repoFullName: 'owner/local-repo',
      branch: 'fix/y',
    });
  });

  it('emits no discovery target without a resolvable repo or branch', () => {
    const [noRepo, noBranch] = enumeratePrPollTargets([
      alive('s1', makeMeta({ branchName: 'feat/x' })),
      alive('s2', makeMeta({ project: githubProject })),
    ]);

    expect(noRepo?.discoveryTarget).toBeNull();
    expect(noBranch?.discoveryTarget).toBeNull();
  });

  it('routes repo resolution through the injectable resolver', () => {
    const seen: string[] = [];
    const [entry] = enumeratePrPollTargets(
      [alive('s1', makeMeta({ branchName: 'feat/x' }))],
      {},
      (meta) => {
        seen.push(meta.userId);
        return 'injected/repo';
      }
    );

    expect(seen).toEqual(['user-1']);
    expect(entry?.discoveryTarget).toEqual({ repoFullName: 'injected/repo', branch: 'feat/x' });
  });
});

describe('resolveDiscoveryBranch', () => {
  it('requires branchName; baseBranch is never used', () => {
    expect(resolveDiscoveryBranch(makeMeta({ branchName: 'feat', baseBranch: 'main' }))).toBe(
      'feat'
    );
    expect(
      resolveDiscoveryBranch(makeMeta({ branchName: '  ', baseBranch: 'main' }))
    ).toBeUndefined();
    expect(resolveDiscoveryBranch(makeMeta({ baseBranch: 'main' }))).toBeUndefined();
    expect(resolveDiscoveryBranch(makeMeta({}))).toBeUndefined();
  });
});

describe('getCurrentPullRequest', () => {
  it('returns the last array item (shared metadata contract)', () => {
    expect(getCurrentPullRequest(undefined)).toBeNull();
    expect(getCurrentPullRequest(makeMeta({ pullRequests: [] }))).toBeNull();
    expect(
      getCurrentPullRequest(
        makeMeta({
          pullRequests: [
            { url: 'https://github.com/owner/repo/pull/1', status: 'merged' },
            { url: 'https://github.com/owner/repo/pull/2', status: 'open' },
          ],
        })
      )
    ).toEqual({ url: 'https://github.com/owner/repo/pull/2', status: 'open' });
  });
});
