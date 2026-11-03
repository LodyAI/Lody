import { planPullRequestLifecycle } from '@lody/shared';
import { describe, expect, it } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';
import {
  computeDiscoveryFingerprint,
  computePrPollMetaSignature,
  enumeratePrPollTargets,
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
  it('discovers each project group member independently and suppresses only its terminal repository', () => {
    const meta = makeMeta({
      projectRun: {
        members: {
          web: {
            src: { kind: 'github', repoFullName: 'owner/web' },
            branch: 'feature/task',
            base: 'main',
          },
          api: {
            src: { kind: 'local', localProjectId: 'api', machineId: 'machine' },
            repoFullName: 'owner/api',
            branch: 'feature/task',
            base: 'main',
          },
        },
      } as never,
      pullRequests: [{ url: 'https://github.com/owner/web/pull/1', status: 'merged' }],
    });
    const [entry] = enumeratePrPollTargets([alive('s1', meta)], {
      's1:web': computeDiscoveryFingerprint('owner/web', 'feature/task'),
    });
    expect(entry?.discoveryTargets).toEqual([
      {
        memberId: 'api',
        repoFullName: 'owner/api',
        branch: 'feature/task',
        nativeCredentials: true,
      },
    ]);
    expect(entry?.projectMemberIds).toEqual(['web', 'api']);
    const changed = structuredClone(meta);
    Object.values(changed.projectRun!.members)[0]!.branch = 'feature/next';
    expect(computePrPollMetaSignature(changed)).not.toBe(computePrPollMetaSignature(meta));
    expect(
      enumeratePrPollTargets([alive('s1', changed)], {
        's1:web': computeDiscoveryFingerprint('owner/web', 'feature/task'),
      })[0]?.discoveryTargets
    ).toHaveLength(2);
  });

  it('routes repository local-copy PR status and discovery through native credentials', () => {
    const meta = makeMeta({
      projectRun: {
        members: {
          web: {
            src: { kind: 'github', preferLocal: true, repoFullName: 'owner/web' },
            repositoryCheckout: { kind: 'local', machineId: 'machine', localProjectId: 'copy' },
            branch: 'task',
            base: 'main',
          },
        },
      } as never,
      pullRequests: [{ url: 'https://github.com/owner/web/pull/1', status: 'open' }],
    });
    const [entry] = enumeratePrPollTargets([alive('s1', meta)]);
    expect(entry?.discoveryTargets?.[0]).toMatchObject({
      repoFullName: 'owner/web',
      nativeCredentials: true,
    });
    expect(entry?.statusTargets[0]).toMatchObject({
      repoFullName: 'owner/web',
      nativeCredentials: true,
    });
    const before = computePrPollMetaSignature(meta);
    Object.values(meta.projectRun!.members)[0]!.repositoryCheckout = { kind: 'github' };
    expect(computePrPollMetaSignature(meta)).not.toBe(before);
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

  it('invalidates legacy checkpoints and folds child activity independently of enumeration order', () => {
    const owner = alive(
      'owner',
      makeMeta({
        project: githubProject,
        branchName: 'feat/x',
        lastMessageAt: 100,
        pullRequests: [{ url: 'https://github.com/owner/repo/pull/9', status: 'closed' }],
      })
    );
    const child = alive('child', makeMeta({ parentSessionId: sid('owner'), lastMessageAt: 200 }));
    for (const sessions of [
      [owner, child],
      [child, owner],
    ]) {
      for (const old of [
        'owner/repo|feat/x',
        computeDiscoveryFingerprint('owner/repo', 'feat/x', 100),
      ])
        expect(enumeratePrPollTargets(sessions, { owner: old })[0]?.discoveryTarget).toMatchObject({
          activityAtMs: 200,
        });
      expect(
        enumeratePrPollTargets(sessions, {
          owner: computeDiscoveryFingerprint('owner/repo', 'feat/x', 200),
        })[0]?.discoveryTarget
      ).toBeNull();
    }
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
});

it('keeps one terminal refresh until the compatibility status is projected', () => {
  const url = 'https://github.com/owner/repo/pull/42';
  const write = planPullRequestLifecycle(
    { url, status: 'merged', updatedAt: '2026-01-01T00:00:00Z' },
    undefined,
    'webhook'
  )!;
  const meta = makeMeta({ pullRequests: [{ url, status: 'open' }], [write.field]: write.value });
  const [entry] = enumeratePrPollTargets([alive('s1', meta)]);
  expect(entry?.statusTargets).toEqual([
    { url, repoFullName: 'owner/repo', prNumber: 42, status: 'merged' },
  ]);
  const projected = { ...meta, pullRequests: [{ url, status: 'merged' as const }] };
  expect(computePrPollMetaSignature(projected)).not.toBe(computePrPollMetaSignature(meta));
  expect(enumeratePrPollTargets([alive('s1', projected)])[0]?.statusTargets).toEqual([]);
});
