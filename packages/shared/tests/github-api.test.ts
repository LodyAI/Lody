import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GitHubFileTooLargeError,
  githubCreatePRReviewComment,
  githubFetchCheckRuns,
  githubFetchFileAtCommit,
  githubFetchFileBytesAtCommit,
  githubFetchIssuesAndPRs,
  githubFetchPRIssueComments,
  githubFetchPRReviewComments,
  githubFetchProjectSkillsAtCommit,
  githubFetchPullRequestDetails,
  githubFetchPullRequestCommits,
  githubCompareCommits,
  githubFetchPullRequestReviews,
  normalizeCheckRunsSummary,
} from '../src/github-api';

describe('GitHub PR live reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards reload mode to every request in a manual refresh', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pulls/42')) {
        return new Response(
          JSON.stringify({
            number: 42,
            node_id: 'PR_42',
            title: 'Fresh pull request',
            state: 'open',
            html_url: 'https://github.com/owner/repo/pull/42',
            base: { ref: 'main', sha: 'base-sha' },
            head: { ref: 'fix/refresh', sha: 'head-sha' },
            user: null,
            created_at: '2026-07-19T00:00:00.000Z',
            updated_at: '2026-07-19T00:01:00.000Z',
          })
        );
      }
      if (url.includes('/check-runs')) {
        return new Response(JSON.stringify({ check_runs: [] }));
      }
      return new Response(JSON.stringify([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const options = { cache: 'reload' as const };

    await Promise.all([
      githubFetchPullRequestDetails('token', 'owner/repo', 42, options),
      githubFetchPRReviewComments('token', 'owner/repo', 42, options),
      githubFetchPullRequestReviews('token', 'owner/repo', 42, options),
      githubFetchPRIssueComments('token', 'owner/repo', 42, options),
      githubFetchCheckRuns('token', 'owner/repo', 'head-sha', options),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([, init]) => init?.cache)).toEqual([
      'reload',
      'reload',
      'reload',
      'reload',
      'reload',
    ]);
    await expect(githubFetchPullRequestDetails('token', 'owner/repo', 42)).resolves.toMatchObject({
      baseSha: 'base-sha',
    });
  });
});

describe('GitHub PR changes reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes commits and compare files', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/commits')) {
        return new Response(
          JSON.stringify([
            {
              sha: 'head',
              html_url: 'https://github.com/o/r/commit/head',
              commit: {
                message: 'Add changes\n\nDetails',
                author: { date: '2026-09-30T00:00:00Z' },
              },
              author: { login: 'alice' },
              parents: [{ sha: 'parent' }],
            },
          ])
        );
      }
      return new Response(
        JSON.stringify({
          files: [
            {
              filename: 'src/a.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              changes: 3,
              sha: 'blob',
              blob_url: 'https://github.com/o/r/blob/head/src/a.ts',
              raw_url: 'https://github.com/o/r/raw/head/src/a.ts',
              patch: '@@ -1 +1 @@',
            },
            {
              filename: 'src/old.ts',
              status: 'deleted',
              additions: 0,
              deletions: 2,
              changes: 2,
            },
          ],
          merge_base_commit: { sha: 'parent' },
        })
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(githubFetchPullRequestCommits('token', 'o/r', 42)).resolves.toEqual([
      {
        sha: 'head',
        message: 'Add changes',
        authorLogin: 'alice',
        authoredAt: '2026-09-30T00:00:00Z',
        htmlUrl: 'https://github.com/o/r/commit/head',
        parentSha: 'parent',
      },
    ]);
    await expect(githubCompareCommits('token', 'o/r', 'parent', 'head')).resolves.toEqual({
      mergeBaseSha: 'parent',
      files: [
        {
          path: 'src/a.ts',
          previousPath: null,
          status: 'modified',
          additions: 2,
          deletions: 1,
          changes: 3,
          sha: 'blob',
          blobUrl: 'https://github.com/o/r/blob/head/src/a.ts',
          rawUrl: 'https://github.com/o/r/raw/head/src/a.ts',
          patch: '@@ -1 +1 @@',
        },
        {
          path: 'src/old.ts',
          previousPath: null,
          status: 'removed',
          additions: 0,
          deletions: 2,
          changes: 2,
          sha: null,
          blobUrl: null,
          rawUrl: null,
          patch: null,
        },
      ],
    });
  });
});

describe('githubFetchCheckRuns', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function apiRun(id: number, name: string, conclusion: string, appName = 'GitHub Actions') {
    return { id, name, status: 'completed', conclusion, app: { name: appName } };
  }

  it('judges each check by its latest attempt only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              check_runs: [
                apiRun(12, 'test', 'success'),
                apiRun(10, 'test', 'failure'),
                apiRun(11, 'lint', 'success'),
                apiRun(9, 'lint', 'failure', 'Other CI'),
              ],
            })
          )
      )
    );

    const summary = await githubFetchCheckRuns('token', 'owner/repo', 'head-sha');

    expect(summary.runs.map((run) => [run.name, run.appName, run.conclusion])).toEqual([
      ['lint', 'GitHub Actions', 'success'],
      ['lint', 'Other CI', 'failure'],
      ['test', 'GitHub Actions', 'success'],
    ]);
    expect(summary.conclusion).toBe('failure');
  });

  it('turns green once a failed check is re-run successfully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              check_runs: [apiRun(10, 'test', 'failure'), apiRun(12, 'test', 'success')],
            })
          )
      )
    );

    const summary = await githubFetchCheckRuns('token', 'owner/repo', 'head-sha');

    expect(summary.total).toBe(1);
    expect(summary.conclusion).toBe('success');
  });

  it('does not let a cancelled check turn an otherwise green commit into a failure', async () => {
    const summarize = async (runs: ReturnType<typeof apiRun>[]) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ check_runs: runs })))
      );
      return (await githubFetchCheckRuns('token', 'owner/repo', 'head-sha')).conclusion;
    };

    expect(await summarize([apiRun(1, 'test', 'success'), apiRun(2, 'deploy', 'cancelled')])).toBe(
      'success'
    );
    expect(await summarize([apiRun(1, 'test', 'failure'), apiRun(2, 'deploy', 'cancelled')])).toBe(
      'failure'
    );
    expect(await summarize([apiRun(2, 'deploy', 'cancelled')])).toBe('cancelled');
  });

  it('re-derives summaries persisted with superseded attempts', () => {
    const run = (id: number, conclusion: 'success' | 'failure') => ({
      id,
      name: 'test',
      status: 'completed' as const,
      conclusion,
      htmlUrl: null,
      startedAt: null,
      completedAt: null,
      appName: 'GitHub Actions',
    });

    const summary = normalizeCheckRunsSummary({
      status: 'completed',
      conclusion: 'failure',
      total: 2,
      runs: [run(10, 'failure'), run(12, 'success')],
    });

    expect(summary.runs.map((item) => item.id)).toEqual([12]);
    expect(summary.conclusion).toBe('success');
  });
});

describe('githubCreatePRReviewComment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a line-anchored body that matches GitHub's line schema", async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // GitHub rejects `subject_type` alongside `line` with a 422.
        if ('subject_type' in sentBody && 'line' in sentBody) {
          return new Response(JSON.stringify({ message: 'Invalid request.' }), { status: 422 });
        }
        return new Response(
          JSON.stringify({
            id: 7,
            node_id: 'PRRC_7',
            body: sentBody.body,
            path: sentBody.path,
            commit_id: sentBody.commit_id,
            user: null,
            author_association: 'OWNER',
            created_at: '2026-09-21T00:00:00.000Z',
            updated_at: '2026-09-21T00:00:00.000Z',
            html_url: 'https://github.com/owner/repo/pull/42#discussion_r7',
            line: sentBody.line,
            side: sentBody.side,
          }),
          { status: 201 }
        );
      })
    );

    const comment = await githubCreatePRReviewComment('token', 'owner/repo', 42, {
      body: 'Looks off',
      path: 'src/a.ts',
      commitId: 'head-sha',
      line: 12,
      side: 'RIGHT',
    });

    expect(sentBody).toEqual({
      body: 'Looks off',
      commit_id: 'head-sha',
      path: 'src/a.ts',
      line: 12,
      side: 'RIGHT',
    });
    expect(comment).toMatchObject({ id: 7, path: 'src/a.ts', line: 12, subjectType: 'line' });
  });
});

describe('githubFetchFileAtCommit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects API file bodies larger than the byte cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { headers: { 'content-length': '5' } }))
    );

    await expect(
      githubFetchFileAtCommit('token', 'owner/repo', 'src/app.ts', 'commit-sha', {
        maxBytes: 4,
      })
    ).rejects.toBeInstanceOf(GitHubFileTooLargeError);
  });

  it('applies the byte cap to raw fallback responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('too large', { status: 403 }))
      .mockResolvedValueOnce(new Response('hello', { headers: { 'content-length': '5' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      githubFetchFileAtCommit('token', 'owner/repo', 'src/app.ts', 'commit-sha', {
        maxBytes: 4,
      })
    ).rejects.toBeInstanceOf(GitHubFileTooLargeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('githubFetchFileBytesAtCommit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns raw bytes intact (no UTF-8 decoding)', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
      )
    );

    const result = await githubFetchFileBytesAtCommit(
      'token',
      'owner/repo',
      'assets/logo.png',
      'commit-sha',
      { maxBytes: 16 }
    );
    expect(Array.from(result)).toEqual(Array.from(bytes));
  });

  it('rejects binary bodies larger than the byte cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(8), { headers: { 'content-length': '8' } }))
    );

    await expect(
      githubFetchFileBytesAtCommit('token', 'owner/repo', 'assets/logo.png', 'commit-sha', {
        maxBytes: 4,
      })
    ).rejects.toBeInstanceOf(GitHubFileTooLargeError);
  });
});

describe('githubFetchProjectSkillsAtCommit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('groups skills by requested directory while following in-repo symlink directories', async () => {
    const skillMarkdown = `---
name: Review Bot
description: Checks diffs
---
# Review
`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/git/trees/commit-sha?recursive=1')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: '.agents/skills', type: 'tree', sha: 'tree-agents' },
              { path: '.agents/skills/review', type: 'tree', sha: 'tree-review' },
              {
                path: '.agents/skills/review/SKILL.md',
                type: 'blob',
                sha: 'skill-md',
                mode: '100644',
              },
              { path: '.claude/skills', type: 'blob', sha: 'symlink-1', mode: '120000' },
            ],
          })
        );
      }
      if (url.includes('/git/blobs/symlink-1')) {
        return new Response(
          JSON.stringify({
            content: btoa('../.agents/skills'),
            encoding: 'base64',
            size: '../.agents/skills'.length,
          })
        );
      }
      if (url.includes('/contents/.agents/skills/review/SKILL.md')) {
        return new Response(skillMarkdown);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await githubFetchProjectSkillsAtCommit('token', 'owner/repo', 'commit-sha', [
      '.agents/skills',
      '.claude/skills',
    ]);

    expect(result.groups).toEqual([
      {
        scope: 'project',
        dir: '.agents/skills',
        skills: [
          {
            id: '.agents/skills/review',
            name: 'Review Bot',
            description: 'Checks diffs',
            relativePath: '.agents/skills/review/SKILL.md',
            isSymlink: false,
            content: '# Review',
          },
        ],
        truncated: false,
      },
      {
        scope: 'project',
        dir: '.claude/skills',
        skills: [
          {
            id: '.claude/skills/review',
            name: 'Review Bot',
            description: 'Checks diffs',
            relativePath: '.claude/skills/review/SKILL.md',
            isSymlink: true,
            symlinkTarget: '.agents/skills/review',
            content: '# Review',
          },
        ],
        truncated: false,
      },
    ]);
    expect(result.contentFingerprint).toBe('commit-sha');
    expect(result.treeTruncated).toBe(false);
  });
});

describe('githubFetchIssuesAndPRs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function issuesPageResponse(numbers: number[]) {
    return new Response(
      JSON.stringify(
        numbers.map((number) => ({
          number,
          html_url: `https://github.com/owner/repo/issues/${number}`,
          title: `Issue ${number}`,
          state: 'open',
          updated_at: `2026-07-${String(number).padStart(2, '0')}T00:00:00.000Z`,
        }))
      )
    );
  }

  it('requests both pages concurrently', async () => {
    const startedPages: number[] = [];
    let bothStarted = () => {};
    // Neither request may settle until both have started, so the call can only
    // finish if the two pages really are in flight together.
    const gate = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      startedPages.push(page);
      if (startedPages.length === 2) bothStarted();
      await gate;
      return issuesPageResponse(page === 1 ? [3, 2] : [1]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const items = await githubFetchIssuesAndPRs('token', 'owner/repo');

    expect([...startedPages].sort()).toEqual([1, 2]);
    expect(items.map((item) => item.number)).toEqual([3, 2, 1]);
  });

  it('dedupes across pages and keeps the most recently updated copy', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      if (page === 1) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              html_url: 'https://github.com/owner/repo/issues/7',
              title: 'Stale copy',
              state: 'open',
              updated_at: '2026-07-01T00:00:00.000Z',
            },
          ])
        );
      }
      return new Response(
        JSON.stringify([
          {
            number: 7,
            html_url: 'https://github.com/owner/repo/issues/7',
            title: 'Fresh copy',
            state: 'open',
            updated_at: '2026-07-09T00:00:00.000Z',
          },
          {
            number: 8,
            html_url: 'https://github.com/owner/repo/pull/8',
            title: 'A pull request',
            state: 'open',
            updated_at: '2026-07-02T00:00:00.000Z',
            pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/8' },
          },
        ])
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const items = await githubFetchIssuesAndPRs('token', 'owner/repo');

    expect(items).toEqual([
      expect.objectContaining({ number: 7, title: 'Fresh copy', type: 'issue' }),
      expect.objectContaining({ number: 8, type: 'pr' }),
    ]);
  });
});
