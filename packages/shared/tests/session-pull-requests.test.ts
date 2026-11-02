import { describe, expect, it } from 'vitest';
import {
  planPullRequestLifecycle,
  resolveSessionPullRequests,
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
