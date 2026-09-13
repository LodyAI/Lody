import type { ReviewFinding } from './review';

/**
 * Prompts for the auto review and merge loop.
 *
 * They live in `@lody/shared` rather than in the components package because the
 * CLI drives most of this loop headlessly and cannot import frontend code. The
 * PR/commit prompts moved here for the same reason: the engine asks the author
 * to open the PR using the exact text the manual quick action uses, so the two
 * paths cannot drift.
 */

/**
 * Standing instruction appended to the PR-creation prompts.
 *
 * Opening a PR is what makes "is the branch pushed?" matter: from that moment a
 * reviewer reads the PR head as the author's latest work. The machine used to
 * enforce that by auto-prompting the agent to commit+push at the end of every
 * turn, which surprised users who had not asked for a commit. The enforcement
 * now lives here instead — an instruction the agent follows and the user can
 * override in conversation — with the Info Bar's `Commit & Push` action as the
 * visible fallback when a turn still ends with unpublished work.
 *
 * Exported separately from the two prompts so the UI can compose it from its own
 * i18n key. Inlining it into each localized prompt would put the same paragraph
 * in five places with nothing to catch a wording change that misses one.
 */
export const PR_BRANCH_UPKEEP_PROMPT = [
  'After the PR exists, keep it current: at the end of every turn in this conversation,',
  'commit any outstanding changes and push them to the PR branch before you finish, so',
  'the PR head always matches your latest work. Treat this as the default rather than',
  'something to ask about each time. Skip it only when the user interrupts you or asks',
  'for something that overrides it — in that case say so instead of pushing silently.',
].join(' ');

export const CREATE_PR_BASE_PROMPT =
  'Create a PR for the current worktree (a regular PR, not a draft). Use `gh` from the current PATH and run GitHub-authenticated commands with elevated permissions. If authentication fails in the sandbox, retry with elevated permissions before asking the user to log in. Verify that the pushed commit matches the PR head, then report the PR URL.';

export const CREATE_DRAFT_PR_BASE_PROMPT =
  'Create a draft PR for the current worktree. Use `gh` from the current PATH and run GitHub-authenticated commands with elevated permissions. If authentication fails in the sandbox, retry with elevated permissions before asking the user to log in. Verify that the pushed commit matches the PR head, then report the PR URL.';

/** Joins a PR-creation prompt to the standing upkeep instruction. */
export const withPrBranchUpkeep = (basePrompt: string, upkeep: string): string =>
  `${basePrompt}\n\n${upkeep}`;

/** Composed form for headless callers (the auto-review engine) that have no i18n. */
export const CREATE_PR_PROMPT = withPrBranchUpkeep(CREATE_PR_BASE_PROMPT, PR_BRANCH_UPKEEP_PROMPT);

export const CREATE_DRAFT_PR_PROMPT = withPrBranchUpkeep(
  CREATE_DRAFT_PR_BASE_PROMPT,
  PR_BRANCH_UPKEEP_PROMPT
);

export const COMMIT_AND_PUSH_PROMPT = [
  'Publish the current branch: commit anything uncommitted, then push to the remote branch.',
  '',
  'Instructions:',
  '- Generate a concise, descriptive commit message based on the changes',
  '- Stage all changes (git add -A)',
  '- Commit with the generated message',
  '- If the working tree is already clean, skip the commit — the branch may simply',
  '  hold commits that were never pushed',
  '- Push to the current branch, and report it if the push fails',
].join('\n');

export type ReviewPromptContext = {
  /** What this branch is supposed to achieve: task body, PR description, or first user message. */
  intent?: string;
  /** Ref to diff against, e.g. `origin/main`. */
  baseRef: string;
  /** Workspace-wide requirements from settings. */
  requirements?: string;
  /** Filename holding repository standards. */
  standardsFilename?: string;
  /** Consulted when the standards file is absent. */
  fallbackFilenames?: readonly string[];
};

const section = (lines: (string | undefined | false)[]): string =>
  lines.filter((line): line is string => typeof line === 'string').join('\n');

/**
 * The reviewer reads the standards itself, with the base ref named in the
 * command.
 *
 * That is a security property, not a convenience: `REVIEW.md` is ordinary
 * repository content, so taking the working tree's copy would let a branch
 * rewrite the rules it is about to be judged by — and, with automatic merge on,
 * approve itself. `git show <baseRef>:FILE` can only produce the base branch's
 * version.
 */
const renderStandards = (context: ReviewPromptContext): string => {
  const filename = context.standardsFilename ?? 'REVIEW.md';
  const fallbacks = context.fallbackFilenames ?? ['AGENTS.md', 'CLAUDE.md'];
  const parts = ['## Standards'];
  if (context.requirements?.trim()) {
    parts.push('### From Lody settings', context.requirements.trim(), '');
  }
  parts.push(
    '### From the repository',
    `Read them with \`git show ${context.baseRef}:${filename}\`.`,
    `Read the standards from ${context.baseRef}, NOT from the working tree — the branch you are`,
    'reviewing is not allowed to change the rules it is judged by.',
    `If that file does not exist, fall back to ${fallbacks.join(' or ')} in the repository root.`,
    'If none exist, judge correctness, security, and whether the change achieves the stated',
    'intent, and do not invent style rules.'
  );
  if (context.requirements?.trim()) {
    parts.push('', 'If the two sets conflict, the repository standards win.');
  }
  return parts.join('\n');
};

/**
 * First review round.
 *
 * The diff is not inlined: the reviewer runs `git diff` itself. That keeps a
 * large branch from blowing the context window, and it lets the reviewer open
 * whatever surrounding files it needs instead of judging a change from a hunk
 * with no context.
 */
export const buildReviewPrompt = (context: ReviewPromptContext): string =>
  section([
    'You are reviewing a branch. You did not write this code and you have not',
    "seen the author's reasoning — judge only what is in the diff.",
    '',
    context.intent?.trim() ? `## Intent\n${context.intent.trim()}` : undefined,
    context.intent?.trim() ? '' : undefined,
    renderStandards(context),
    '',
    '',
    '## How to work',
    `- Read the diff yourself: \`git diff ${context.baseRef}...HEAD\`. Open surrounding files as needed.`,
    '- Review ONLY the changed lines and what they affect. Do not propose refactors of untouched code.',
    '- You cannot edit files. Report findings; the author will fix them.',
    '',
    '## Severity',
    '- `blocking` — a correctness bug, a security or data-loss issue, a violation of an',
    '  explicit rule in the standards above, or a change that does not achieve the stated',
    '  intent. You MUST state a concrete failure scenario: specific inputs or state, and',
    '  the wrong result they produce. If you cannot write that scenario, it is not blocking.',
    '- `suggestion` — everything else. Never blocks the merge.',
    '',
    '## Calibration',
    'Default to approving. Only request changes when you found something specific.',
    'Do not manufacture findings to appear thorough. Do not restate what the diff does.',
    'Style opinions the standards above do not ask for are not findings at all — omit them.',
    '',
    'Call `lody_review_submit` exactly once when you are done.',
  ]);

export const formatFindingForPrompt = (finding: ReviewFinding): string =>
  section([
    `- [${finding.id}] ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.title}`,
    `  ${finding.detail}`,
    finding.failureScenario ? `  Failure: ${finding.failureScenario}` : undefined,
    finding.resolutionNote ? `  Author replied: ${finding.resolutionNote}` : undefined,
  ]);

export type ReviewRecheckContext = {
  openFindings: readonly ReviewFinding[];
  round: number;
  maxRounds: number;
  /** What the author said, including any disagreement. */
  authorReply?: string;
};

/**
 * Later rounds are re-checks, not fresh reviews.
 *
 * The rule against adding new suggestions is what makes the loop converge: a
 * reviewer free to raise fresh opinions every round will always spend the whole
 * budget, and the author never reaches a state where nothing is outstanding.
 */
export const buildReviewRecheckPrompt = (context: ReviewRecheckContext): string =>
  section([
    'Re-check your findings on this branch. The author has pushed changes.',
    '',
    '## Open findings',
    context.openFindings.map(formatFindingForPrompt).join('\n'),
    '',
    context.authorReply?.trim() ? `## Author's reply\n${context.authorReply.trim()}\n` : undefined,
    '## Rules for this round',
    '- Verify each finding against the current code. The author claiming something is',
    '  fixed does not close it — you do.',
    '- Set each to `resolved`, `unresolved`, or `disputed`. Use `disputed` when the author',
    '  gave a reason you cannot refute and you still disagree; that ends the loop and',
    '  escalates to a human.',
    '- Do NOT add new suggestions. Add a new finding only if it is `blocking` AND was',
    '  introduced by the changes since your last review.',
    `- This is round ${context.round} of ${context.maxRounds}.`,
    '',
    'Call `lody_review_submit` exactly once when you are done.',
  ]);

/**
 * Sent to the authoring session. It deliberately does not offer a tool for
 * disagreeing: the author replies in prose and the reviewer decides on re-check
 * whether that is a dispute, which keeps review vocabulary out of a general
 * agent's tool surface and leaves the judgement with the party holding the bar.
 */
/**
 * `hasPullRequest` changes the last line, and it matters more than it looks.
 *
 * With a pull request open, the reviewer re-checks the local working copy while
 * the merge gate reads the PR's head from GitHub. A fix that is committed but
 * never pushed therefore passes review and then merges a head that does not
 * contain it. Telling the author to push is what keeps those two views of "the
 * branch" the same.
 */
export const buildAuthorFixPrompt = (
  findings: readonly ReviewFinding[],
  options: { hasPullRequest?: boolean } = {}
): string =>
  section([
    'A code reviewer flagged blocking issues on this branch. Fix them.',
    '',
    findings.map(formatFindingForPrompt).join('\n'),
    '',
    'Instructions:',
    '- Fix each issue. Keep changes minimal and scoped to the issue.',
    '- If you believe a finding is wrong, do not change the code for it — explain why in',
    '  your reply. The reviewer will re-check and escalate to a human if you still disagree.',
    '- Do not fix unrelated things you notice.',
    options.hasPullRequest
      ? '- Commit AND push when done, so the pull request contains your fixes.'
      : '- Commit when done. Do not create a PR yet.',
  ]);

/** Light re-check after a CI fix, so small CI churn does not burn a review round. */
export const buildCiFixRecheckPrompt = (baseRef: string): string =>
  section([
    'The author pushed a fix for a failing CI check on this branch.',
    '',
    `Look only at what changed since your last review (\`git diff ${baseRef}...HEAD\`) and`,
    'decide whether those changes introduce a blocking problem. This is a spot check, not',
    'a full review: do not re-raise resolved findings and do not add suggestions.',
    '',
    'Call `lody_review_submit` exactly once with verdict `approve` if nothing blocking was',
    'introduced.',
  ]);
