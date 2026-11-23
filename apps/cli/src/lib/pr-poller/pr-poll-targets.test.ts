import { LoroRepo } from 'loro-repo';
import { Flock } from '@loro-dev/flock-wasm';
import {
  getSessionRoomId,
  planPullRequestLifecycle,
  resolveSessionPullRequests,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import type { Logger } from '@/utils/logger';
import { selectHighOwners, type OwnerActivityInput } from './pr-poll-priority';
import {
  pickNextBatch,
  planDueBatches,
  prPollTargetKey,
  type PrPollBatchPlan,
  type SchedulableTarget,
} from './pr-poll-select';
import { createLodyPrPollerWorkspace } from './pr-poller-workspace';
import {
  computeDiscoveryFingerprint,
  computePrPollMetaSignature,
  enumeratePrPollTargets,
  type AliveSessionMeta,
} from './pr-poll-targets';

vi.mock('@/lib/command-runtime', () => ({
  listAliveSessionMetas: vi.fn(),
}));

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

describe('selectHighOwners', () => {
  const T0 = 1_720_000_000_000;
  const OPTIONS = { activityWindowMs: 10 * 60_000, highOwnerCap: 100 };

  function owner(
    id: string,
    overrides: Partial<Omit<OwnerActivityInput, 'ownerSessionId'>> = {}
  ): OwnerActivityInput {
    return {
      ownerSessionId: sid(id),
      memberSessionIds: [sid(id)],
      lastMessageAtMs: null,
      ...overrides,
    };
  }

  it('promotes viewed owners (any member counts) and recent-activity owners', () => {
    const high = selectHighOwners(
      [
        owner('viewed'),
        owner('viewed-via-child', { memberSessionIds: [sid('viewed-via-child'), sid('tab')] }),
        owner('active', { lastMessageAtMs: T0 - 5 * 60_000 }),
        owner('stale', { lastMessageAtMs: T0 - 11 * 60_000 }),
        owner('silent'),
      ],
      new Set([sid('viewed'), sid('tab')]),
      T0,
      OPTIONS
    );

    expect(high).toEqual(new Set([sid('viewed'), sid('viewed-via-child'), sid('active')]));
  });
});

describe('pr-poll-select', () => {
  const T0 = 1_720_000_000_000;

  function target(overrides: Partial<SchedulableTarget> = {}): SchedulableTarget {
    const ownerSessionId = overrides.ownerSessionId ?? sid('s1');
    const repoFullName = overrides.repoFullName ?? 'owner/repo';
    const kind = overrides.kind ?? 'status';
    return {
      key: prPollTargetKey(overrides.workspaceId ?? 'ws1', ownerSessionId, repoFullName, kind, 'q'),
      kind,
      workspaceId: 'ws1',
      ownerSessionId,
      repoFullName,
      lane: 'low',
      desiredIntervalMs: 300_000,
      minIntervalMs: 60_000,
      lastSuccessAtMs: null,
      lastAttemptAtMs: null,
      ...overrides,
    };
  }

  it('keeps native and managed queries for the same repository in separate batches', () => {
    const batches = planDueBatches(
      [
        target({
          discovery: { repoFullName: 'owner/repo', branch: 'local', nativeCredentials: true },
        }),
        target({
          ownerSessionId: sid('managed'),
          discovery: { repoFullName: 'owner/repo', branch: 'managed' },
        }),
      ],
      T0
    );
    expect(
      batches.map((batch) => [
        batch.nativeCredentials,
        batch.targets.map((t) => t.discovery?.branch),
      ])
    ).toEqual([
      [true, ['local']],
      [false, ['managed']],
    ]);
  });

  it('anti-starvation: after N−1 consecutive high dispatches a due low batch is picked', () => {
    const high = (repo: string, oldestDueAtMs: number): PrPollBatchPlan => ({
      workspaceId: 'ws1',
      repoFullName: repo,
      lane: 'high',
      oldestDueAtMs,
      targets: [],
    });
    const low = (repo: string, oldestDueAtMs: number): PrPollBatchPlan => ({
      workspaceId: 'ws1',
      repoFullName: repo,
      lane: 'low',
      oldestDueAtMs,
      targets: [],
    });
    const batches = [low('r1', 1), high('r2', 5)];
    expect(pickNextBatch(batches, 3, 5)?.lane).toBe('high');
    expect(pickNextBatch(batches, 4, 5)?.lane).toBe('low');
  });
});

describe('createLodyPrPollerWorkspace', () => {
  const machineId = (value: string): MachineId => value as MachineId;

  function createTestLogger(): Logger {
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      setLevel: vi.fn(),
      setDebug: vi.fn(),
      child: vi.fn(() => logger),
      close: vi.fn(async () => {}),
    };
    return logger;
  }

  beforeEach(() => {
    vi.mocked(listAliveSessionMetas).mockReset();
  });

  it('enumerates only sessions owned by this machine', async () => {
    vi.mocked(listAliveSessionMetas).mockResolvedValue([
      {
        roomId: getSessionRoomId(sid('owned')),
        meta: { userId: 'user-1', machineId: machineId('machine-1') } as SessionMeta,
      },
      {
        roomId: getSessionRoomId(sid('remote')),
        meta: { userId: 'user-2', machineId: machineId('machine-2') } as SessionMeta,
      },
      {
        roomId: getSessionRoomId(sid('legacy')),
        meta: { userId: 'user-1' } as SessionMeta,
      },
    ]);
    const workspace = createLodyPrPollerWorkspace({
      documentManager: {} as LoroDocumentManager,
      workspaceId: 'workspace-1',
      githubTokens: null,
      prAssociation: null,
      userId: 'user-1',
      machineId: machineId('machine-1'),
      logger: createTestLogger(),
    });

    await expect(workspace.listAliveSessionMetas()).resolves.toEqual([
      {
        sessionId: sid('owned'),
        meta: { userId: 'user-1', machineId: machineId('machine-1') },
      },
    ]);
    await workspace.dispose();
  });

  it('publishes lifecycle as local metadata and projects independent remote observations through the real Repo', async () => {
    const repo = await LoroRepo.create({});
    const owner = sid('owner');
    const room = getSessionRoomId(owner);
    const url = 'https://github.com/example/api/pull/7';
    const other = 'https://github.com/example/web/pull/7';
    const prs = [
      { url, status: 'open' },
      { url: other, status: 'draft' },
    ];
    const workspace = createLodyPrPollerWorkspace({
      documentManager: { repo } as unknown as LoroDocumentManager,
      workspaceId: 'workspace-1',
      githubTokens: null,
      prAssociation: null,
      userId: 'user-1',
      machineId: machineId('machine-1'),
      logger: createTestLogger(),
    });
    try {
      await repo.upsertDocMeta(room, { machineId: 'machine-1', pullRequests: prs });
      const observed = planPullRequestLifecycle({
        url,
        status: 'closed',
        updatedAt: '2026-01-02T00:00:00Z',
      })!;
      const localFields = new Set<string>();
      const unsubscribe = repo.getMeta().subscribe((batch) => {
        if (batch.source === 'local')
          for (const event of batch.events) {
            if (typeof event.key[2] === 'string') localFields.add(event.key[2]);
          }
      });
      await workspace.writeOwnerMeta(owner, { lifecycle: [observed] });
      repo.getMeta().commit();
      unsubscribe();
      expect(localFields.has(observed.field)).toBe(true);
      expect((await repo.getDocMeta(room))?.meta.pullRequests).toEqual(prs);
      expect(resolveSessionPullRequests(await workspace.readOwnerMeta(owner))).toEqual([
        { url, status: 'closed' },
        { url: other, status: 'draft' },
      ]);
      const webhook = planPullRequestLifecycle(
        { url: other, status: 'merged', updatedAt: '2026-01-03T00:00:00Z' },
        undefined,
        'webhook'
      )!;
      const delta = new Flock(webhook.peerId);
      delta.set(['m', room, webhook.field], webhook.value, webhook.value.u);
      const hydrated = new Promise<void>((resolve) => {
        const watch = repo.watch((event) => {
          if (
            event.kind === 'doc-metadata' &&
            event.docId === room &&
            webhook.field in event.patch
          ) {
            watch.unsubscribe();
            resolve();
          }
        });
      });
      repo.getMeta().importJson(delta.exportJson());
      repo.getMeta().commit();
      await hydrated;
      expect(resolveSessionPullRequests(await workspace.readOwnerMeta(owner))).toEqual([
        { url, status: 'closed' },
        { url: other, status: 'merged' },
      ]);
    } finally {
      await workspace.dispose();
      await repo.destroy();
    }
  });
});
