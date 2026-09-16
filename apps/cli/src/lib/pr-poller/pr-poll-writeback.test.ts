import { describe, expect, it } from 'vitest';
import type {
  SessionMeta,
  SessionPullRequestMeta,
  SessionPullRequestStateMeta,
} from '@lody/shared';
import type { PrObservation } from './github-graphql-client';
import {
  planAssociation,
  planPullRequestMetaWrite,
  selectCurrentPullRequestUrl,
} from './pr-poll-writeback';

const NOW_SEC = 1_752_747_230; // 2026-07-17T12:00:00Z in epoch seconds
const URL_1 = 'https://github.com/owner/repo/pull/1';
const URL_2 = 'https://github.com/owner/repo/pull/2';

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { userId: 'user-1', ...overrides } as SessionMeta;
}

function obs(prNumber: number, overrides: Partial<PrObservation> = {}): PrObservation {
  return {
    number: prNumber,
    url: `https://github.com/owner/repo/pull/${prNumber}`,
    status: 'open',
    headRefName: 'feat/x',
    updatedAt: '2026-07-17T10:00:00Z',
    ciState: null,
    mergeState: null,
    ...overrides,
  };
}

describe('selectCurrentPullRequestUrl', () => {
  const associated: SessionPullRequestMeta[] = [
    { url: URL_1, status: 'open' },
    { url: URL_2, status: 'open' },
  ];

  it('is deterministic regardless of observation insertion order', () => {
    const a = new Map([
      [URL_1, obs(1, { updatedAt: '2026-07-17T09:00:00Z' })],
      [URL_2, obs(2, { updatedAt: '2026-07-17T11:00:00Z' })],
    ]);
    const b = new Map([...a.entries()].reverse());
    expect(
      selectCurrentPullRequestUrl({ associated, observations: a, runtimeBranch: 'feat/x' })
    ).toBe(URL_2);
    expect(
      selectCurrentPullRequestUrl({ associated, observations: b, runtimeBranch: 'feat/x' })
    ).toBe(URL_2);
  });

  it('prefers the runtime-branch match over a newer PR on another branch', () => {
    const observations = new Map([
      [URL_1, obs(1, { headRefName: 'feat/x', updatedAt: '2026-07-17T09:00:00Z' })],
      [URL_2, obs(2, { headRefName: 'other', updatedAt: '2026-07-17T11:00:00Z' })],
    ]);
    expect(selectCurrentPullRequestUrl({ associated, observations, runtimeBranch: 'feat/x' })).toBe(
      URL_1
    );
    // Without a runtime branch the branch rule is ignored → newer wins.
    expect(selectCurrentPullRequestUrl({ associated, observations, runtimeBranch: null })).toBe(
      URL_2
    );
  });

  it('prefers open/draft over terminal, even an unobserved open association', () => {
    // Same branch rank (observation on another branch) → openness decides.
    const observations = new Map([[URL_2, obs(2, { status: 'merged', headRefName: 'other' })]]);
    expect(selectCurrentPullRequestUrl({ associated, observations, runtimeBranch: 'feat/x' })).toBe(
      URL_1
    );
  });

  it('a terminal PR on the runtime branch outranks an open association from another context', () => {
    // Branch match is the strongest rank: the session shows its own branch's
    // PR even after it merged, not a stray open association.
    const withTerminal: SessionPullRequestMeta[] = [
      { url: URL_1, status: 'open' },
      { url: URL_2, status: 'merged' },
    ];
    const observations = new Map([[URL_2, obs(2, { status: 'merged' })]]);
    expect(
      selectCurrentPullRequestUrl({
        associated: withTerminal,
        observations,
        runtimeBranch: 'feat/x',
      })
    ).toBe(URL_2);
  });

  it('keeps the existing current (last item) when nothing is observed', () => {
    expect(
      selectCurrentPullRequestUrl({ associated, observations: new Map(), runtimeBranch: null })
    ).toBe(URL_2);
  });

  it('breaks full ties by the larger PR number', () => {
    const observations = new Map([
      [URL_1, obs(1)],
      [URL_2, obs(2)],
    ]);
    expect(selectCurrentPullRequestUrl({ associated, observations, runtimeBranch: null })).toBe(
      URL_2
    );
  });
});

describe('planAssociation', () => {
  it('plans association when a discovered PR wins current-PR selection', () => {
    const meta = makeMeta({ pullRequests: [{ url: URL_1, status: 'open' }] });
    const discovered = obs(2, { updatedAt: '2026-07-18T00:00:00Z' });
    expect(
      planAssociation({ meta, observations: [], discovered: [discovered], runtimeBranch: 'feat/x' })
    ).toEqual({ url: URL_2, prNumber: 2, status: 'open' });
  });

  it('returns null when the discovered PR is already associated', () => {
    const meta = makeMeta({ pullRequests: [{ url: URL_1, status: 'open' }] });
    expect(
      planAssociation({ meta, observations: [], discovered: [obs(1)], runtimeBranch: 'feat/x' })
    ).toBeNull();
  });

  it('returns null when an unobserved open association still outranks the discovery', () => {
    // Without a runtime branch the branch rule is ignored: the discovered
    // terminal PR loses to the stored open association → no new link.
    const meta = makeMeta({ pullRequests: [{ url: URL_1, status: 'open' }] });
    expect(
      planAssociation({
        meta,
        observations: [],
        discovered: [obs(2, { status: 'merged' })],
        runtimeBranch: null,
      })
    ).toBeNull();
  });

  it('gives already-associated PRs their own ranking evidence (no pointless terminal link)', () => {
    // The associated open PR #2 and an OLDER merged #1 both sit on the
    // runtime branch. Without #2's observation in the ranking it would lack
    // branch-match evidence and the terminal #1 would win and be associated.
    const meta = makeMeta({ pullRequests: [{ url: URL_2, status: 'open' }] });
    const olderMerged = obs(1, { status: 'merged', updatedAt: '2026-07-16T00:00:00Z' });

    // Evidence arriving via the discovery candidates themselves...
    expect(
      planAssociation({
        meta,
        observations: [],
        discovered: [obs(2), olderMerged],
        runtimeBranch: 'feat/x',
      })
    ).toBeNull();
    // ...or via the same round's status observation.
    expect(
      planAssociation({
        meta,
        observations: [obs(2)],
        discovered: [olderMerged],
        runtimeBranch: 'feat/x',
      })
    ).toBeNull();
  });

  it('associates the first PR for a session with no associations', () => {
    expect(
      planAssociation({
        meta: makeMeta(),
        observations: [],
        discovered: [obs(5)],
        runtimeBranch: 'feat/x',
      })
    ).toEqual({ url: 'https://github.com/owner/repo/pull/5', prNumber: 5, status: 'open' });
    expect(
      planAssociation({
        meta: makeMeta(),
        observations: [],
        discovered: [],
        runtimeBranch: 'feat/x',
      })
    ).toBeNull();
  });
});

describe('planPullRequestMetaWrite', () => {
  it('returns null when nothing changed (fresh-meta predicate — no-op writes)', () => {
    const meta = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: { [URL_1]: { s: 's', m: 'c', t: 1_752_000_000 } },
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { ciState: 's', mergeState: 'c' })],
      runtimeBranch: 'feat/x',
      nowSec: NOW_SEC,
    });

    expect(plan).toBeNull();
  });

  it('upserts status by URL and preserves other associations (never whole-array replace)', () => {
    const meta = makeMeta({
      pullRequests: [
        { url: URL_1, status: 'draft' },
        { url: URL_2, status: 'open' },
      ],
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { status: 'open' })],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });

    expect(plan?.changedStatusUrls).toEqual([URL_1]);
    // URL_2 stays associated; URL_2 remains current (last) — the observed
    // open URL_1 does not outrank it here (same openness, URL_2 has the
    // larger number... rank falls to updatedAt: observed URL_1 wins).
    expect(plan?.pullRequests?.map((pr) => pr.url)).toContain(URL_2);
  });

  it('moves the selected current PR to the last array position', () => {
    const meta = makeMeta({
      pullRequests: [
        { url: URL_2, status: 'open' },
        { url: URL_1, status: 'merged' },
      ],
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(2)],
      runtimeBranch: 'feat/x',
      nowSec: NOW_SEC,
    });

    expect(plan?.pullRequests).toEqual([
      { url: URL_1, status: 'merged' },
      { url: URL_2, status: 'open' },
    ]);
  });

  it('strips legacy detail fields exactly once (ordering bootstrap)', () => {
    const meta = makeMeta({
      pullRequests: [
        {
          url: URL_1,
          status: 'open',
          number: 1,
          reportedAt: '2026-01-01',
        } as SessionPullRequestMeta,
      ],
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1)],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });
    expect(plan?.pullRequests).toEqual([{ url: URL_1, status: 'open' }]);

    // After normalization an identical poll produces no write.
    const normalized = makeMeta({ pullRequests: plan?.pullRequests ?? [] });
    expect(
      planPullRequestMetaWrite({
        meta: normalized,
        observations: [obs(1)],
        runtimeBranch: null,
        nowSec: NOW_SEC,
      })
    ).toBeNull();
  });

  it('appends a freshly associated PR and makes it current', () => {
    const meta = makeMeta({ pullRequests: [{ url: URL_1, status: 'merged' }] });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [],
      newlyAssociated: [obs(2, { ciState: 's', mergeState: 'c' })],
      runtimeBranch: 'feat/x',
      nowSec: NOW_SEC,
    });

    expect(plan?.pullRequests).toEqual([
      { url: URL_1, status: 'merged' },
      { url: URL_2, status: 'open' },
    ]);
    expect(plan?.pullRequestState).toEqual({ [URL_2]: { s: 's', m: 'c', t: NOW_SEC } });
  });

  it('ignores observations for URLs that are not associated (association-first invariant)', () => {
    const meta = makeMeta({ pullRequests: [{ url: URL_1, status: 'open' }] });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(3, { ciState: 's' })], // discovered but NOT associated
      runtimeBranch: 'feat/x',
      nowSec: NOW_SEC,
    });

    expect(plan).toBeNull();
  });

  it('writes CI + merge state on change with a fresh t, and drops legacy r on touch', () => {
    const meta = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: { [URL_1]: { s: 'p', r: 'y', t: 1_752_000_000 } },
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { ciState: 's', mergeState: 'c' })],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });

    expect(plan?.pullRequests).toBeNull();
    expect(plan?.changedStateUrls).toEqual([URL_1]);
    expect(plan?.pullRequestState).toEqual({ [URL_1]: { s: 's', m: 'c', t: NOW_SEC } });
  });

  it('drops a stale legacy r even when s/m are unchanged (t marks s/m changes only)', () => {
    const meta = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: { [URL_1]: { s: 's', m: 'c', r: 'y', t: 1_752_000_000 } },
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { ciState: 's', mergeState: 'c' })],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });

    // `r` is removed, but `t` stays: only `s`/`m` semantic changes bump it.
    expect(plan?.pullRequestState).toEqual({ [URL_1]: { s: 's', m: 'c', t: 1_752_000_000 } });
  });

  it('does not touch t when the signals are unchanged', () => {
    const meta = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: { [URL_1]: { s: 'p', m: 'b', t: 1_752_000_000 } },
    });

    expect(
      planPullRequestMetaWrite({
        meta,
        observations: [obs(1, { ciState: 'p', mergeState: 'b' })],
        runtimeBranch: null,
        nowSec: NOW_SEC,
      })
    ).toBeNull();
  });

  it('keeps a merge-only record when the commit has no checks', () => {
    const meta = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: { [URL_1]: { s: 's', m: 'c', t: 1_752_000_000 } },
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { ciState: null, mergeState: 'c' })],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });

    // `s` dropped (no checks → no badge), `m` kept, t refreshed (s changed).
    expect(plan?.changedStateUrls).toEqual([URL_1]);
    expect(plan?.pullRequestState).toEqual({ [URL_1]: { m: 'c', t: NOW_SEC } });
  });

  it('deletes the record when both signals are absent; writes nothing when no record exists', () => {
    const withRecord = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: { [URL_1]: { s: 's', t: 1_752_000_000 } },
    });
    const plan = planPullRequestMetaWrite({
      meta: withRecord,
      observations: [obs(1)],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });
    expect(plan?.removedStateUrls).toEqual([URL_1]);
    expect(plan?.pullRequestState).toEqual({});

    const withoutRecord = makeMeta({ pullRequests: [{ url: URL_1, status: 'open' }] });
    expect(
      planPullRequestMetaWrite({
        meta: withoutRecord,
        observations: [obs(1)],
        runtimeBranch: null,
        nowSec: NOW_SEC,
      })
    ).toBeNull();
  });

  it('deletes the state record when the PR turns terminal', () => {
    const meta = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: { [URL_1]: { s: 's', m: 'c', t: 1_752_000_000 } },
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { status: 'merged', ciState: 's', mergeState: 'c' })],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });

    expect(plan?.pullRequests).toEqual([{ url: URL_1, status: 'merged' }]);
    expect(plan?.removedStateUrls).toEqual([URL_1]);
    expect(plan?.pullRequestState).toEqual({});
  });

  it('prunes state entries whose URL is no longer an associated PR', () => {
    const meta = makeMeta({
      pullRequests: [{ url: URL_1, status: 'open' }],
      pullRequestState: {
        [URL_1]: { s: 's', t: 1_752_000_000 },
        [URL_2]: { s: 'f', t: 1_752_000_000 },
      },
    });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { ciState: 's' })],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });

    expect(plan?.prunedStateUrls).toEqual([URL_2]);
    expect(plan?.pullRequestState).toEqual({
      [URL_1]: { s: 's', t: 1_752_000_000 },
    });
  });

  it('an empty discovery never deletes existing associations', () => {
    const meta = makeMeta({ pullRequests: [{ url: URL_1, status: 'open' }] });
    expect(
      planPullRequestMetaWrite({
        meta,
        observations: [],
        runtimeBranch: 'feat/x',
        nowSec: NOW_SEC,
      })
    ).toBeNull();
  });

  it('does not mutate the input meta', () => {
    const pullRequests = [{ url: URL_1, status: 'open' as const }];
    const pullRequestState: Record<string, SessionPullRequestStateMeta> = {
      [URL_1]: { s: 'p', t: 1 },
    };
    const meta = makeMeta({ pullRequests, pullRequestState });

    planPullRequestMetaWrite({
      meta,
      observations: [obs(1, { status: 'merged', ciState: 's', mergeState: 'c' })],
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });

    expect(pullRequests).toEqual([{ url: URL_1, status: 'open' }]);
    expect(pullRequestState).toEqual({ [URL_1]: { s: 'p', t: 1 } });
  });

  it('stays within the 50B per-entry budget for both signals', () => {
    // Worst case: both signals present + epoch-seconds t (10 digits until 2286).
    const entry: SessionPullRequestStateMeta = { s: 'f', m: 'c', t: 1_999_999_999 };
    expect(JSON.stringify(entry).length).toBeLessThanOrEqual(50);
  });
});
