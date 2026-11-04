import { planPullRequestLifecycle } from '@lody/shared';
import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionPullRequestMeta } from '@lody/shared';
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
  const meta = { userId: 'user-1', ...overrides } as SessionMeta;
  // Existing modern fixtures have already published their provider revision.
  for (const pr of meta.pullRequests ?? []) {
    const write = planPullRequestLifecycle({ ...pr, updatedAt: '2026-07-17T10:00:00Z' });
    if (write && !Object.hasOwn(meta, write.field)) meta[write.field] = write.value;
  }
  return meta;
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
});

describe('planPullRequestMetaWrite', () => {
  it('ignores status-only observations for URLs that are not published', () => {
    const meta = makeMeta({ pullRequests: [{ url: URL_1, status: 'open' }] });

    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(3, { ciState: 's' })], // discovered but NOT associated
      runtimeBranch: 'feat/x',
      nowSec: NOW_SEC,
    });

    expect(plan).toBeNull();
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
});

describe('Project group repository ordering', () => {
  it('selects a current PR within the polled repository without moving another repository', () => {
    const other = 'https://github.com/owner/api/pull/99';
    const meta = makeMeta({
      pullRequests: [
        { url: URL_1, status: 'open' },
        { url: URL_2, status: 'open' },
        { url: other, status: 'open' },
      ],
    });
    const observations = [obs(1, { headRefName: 'feat/current' }), obs(2)];
    const args = {
      meta,
      observations,
      runtimeBranch: 'feat/current',
      repoFullName: 'owner/repo',
      nowSec: NOW_SEC,
    };
    const plan = planPullRequestMetaWrite(args);
    expect(plan?.pullRequests?.map((pr) => pr.url)).toEqual([URL_2, URL_1, other]);
    const updated = makeMeta({
      ...meta,
      pullRequests: plan!.pullRequests!,
      pullRequestState: plan?.pullRequestState ?? undefined,
    });
    expect(planPullRequestMetaWrite({ ...args, meta: updated })).toBeNull();
    expect(
      planAssociation({
        meta,
        observations: [],
        discovered: [obs(3, { headRefName: 'feat/current' })],
        runtimeBranch: 'feat/current',
        repoFullName: 'owner/repo',
      })?.prNumber
    ).toBe(3);
  });
});

describe('provider-versioned lifecycle', () => {
  it('does not regress a newer webhook or update a same-number PR in another repository', () => {
    const other = 'https://github.com/owner/api/pull/1';
    const write = planPullRequestLifecycle(
      { url: URL_1, status: 'closed', updatedAt: '2026-07-18T00:00:00Z' },
      undefined,
      'webhook'
    )!;
    const meta = makeMeta({
      pullRequests: [
        { url: URL_1, status: 'open' },
        { url: other, status: 'draft' },
      ],
      [write.field]: write.value,
    });
    const plan = planPullRequestMetaWrite({
      meta,
      observations: [obs(1)],
      repoFullName: 'owner/repo',
      runtimeBranch: null,
      nowSec: NOW_SEC,
    });
    expect(plan?.pullRequests).toEqual([
      { url: URL_1, status: 'closed' },
      { url: other, status: 'draft' },
    ]);
    expect(plan?.lifecycle).toEqual([]);
  });
});
