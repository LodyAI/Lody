// Read projection aligned with Lody OSS session-comment-types.ts. No runtime
// imports from @lody/shared: its root is not safe for browser bundles.
export type PullRequestCheck = {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | 'skipped'
    | null;
  htmlUrl: string | null;
  appName: string | null;
};

export type PullRequestPreviewData = {
  state: 'open' | 'closed' | 'merged' | 'draft';
  author: string;
  repository: string;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  checks: PullRequestCheck[];
  checksError?: string;
  checksTruncated?: boolean;
  comments: { id: number; author: string; body: string; url: string }[];
  commentsError?: string;
  commentsTruncated?: boolean;
};

export type PullRequestReference = {
  url: string;
  repository: string;
  number: number;
  status: PullRequestPreviewData['state'];
  ci?: 's' | 'f' | 'p' | 'e' | 'x';
  /** GitHub merge state: clean / blocked / dirty (conflicts) / behind / unstable. */
  merge?: 'c' | 'b' | 'd' | 'h' | 'u';
};

// Transient presentation params stay in memory, including these service actions.
export type PullRequestActions = {
  openGitHub: (url?: string) => void;
  share: () => void;
  investigate: (check?: PullRequestCheck, sha?: string) => void;
  comment: (body: string) => Promise<boolean>;
};
