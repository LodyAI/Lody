import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/schema';
import {
  planPullRequestLifecycle,
  resolveSessionPrimaryPullRequest,
  resolveSessionPullRequestHistory,
  resolveSessionPullRequests,
  resolveSessionPullRequestViews,
  selectPrimarySessionPullRequest,
  resolveSessionPullRequestLinkList,
  type SessionPullRequestSource,
} from '../src/session-pull-requests';
import {
  MAX_SESSION_PULL_REQUEST_LINKS,
  planPullRequestLinkCheck,
  planSessionPullRequestLink,
  planSessionPullRequestUnlink,
  readSessionPullRequestLinks,
} from '../src/session-pull-request-links';
import { parsePullRequestUrl } from '../src/pull-request-url';

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
    // A single-project Session keeps its primary slot in the project repository.
    expect(resolveSessionPrimaryPullRequest({ ...meta, projectRun: undefined })?.url).toBe(api);
    expect(
      resolveSessionPrimaryPullRequest({ ...meta, projectRun: undefined, project: undefined })?.url
    ).toBe(web);
  });

  it('keeps every earlier PR in the history after a newer one becomes primary', () => {
    const first = 'https://github.com/example/api/pull/1';
    const second = 'https://github.com/example/api/pull/2';
    const third = 'https://github.com/example/api/pull/3';
    const meta = {
      pullRequests: [
        { url: first, status: 'merged' },
        { url: second, status: 'closed' },
        { url: third, status: 'open' },
      ],
    } as SessionMeta;
    const history = resolveSessionPullRequestHistory(meta);
    expect(history.map((view) => view.url)).toEqual([third, second, first]);
    expect(history[0]?.url).toBe(resolveSessionPrimaryPullRequest(meta)?.url);
    expect(history.map((view) => view.status)).toEqual(['open', 'closed', 'merged']);
  });

  it('scopes the history to the repository the surface describes', () => {
    const olderApi = 'https://github.com/example/api/pull/7';
    const meta = {
      project: { kind: 'github', repoFullName: 'example/api' },
      projectRun: { name: 'group', members: {} },
      pullRequests: [
        { url: olderApi, status: 'merged' },
        { url: api, status: 'open' },
        { url: web, status: 'open' },
      ],
    } as unknown as SessionMeta;
    expect(resolveSessionPullRequestHistory(meta).map((view) => view.url)).toEqual([api, olderApi]);
    expect(resolveSessionPullRequestHistory(meta, 'example/web').map((view) => view.url)).toEqual([
      web,
    ]);
    expect(resolveSessionPullRequestHistory(meta, null)).toEqual([]);
    expect(resolveSessionPullRequestHistory({})).toEqual([]);
  });
});

describe('explicit session PR links', () => {
  const api = 'https://github.com/example/api/pull/3019';
  const branchPr = 'https://github.com/example/api/pull/12';
  const web = 'https://github.com/example/web/pull/5';
  const apply = (
    meta: Record<string, unknown>,
    plan: ReturnType<typeof planSessionPullRequestLink>
  ) => {
    if (!plan.ok) throw new Error(plan.reason);
    return { ...meta, [plan.field]: plan.value };
  };

  it('identifies a pull request URL through the provider registry', () => {
    expect(parsePullRequestUrl('https://github.com/Example/API/pull/3019/files?x=1')).toEqual({
      provider: 'github',
      host: 'github.com',
      repoFullName: 'Example/API',
      number: 3019,
      canonicalUrl: 'https://github.com/Example/API/pull/3019',
      key: 'https://github.com/example/api/pull/3019',
    });
    expect(parsePullRequestUrl('https://gitlab.com/example/api/-/merge_requests/1')).toBeNull();
    expect(parsePullRequestUrl('not a url')).toBeNull();
  });

  it('hides an unlinked association from every reader and lets a later link win', () => {
    const meta = {
      pullRequests: [
        { url: branchPr, status: 'open' },
        { url: api, status: 'open' },
      ],
    } as Record<string, unknown>;
    const unlinked = apply(
      meta,
      planSessionPullRequestUnlink(meta, 'https://github.com/EXAMPLE/API/pull/3019', 1_000)
    );
    expect(
      resolveSessionPullRequests(unlinked as SessionPullRequestSource).map((pr) => pr.url)
    ).toEqual([branchPr]);
    const relinked = apply(unlinked, planSessionPullRequestLink(unlinked, api, 'user', 2_000));
    expect(
      resolveSessionPullRequests(relinked as SessionPullRequestSource).map((pr) => pr.url)
    ).toEqual([branchPr, api]);
    expect(readSessionPullRequestLinks(relinked)).toEqual([
      expect.objectContaining({ key: api, state: 'linked', source: 'user', at: 2_000 }),
    ]);
  });

  it('refuses unsupported URLs and a record beyond the per-Session bound', () => {
    expect(
      planSessionPullRequestLink({}, 'https://gitlab.com/a/b/-/merge_requests/1', 'user', 1)
    ).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    let meta: Record<string, unknown> = {};
    for (let index = 1; index <= MAX_SESSION_PULL_REQUEST_LINKS; index += 1)
      meta = apply(
        meta,
        planSessionPullRequestLink(
          meta,
          `https://github.com/example/api/pull/${index}`,
          'agent',
          index
        )
      );
    expect(
      planSessionPullRequestLink(meta, 'https://github.com/example/api/pull/999', 'user', 99)
    ).toEqual({
      ok: false,
      reason: 'limit',
    });
    // Rewriting an existing record never needs a new slot.
    expect(planSessionPullRequestUnlink(meta, 'https://github.com/example/api/pull/1', 99).ok).toBe(
      true
    );
  });

  it('lists associated, pending, unreadable and unsupported records with the primary first', () => {
    let meta: Record<string, unknown> = {
      project: { kind: 'github', repoFullName: 'example/api' },
      pullRequests: [
        { url: branchPr, status: 'merged' },
        { url: api, status: 'open' },
        { url: web, status: 'open' },
      ],
      pullRequestState: { [api]: { s: 'f', t: 1 } },
    };
    meta = apply(meta, planSessionPullRequestLink(meta, api, 'shim', 1_000));
    meta = apply(meta, planSessionPullRequestLink(meta, web, 'user', 1_000));
    meta = apply(
      meta,
      planSessionPullRequestLink(meta, 'https://github.com/example/api/pull/77', 'user', 2_000)
    );
    meta = apply(
      meta,
      planSessionPullRequestLink(meta, 'https://github.com/example/api/pull/78', 'user', 2_000)
    );
    const check = planPullRequestLinkCheck(meta, 'https://github.com/example/api/pull/78', 3_000)!;
    meta = {
      ...meta,
      [check.field]: check.value,
      'prLink:https://gitlab.com/a/b/-/merge_requests/1': { k: 'l', o: 'u', t: 5 },
    };
    const list = resolveSessionPullRequestLinkList(meta as SessionMeta);
    expect(
      list.map((item) => [
        item.kind,
        item.url,
        item.kind === 'associated' ? item.primary : item.reason,
      ])
    ).toEqual([
      ['associated', api, true],
      ['associated', web, false],
      ['associated', branchPr, false],
      ['pending', 'https://gitlab.com/a/b/-/merge_requests/1', 'unsupported'],
      ['pending', 'https://github.com/example/api/pull/77', 'checking'],
      ['pending', 'https://github.com/example/api/pull/78', 'unreadable'],
    ]);
    const first = list[0]!;
    expect(first.kind === 'associated' && first.view.ci).toBe('f');
    // A re-link after an unreadable check is pending again.
    meta = apply(
      meta,
      planSessionPullRequestLink(meta, 'https://github.com/example/api/pull/78', 'user', 4_000)
    );
    expect(resolveSessionPullRequestLinkList(meta as SessionMeta).at(-1)).toMatchObject({
      reason: 'checking',
    });
    // A check is recorded once per link generation; unlinked or unknown URLs get none.
    expect(
      planPullRequestLinkCheck(meta, 'https://github.com/example/api/pull/78', 4_500)
    ).not.toBeNull();
    const again = planPullRequestLinkCheck(meta, 'https://github.com/example/api/pull/77', 3_000)!;
    meta = { ...meta, [again.field]: again.value };
    expect(
      planPullRequestLinkCheck(meta, 'https://github.com/example/api/pull/77', 3_500)
    ).toBeNull();
    expect(
      planPullRequestLinkCheck(meta, 'https://github.com/example/api/pull/404', 3_500)
    ).toBeNull();
  });
});
