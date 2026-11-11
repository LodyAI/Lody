/**
 * Prompts for the manual pull request and commit quick actions. They carry the
 * user's request and facts the agent cannot discover on its own, never a workflow:
 * Lody provides the tools and the agent decides how to use them (root AGENTS.md).
 *
 * The `gh` fact stays because sandboxed agents otherwise fail to authenticate and
 * ask the user to log in again.
 */
const GH_AUTH_FACT =
  '`gh` uses the GitHub login saved on this machine, which sandboxed commands usually cannot read.';

export const CREATE_PR_BASE_PROMPT = `Create a PR (not a draft) for the current worktree. ${GH_AUTH_FACT}`;

export const CREATE_DRAFT_PR_BASE_PROMPT = `Create a draft PR for the current worktree. ${GH_AUTH_FACT}`;

/**
 * Standing instruction appended to the PR-creation prompts. Turn finalization does
 * not commit on the session's behalf, so this keeps the PR head current; the Info
 * Bar's `Commit & Push` action is the visible fallback. Exported separately so the
 * UI composes it from its own i18n key.
 */
export const PR_BRANCH_UPKEEP_PROMPT =
  'After the PR exists, commit and push your changes to the PR branch at the end of every turn in this conversation.';

/** Joins a PR-creation prompt to the standing upkeep instruction. */
export const withPrBranchUpkeep = (basePrompt: string, upkeep: string): string =>
  `${basePrompt}\n\n${upkeep}`;

/**
 * Lead lines the Info Bar puts before its PR prompts, so a user scrolling back
 * sees that the message came from the button they clicked. Kept separate so the UI can
 * compose localized prompts with the same origin line.
 */
export const CREATE_PR_ORIGIN_PROMPT = '(Sent by the **Create PR** button in Lody.)';

export const CREATE_DRAFT_PR_ORIGIN_PROMPT = '(Sent by the **Create Draft PR** button in Lody.)';

/** Puts a quick action's origin line above the prompt it sent. */
export const withQuickActionOrigin = (origin: string, prompt: string): string =>
  `${origin}\n\n${prompt}`;

/** Adds the Project group facts to a PR or Commit & Push quick action. */
export const withProjectGroupPrScope = (prompt: string): string =>
  `${prompt}\n\n${[
    'This conversation is a Project group: its directory is not a Git repository, and its member repositories are listed in this conversation.',
    'The request applies to each member repository with changes or unpublished commits.',
  ].join(' ')}`;

export const COMMIT_AND_PUSH_PROMPT = 'Commit the uncommitted changes and push the current branch.';
