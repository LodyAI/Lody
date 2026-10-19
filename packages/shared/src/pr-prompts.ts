/** Prompts for the manual pull request and commit quick actions. */

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

/**
 * Why the PR prompts send `gh` outside the sandbox. The user reads this text in
 * their own chat, so it names the reason (the saved GitHub login) instead of
 * asking for "elevated permissions", which read like an injected instruction.
 */
const GH_AUTH_INSTRUCTION =
  'Use `gh` from the current PATH. `gh` signs in with the GitHub login saved on this machine, which sandboxed commands usually cannot read, so run the `gh` commands that talk to GitHub outside the sandbox (request approval if your tool requires it). Ask the user to log in only if authentication still fails there. Verify that the pushed commit matches the PR head, then report the PR URL.';

export const CREATE_PR_BASE_PROMPT = `Create a PR for the current worktree (a regular PR, not a draft). ${GH_AUTH_INSTRUCTION}`;

export const CREATE_DRAFT_PR_BASE_PROMPT = `Create a draft PR for the current worktree. ${GH_AUTH_INSTRUCTION}`;

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

/** Joins a PR-creation prompt to the standing upkeep instruction. */
export const withPrBranchUpkeep = (basePrompt: string, upkeep: string): string =>
  `${basePrompt}\n\n${upkeep}`;

/** Composed form for callers without i18n. */
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
