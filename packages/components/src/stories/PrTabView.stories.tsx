import type { Meta, StoryObj } from '@storybook/react';
import type {
  GitHubCheckRun,
  GitHubIssueComment,
  GitHubPullRequestDetails,
  GitHubReview,
  GitHubReviewComment,
  GitHubReviewThread,
  GitHubUser,
} from '@lody/shared';
import { PrTabView, type PrTabViewData } from '@/components/sessions/pr-tab-view';

const alice: GitHubUser = {
  login: 'alice',
  id: 1,
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  htmlUrl: 'https://github.com/alice',
};
const bob: GitHubUser = {
  login: 'bob',
  id: 2,
  avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
  htmlUrl: 'https://github.com/bob',
};

const basePr: GitHubPullRequestDetails = {
  number: 42,
  nodeId: 'PR_kwDO_storybook',
  title: 'Add PR tab to the session viewer',
  body:
    'This PR wires up a new in-app PR tab that fetches PR metadata, review threads, ' +
    'issue comments, and CI status from the GitHub API.\n\n' +
    '### Highlights\n\n' +
    '- Pure view + container split for Storybook-friendliness\n' +
    '- Review threads can jump back to the diff viewer\n' +
    '- Inline comment composer posts directly to GitHub',
  state: 'open',
  merged: false,
  draft: false,
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42',
  baseRef: 'main',
  headRef: 'feat/pr-tab-for-github-worktree',
  headSha: 'deadbeefcafef00d',
  user: alice,
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  updatedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
  mergedAt: null,
  closedAt: null,
  additions: 524,
  deletions: 38,
  changedFiles: 9,
  commits: 4,
  mergeable: true,
  mergeableState: 'clean',
};

const reviewComment = (overrides: Partial<GitHubReviewComment>): GitHubReviewComment => ({
  id: Math.random() * 1e9,
  nodeId: 'RC_1',
  pullRequestReviewId: null,
  body: 'Looks good.',
  path: 'packages/components/src/components/sessions/pr-tab-view.tsx',
  commitId: 'deadbeefcafef00d',
  originalCommitId: 'deadbeefcafef00d',
  diffHunk: '',
  subjectType: 'line',
  user: bob,
  authorAssociation: 'MEMBER',
  createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
  updatedAt: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42#discussion_r1',
  line: 128,
  originalLine: 128,
  side: 'RIGHT',
  startLine: null,
  originalStartLine: null,
  startSide: null,
  ...overrides,
});

const threadOne: GitHubReviewThread = {
  id: 101,
  anchor: {
    path: 'packages/components/src/components/sessions/pr-tab-view.tsx',
    line: 128,
    side: 'RIGHT',
    startLine: null,
    startSide: null,
  },
  comments: [
    reviewComment({
      id: 1,
      pullRequestReviewId: 301,
      body: 'Consider wrapping this in `memo()` — we re-render every time the composer state updates.',
    }),
    reviewComment({
      id: 2,
      pullRequestReviewId: 301,
      user: alice,
      body: 'Good call — just pushed a fix.',
      createdAt: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
    }),
  ],
  outdated: false,
  diffHunk: '',
  subjectType: 'line',
};

const threadTwo: GitHubReviewThread = {
  id: 102,
  anchor: {
    path: 'packages/shared/src/github-api.ts',
    line: 712,
    side: 'RIGHT',
    startLine: null,
    startSide: null,
  },
  comments: [
    reviewComment({
      id: 3,
      pullRequestReviewId: 302,
      user: alice,
      body: 'What happens when the commit ref has been force-pushed past? Should we surface a fallback here?',
      path: 'packages/shared/src/github-api.ts',
      line: 712,
    }),
  ],
  outdated: true,
  diffHunk: '',
  subjectType: 'line',
};

const issueCommentOne: GitHubIssueComment = {
  id: 201,
  nodeId: 'IC_1',
  body: 'Nice work — one thought: can we add analytics when the PR tab opens?',
  user: bob,
  authorAssociation: 'MEMBER',
  createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  updatedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42#issuecomment-201',
  issueUrl: 'https://github.com/loro-dev/lody/issues/42',
};

const issueCommentTwo: GitHubIssueComment = {
  id: 202,
  nodeId: 'IC_2',
  body: 'Just added a posthog event for this.',
  user: alice,
  authorAssociation: 'MEMBER',
  createdAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
  updatedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42#issuecomment-202',
  issueUrl: 'https://github.com/loro-dev/lody/issues/42',
};

const reviewApproved: GitHubReview = {
  id: 301,
  nodeId: 'PRR_1',
  body: 'LGTM — nice cleanup of the cache layer. Ship it!',
  state: 'approved',
  user: bob,
  authorAssociation: 'MEMBER',
  commitId: 'deadbeefcafef00d',
  submittedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42#pullrequestreview-301',
};

const reviewChangesRequested: GitHubReview = {
  id: 302,
  nodeId: 'PRR_2',
  body: 'Overall direction looks great, but we need to address the feedback on the review fetcher before landing.',
  state: 'changes_requested',
  user: alice,
  authorAssociation: 'MEMBER',
  commitId: 'deadbeefcafef00d',
  submittedAt: new Date(Date.now() - 1000 * 60 * 50).toISOString(),
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42#pullrequestreview-302',
};

function makeCheckRun(overrides: Partial<GitHubCheckRun>): GitHubCheckRun {
  return {
    id: Math.random() * 1e9,
    name: 'check',
    status: 'completed',
    conclusion: 'success',
    htmlUrl: null,
    startedAt: null,
    completedAt: null,
    appName: 'GitHub Actions',
    ...overrides,
  };
}

const passingChecks = {
  status: 'completed' as const,
  conclusion: 'success' as const,
  total: 3,
  runs: [
    makeCheckRun({ id: 1, name: 'build' }),
    makeCheckRun({ id: 2, name: 'lint' }),
    makeCheckRun({ id: 3, name: 'test' }),
  ],
};

const runningChecks = {
  status: 'in_progress' as const,
  conclusion: null,
  total: 3,
  runs: [
    makeCheckRun({ id: 1, name: 'build', status: 'completed', conclusion: 'success' }),
    makeCheckRun({ id: 2, name: 'lint', status: 'in_progress', conclusion: null }),
    makeCheckRun({ id: 3, name: 'test', status: 'queued', conclusion: null }),
  ],
};

const failingChecks = {
  status: 'completed' as const,
  conclusion: 'failure' as const,
  total: 4,
  runs: [
    makeCheckRun({ id: 1, name: 'build', conclusion: 'success' }),
    makeCheckRun({
      id: 2,
      name: 'lint',
      conclusion: 'failure',
      htmlUrl: 'https://github.com/loro-dev/lody/actions/runs/1/job/lint',
    }),
    makeCheckRun({
      id: 3,
      name: 'typecheck',
      conclusion: 'failure',
      htmlUrl: 'https://github.com/loro-dev/lody/actions/runs/1/job/typecheck',
    }),
    makeCheckRun({ id: 4, name: 'test', conclusion: 'success' }),
  ],
};

const baseData: PrTabViewData = {
  pullRequest: basePr,
  reviewThreads: [threadOne, threadTwo],
  reviews: [reviewApproved, reviewChangesRequested],
  issueComments: [issueCommentOne, issueCommentTwo],
  checkRuns: passingChecks,
};

const storyCallbacks = {
  onRefresh: () => {
    /* no-op in stories */
  },
  onPostComment: async (body: string) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    // eslint-disable-next-line no-console
    console.log('[story] posted comment:', body);
  },
  onGrantChecksPermission: () => {
    // eslint-disable-next-line no-console
    console.log('[story] open GitHub app install page');
  },
  onSelectMergeMethod: (method: 'merge' | 'squash' | 'rebase') => {
    // eslint-disable-next-line no-console
    console.log('[story] selected merge method', method);
  },
  onMerge: async (method: 'merge' | 'squash' | 'rebase') => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    // eslint-disable-next-line no-console
    console.log('[story] merge clicked', method);
  },
  onSetState: async (nextState: 'open' | 'closed') => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    // eslint-disable-next-line no-console
    console.log('[story] set state', nextState);
  },
  onMarkReadyForReview: async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    // eslint-disable-next-line no-console
    console.log('[story] mark ready for review');
  },
  mergeMethod: 'merge' as const,
};

const meta = {
  title: 'Sessions/PrTabView',
  component: PrTabView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="h-screen w-full bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PrTabView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OpenCiPassed: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    ...storyCallbacks,
  },
};

export const OpenCiRunning: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: { ...baseData, checkRuns: runningChecks },
    ...storyCallbacks,
  },
};

export const OpenCiFailed: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: { ...baseData, checkRuns: failingChecks },
    ...storyCallbacks,
  },
};

export const Merged: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: {
        ...basePr,
        state: 'closed',
        merged: true,
        mergedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        closedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      },
    },
    ...storyCallbacks,
  },
};

export const Closed: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: {
        ...basePr,
        state: 'closed',
        merged: false,
        closedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
      },
      checkRuns: { status: 'none', conclusion: null, total: 0, runs: [] },
    },
    ...storyCallbacks,
  },
};

export const LongBody: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: {
        ...basePr,
        body: [
          '## Summary',
          'Wire the PR badge into a new in-app **PR tab** so reviewers never leave the app.',
          '### Fetches',
          '- Title / body / branches',
          '- Review threads (reuse existing component)',
          '- Issue comments',
          '- `check-runs` summary',
          '```ts',
          "const result = await githubFetchPullRequestDetails(token, 'loro-dev/lody', 42);",
          '```',
          '> Reviewers can click a review thread to open the corresponding line in the diff viewer.',
        ].join('\n'),
      },
    },
    ...storyCallbacks,
  },
};

export const Loading: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'loading',
    data: null,
    ...storyCallbacks,
  },
};

export const ErrorState: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'error',
    data: null,
    error: 'GitHub returned 404. The PR may have been deleted.',
    ...storyCallbacks,
  },
};

export const ChecksPermissionMissing: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: { ...baseData, checkRuns: { status: 'none', conclusion: null, total: 0, runs: [] } },
    checksPermissionError: true,
    ...storyCallbacks,
  },
};

export const MergeConflict: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: { ...basePr, mergeable: false, mergeableState: 'dirty' },
    },
    ...storyCallbacks,
  },
};

export const MergeChecking: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: { ...basePr, mergeable: null, mergeableState: 'unknown' },
    },
    ...storyCallbacks,
  },
};

export const MergeBlocked: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: { ...basePr, mergeable: true, mergeableState: 'blocked' },
    },
    ...storyCallbacks,
  },
};

export const Draft: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: { ...basePr, draft: true, mergeableState: 'draft' },
    },
    ...storyCallbacks,
  },
};

export const DraftMarkingReady: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: { ...basePr, draft: true, mergeableState: 'draft' },
    },
    isMarkingReady: true,
    ...storyCallbacks,
  },
};

export const Merging: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    isMerging: true,
    ...storyCallbacks,
  },
};

// -------------------------------------------------------------------------
// Merge methods — default button label reflects the selected method
// -------------------------------------------------------------------------

export const MergeMethodMerge: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    ...storyCallbacks,
    mergeMethod: 'merge',
  },
};

export const MergeMethodSquash: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    ...storyCallbacks,
    mergeMethod: 'squash',
  },
};

export const MergeMethodRebase: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    ...storyCallbacks,
    mergeMethod: 'rebase',
  },
};

// -------------------------------------------------------------------------
// Conversation content variants
// -------------------------------------------------------------------------

export const NoComments: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      reviewThreads: [],
      reviews: [],
      issueComments: [],
    },
    ...storyCallbacks,
  },
};

export const OnlyIssueComments: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      reviewThreads: [],
      reviews: [],
      issueComments: [issueCommentOne, issueCommentTwo],
    },
    ...storyCallbacks,
  },
};

export const OnlyReviewThreads: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      reviewThreads: [threadOne, threadTwo],
      reviews: [],
      issueComments: [],
    },
    ...storyCallbacks,
  },
};

export const WithReviewSubmissions: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      reviewThreads: [],
      reviews: [reviewApproved, reviewChangesRequested],
      issueComments: [],
    },
    ...storyCallbacks,
  },
};

export const OutdatedReviewThread: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      reviewThreads: [{ ...threadOne, outdated: true }],
      reviews: [],
      issueComments: [],
    },
    ...storyCallbacks,
  },
};

// -------------------------------------------------------------------------
// Body & metadata variants
// -------------------------------------------------------------------------

export const NoBody: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: { ...baseData, pullRequest: { ...basePr, body: '' } },
    ...storyCallbacks,
  },
};

export const VeryLongTitle: Story = {
  args: {
    repoFullName: 'loro-dev/very-long-org-name-that-will-wrap',
    prNumber: 4242,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: {
        ...basePr,
        number: 4242,
        title:
          'refactor(components, shared, cli): overhaul the pull-request tab UX with a split merge button, inline permission banner, comment avatars, and a full-screen mobile drawer that deep-links via ?pr=<number>',
      },
    },
    ...storyCallbacks,
  },
};

export const GhostAuthor: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: {
      ...baseData,
      pullRequest: { ...basePr, user: null },
      issueComments: [{ ...issueCommentOne, user: null }],
    },
    ...storyCallbacks,
  },
};

// -------------------------------------------------------------------------
// Interaction / transient states
// -------------------------------------------------------------------------

export const Refreshing: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    isRefreshing: true,
    ...storyCallbacks,
  },
};

export const PostingComment: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    isPostingComment: true,
    ...storyCallbacks,
  },
};

// -------------------------------------------------------------------------
// Mobile full-screen drawer dressing (leadingSlot + narrow viewport)
// -------------------------------------------------------------------------

export const MobileWithBackButton: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
    ...storyCallbacks,
    leadingSlot: (
      <button
        type="button"
        className="-ml-1 inline-flex h-7 w-7 items-center justify-center rounded-sm hover:bg-muted"
        aria-label="Back"
      >
        <span aria-hidden>←</span>
      </button>
    ),
  },
  decorators: [
    (Story) => (
      <div
        className="mx-auto h-screen w-[390px] border border-border bg-background shadow-lg"
        style={{ maxWidth: '100vw' }}
      >
        <Story />
      </div>
    ),
  ],
};

// -------------------------------------------------------------------------
// Read-only (no callbacks) — useful to confirm the view still renders when
// the parent hasn't wired any action handlers yet.
// -------------------------------------------------------------------------

export const ReadOnly: Story = {
  args: {
    repoFullName: 'loro-dev/lody',
    prNumber: 42,
    state: 'ready',
    data: baseData,
  },
};
