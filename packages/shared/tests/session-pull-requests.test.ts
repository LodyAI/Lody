import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/schema';
import {
  planPullRequestLifecycle,
  resolveSessionPrimaryPullRequest,
  resolveSessionPullRequests,
  resolveSessionPullRequestViews,
  selectPrimarySessionPullRequest,
  type SessionPullRequestSource,
} from '../src/session-pull-requests';

const url = 'https://github.com/example/repo/pull/42';
const other = 'https://github.com/example/other/pull/42';
const original: SessionPullRequestSource = {
  pullRequests: [
    { url, status: 'draft' },
    { url: other, status: 'open' },
  ],
};
function observation(
  status: 'open' | 'closed' | 'merged',
  updatedAt: string,
  source: 'machine' | 'webhook'
) {
  const write = planPullRequestLifecycle({ url, status, updatedAt }, undefined, source)!;
  return { [write.field]: write.value };
}

describe('session PR membership and lifecycle projection', () => {
  it('preserves legacy membership and applies the newest provider revision across sources', () => {
    expect(resolveSessionPullRequests(original)).toEqual(original.pullRequests);
    const meta = {
      ...original,
      ...observation('closed', '2026-01-02T00:00:00Z', 'webhook'),
      ...observation('open', '2026-01-03T00:00:00Z', 'machine'),
    };
    expect(resolveSessionPullRequests(meta)).toEqual([
      { url, status: 'open' },
      original.pullRequests![1],
    ]);
    expect(original.pullRequests![0].status).toBe('draft');
  });

  it('resolves repository casing and URL suffixes but never conflates repository identities', () => {
    const write = planPullRequestLifecycle(
      {
        url: 'https://github.com/EXAMPLE/REPO/pull/42/files',
        status: 'merged',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      undefined,
      'webhook'
    )!;
    expect(resolveSessionPullRequests({ ...original, [write.field]: write.value })).toEqual([
      { url, status: 'merged' },
      original.pullRequests![1],
    ]);
  });

  it('ignores orphan observations and retains deletion after late updates', () => {
    const fields = observation('merged', '2026-01-01T00:00:00Z', 'webhook');
    expect(resolveSessionPullRequests(fields)).toEqual([]);
    expect(resolveSessionPullRequests({ ...fields, pullRequests: [] })).toEqual([]);
  });

  it('resolves ambiguous equal revisions deterministically and allows later reopen', () => {
    const fields = {
      ...observation('closed', '2026-01-01T00:00:00Z', 'webhook'),
      ...observation('open', '2026-01-01T00:00:00Z', 'machine'),
    };
    expect(resolveSessionPullRequests({ ...original, ...fields })[0]?.status).toBe('open');
    expect(
      planPullRequestLifecycle({ url, status: 'open', updatedAt: '2026-01-01T00:00:00Z' }, fields)
    ).toBeNull();
    const next = planPullRequestLifecycle(
      { url, status: 'open', updatedAt: '2026-01-02T00:00:00Z' },
      fields
    )!;
    expect(
      resolveSessionPullRequests({ ...original, ...fields, [next.field]: next.value })[0]?.status
    ).toBe('open');
  });

  it('rejects invalid revisions and keeps register values below 50 bytes', () => {
    expect(planPullRequestLifecycle({ url, status: 'open', updatedAt: 'invalid' })).toBeNull();
    expect(
      planPullRequestLifecycle({
        url: 'https://example.com/pull/42',
        status: 'open',
        updatedAt: '2026-01-01',
      })
    ).toBeNull();
    const write = planPullRequestLifecycle({
      url,
      status: 'merged',
      updatedAt: '2026-01-01T00:00:00Z',
    })!;
    expect(new TextEncoder().encode(JSON.stringify(write.value)).byteLength).toBeLessThan(50);
  });
});

describe('session PR views', () => {
  const api = 'https://github.com/example/api/pull/7';
  const web = 'https://github.com/example/web/pull/9';
  const apiLater = 'https://github.com/example/api/pull/8';

  it('resolves status, CI, merge readiness and per-repository currency for every PR', () => {
    const write = planPullRequestLifecycle(
      { url: api, status: 'merged', updatedAt: '2026-01-02T00:00:00Z' },
      undefined,
      'webhook'
    )!;
    const views = resolveSessionPullRequestViews({
      pullRequests: [
        { url: api, status: 'open' },
        { url: web, status: 'draft' },
        { url: apiLater, status: 'open' },
      ],
      [write.field]: write.value,
      pullRequestState: { [web]: { s: 'f', m: 'u', t: 1 }, [apiLater]: { s: 's', m: 'c', t: 1 } },
    });
    expect(views.map(({ pr: _pr, state: _state, ...summary }) => summary)).toEqual([
      {
        url: api,
        repoFullName: 'example/api',
        number: 7,
        status: 'merged',
        ci: null,
        merge: null,
        readiness: null,
        current: false,
      },
      {
        url: web,
        repoFullName: 'example/web',
        number: 9,
        status: 'draft',
        ci: 'f',
        merge: 'u',
        readiness: null,
        current: true,
      },
      {
        url: apiLater,
        repoFullName: 'example/api',
        number: 8,
        status: 'open',
        ci: 's',
        merge: 'c',
        readiness: 'y',
        current: true,
      },
    ]);
  });

  it('identifies each PR by its URL even when legacy fields disagree', () => {
    const views = resolveSessionPullRequestViews({
      pullRequests: [
        { url: api, status: 'open', repository: 'example/web', number: 99 },
      ] as SessionMeta['pullRequests'],
    });
    expect([views[0]?.repoFullName, views[0]?.number, views[0]?.current]).toEqual([
      'example/api',
      7,
      true,
    ]);
    expect(selectPrimarySessionPullRequest(views, 'example/api')?.url).toBe(api);
    expect(selectPrimarySessionPullRequest(views, 'example/web')).toBeNull();
  });

  it('keeps legacy reportedAt ordering when choosing the primary PR', () => {
    const views = resolveSessionPullRequestViews({
      pullRequests: [
        { url: api, status: 'open', reportedAt: '2026-01-03T00:00:00Z' },
        { url: web, status: 'open', reportedAt: '2026-01-01T00:00:00Z' },
      ] as SessionMeta['pullRequests'],
    });
    expect(selectPrimarySessionPullRequest(views)?.url).toBe(api);
    expect(selectPrimarySessionPullRequest(views, 'EXAMPLE/web')?.url).toBe(web);
    expect(selectPrimarySessionPullRequest(views, null)).toBeNull();
  });

  it("describes a Project group by its legacy repository's PR, not the last PR overall", () => {
    const meta = {
      project: { kind: 'github', repoFullName: 'example/api' },
      projectRun: { name: 'group', members: {} },
      pullRequests: [
        { url: api, status: 'open' },
        { url: web, status: 'open' },
      ],
    } as unknown as SessionMeta;
    expect(resolveSessionPrimaryPullRequest(meta)?.url).toBe(api);
    expect(resolveSessionPrimaryPullRequest(meta, 'example/web')?.url).toBe(web);
    expect(resolveSessionPrimaryPullRequest(meta, null)).toBeNull();
    expect(resolveSessionPrimaryPullRequest({ ...meta, projectRun: undefined })?.url).toBe(web);
  });
});
