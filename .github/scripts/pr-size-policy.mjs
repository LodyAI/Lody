import { hasRelatedIssueReference } from './check-pr-body.mjs';
import { hasPullRequestLabel, shouldEnforcePullRequest } from './pr-body-policy.mjs';

export const MAX_EXTERNAL_CHANGED_LINES = 200;

export const TOO_LARGE_LABEL = Object.freeze({
  name: 'status:pr-too-large',
  color: 'FBCA04',
  description: 'External PR over 200 changed lines needs a prior issue within seven days',
});

const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const COMMENT_MARKER = '<!-- lody-pr-size-policy -->';

function isActionsBotComment(comment) {
  return comment.user?.login === ACTIONS_BOT_LOGIN && comment.user?.type === 'Bot';
}

export function changedLines(pullRequest) {
  return Number(pullRequest.additions ?? 0) + Number(pullRequest.deletions ?? 0);
}

export function exceedsExternalChangeLimit(pullRequest) {
  return changedLines(pullRequest) > MAX_EXTERNAL_CHANGED_LINES;
}

export function shouldWarnPullRequestSize(pullRequest) {
  return (
    shouldEnforcePullRequest(pullRequest) &&
    exceedsExternalChangeLimit(pullRequest) &&
    !hasRelatedIssueReference(pullRequest.body)
  );
}

export function buildOversizedPullRequestWarning({ author, lines }) {
  return [
    COMMENT_MARKER,
    `@${author}, this pull request changes **${lines} lines** (additions + deletions) without linking a prior Lody issue.`,
    '',
    `It is marked \`${TOO_LARGE_LABEL.name}\`. The PR-body policy gives you seven days from the first invalid-body notice to fix the description. Open an issue, wait for maintainers to explicitly agree on the scope and approach, then add its full URL to \`## Related issue\`. Creating an issue yourself is not approval.`,
    '',
    'The size warning clears automatically after a valid Issue URL is linked. If the PR body remains invalid for seven days, the shared expiry policy closes the PR and requires a new submission; automation verifies the URL but maintainers decide whether prior agreement is sufficient.',
  ].join('\n');
}

async function ensureRepositoryLabel(github, owner, repo) {
  let current;
  try {
    current = (
      await github.rest.issues.getLabel({
        owner,
        repo,
        name: TOO_LARGE_LABEL.name,
      })
    ).data;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    await github.rest.issues.createLabel({ owner, repo, ...TOO_LARGE_LABEL });
    return;
  }

  if (
    current.color.toUpperCase() !== TOO_LARGE_LABEL.color ||
    (current.description ?? '') !== TOO_LARGE_LABEL.description
  ) {
    await github.rest.issues.updateLabel({
      owner,
      repo,
      name: TOO_LARGE_LABEL.name,
      new_name: TOO_LARGE_LABEL.name,
      color: TOO_LARGE_LABEL.color,
      description: TOO_LARGE_LABEL.description,
    });
  }
}

async function policyComments(github, owner, repo, issueNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return comments.filter(
    (comment) => isActionsBotComment(comment) && comment.body?.includes(COMMENT_MARKER)
  );
}

async function removeLabel(github, owner, repo, issueNumber) {
  try {
    await github.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: TOO_LARGE_LABEL.name,
    });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }
}

export async function clearSizePolicyState({ github, owner, repo, pullRequest }) {
  await removeLabel(github, owner, repo, pullRequest.number);
  const comments = await policyComments(github, owner, repo, pullRequest.number);
  for (const comment of comments) {
    await github.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: comment.id,
    });
  }
}

export async function reconcilePullRequestSize({ github, owner, repo, pullRequest }) {
  if (!shouldEnforcePullRequest(pullRequest)) {
    if (hasPullRequestLabel(pullRequest, TOO_LARGE_LABEL.name)) {
      await clearSizePolicyState({ github, owner, repo, pullRequest });
    }
    return false;
  }

  const alreadyWarned = hasPullRequestLabel(pullRequest, TOO_LARGE_LABEL.name);
  if (!shouldWarnPullRequestSize(pullRequest)) {
    if (alreadyWarned) {
      await clearSizePolicyState({ github, owner, repo, pullRequest });
    }
    return false;
  }

  await ensureRepositoryLabel(github, owner, repo);
  if (!alreadyWarned) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: [TOO_LARGE_LABEL.name],
    });
  }

  const comments = await policyComments(github, owner, repo, pullRequest.number);
  const existing = comments[0];
  const body = buildOversizedPullRequestWarning({
    author: pullRequest.user.login,
    lines: changedLines(pullRequest),
  });
  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullRequest.number,
      body,
    });
  }
  return true;
}
