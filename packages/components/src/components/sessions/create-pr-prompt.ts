/**
 * Moved to `@lody/shared` so the auto-review engine in the CLI can ask the
 * author to open a PR with the exact text the manual quick action uses. Kept as
 * a re-export so existing imports stay put.
 */
export {
  COMMIT_AND_PUSH_PROMPT,
  CREATE_DRAFT_PR_BASE_PROMPT,
  CREATE_DRAFT_PR_PROMPT,
  CREATE_PR_BASE_PROMPT,
  CREATE_PR_PROMPT,
  PR_BRANCH_UPKEEP_PROMPT,
  withPrBranchUpkeep,
} from '@lody/shared';
