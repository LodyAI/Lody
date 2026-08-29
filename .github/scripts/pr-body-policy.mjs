export const GRACE_PERIOD_DAYS = 7;
export const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1_000;

export const NEEDS_BODY_LABEL = Object.freeze({
  name: 'status:needs-pr-body',
  color: 'FBCA04',
  description: 'PR body does not meet the contribution template',
});

export const EXPIRED_BODY_LABEL = Object.freeze({
  name: 'status:pr-body-expired',
  color: 'B60205',
  description: 'PR closed after its body remained invalid for seven days',
});

export const BYPASS_PR_POLICY_LABEL = Object.freeze({
  name: 'status:pr-policy-bypass',
  color: '0E8A16',
  description: 'Repository owner approved an exception to external PR policy',
});

const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const INVALID_COMMENT_PREFIX = '<!-- lody-pr-body-format-check';
const INVALID_SINCE_PATTERN = /<!-- lody-pr-body-format-check invalid-since="([^"]+)" -->/;
const EXPIRED_COMMENT_MARKER = '<!-- lody-pr-body-expired -->';

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function isActionsBotComment(comment) {
  return comment.user?.login === ACTIONS_BOT_LOGIN && comment.user?.type === 'Bot';
}

function formatUtc(date) {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function invalidCommentMarker(invalidSince) {
  return `${INVALID_COMMENT_PREFIX} invalid-since="${invalidSince.toISOString()}" -->`;
}

export function shouldEnforcePullRequest(pullRequest) {
  const association = pullRequest.author_association;
  const login = pullRequest.user?.login ?? '';
  return (
    association !== 'OWNER' &&
    association !== 'MEMBER' &&
    !login.endsWith('[bot]') &&
    !hasPullRequestLabel(pullRequest, BYPASS_PR_POLICY_LABEL.name)
  );
}

export function hasPullRequestLabel(pullRequest, name) {
  return (pullRequest.labels ?? []).some((label) => labelName(label) === name);
}

export function invalidSinceFromComment(body) {
  const match = body?.match(INVALID_SINCE_PATTERN);
  return match ? asDate(match[1]) : null;
}

export function gracePeriodEndsAt(invalidSince) {
  const start = asDate(invalidSince);
  return start ? new Date(start.getTime() + GRACE_PERIOD_MS) : null;
}

export function isGracePeriodExpired(invalidSince, now = new Date()) {
  const deadline = gracePeriodEndsAt(invalidSince);
  const current = asDate(now);
  return Boolean(deadline && current && current.getTime() >= deadline.getTime());
}

export function formatCheckerFindings(result) {
  const lines = [
    'PR body does not match the Lody pull request template:',
    '',
    ...result.findings.map((finding) => `- ${finding}`),
    '',
    'See `.github/PULL_REQUEST_TEMPLATE.md`.',
  ];
  return lines.join('\n');
}

export function buildInvalidBodyComment({ author, findings, invalidSince }) {
  const start = asDate(invalidSince);
  if (!start) {
    throw new Error('A valid invalid-since timestamp is required.');
  }

  const deadline = gracePeriodEndsAt(start);
  const visibleFindings = findings.trim().split('\n').slice(0, 40).join('\n');
  return [
    invalidCommentMarker(start),
    `@${author}, this pull request body does **not** match Lody's PR template.`,
    '',
    `This PR is marked \`${NEEDS_BODY_LABEL.name}\`. Update the description and satisfy every required section by **${formatUtc(deadline)}**. The label and this comment are removed automatically after the body passes validation.`,
    '',
    `If the body remains invalid for ${GRACE_PERIOD_DAYS} days, this PR will be closed and marked \`${EXPIRED_BODY_LABEL.name}\`. To contribute after that, open a new pull request using the current template.`,
    '',
    'Every external PR must link a Lody issue and provide a complete public Context handoff with concise, PR-specific review instructions. `N/A` and redacted context are not accepted because maintainers need enough provenance, scope, and risk information to assess the contribution.',
    '',
    '<details><summary>Checker findings</summary>',
    '',
    '```text',
    visibleFindings || '(no details)',
    '```',
    '',
    '</details>',
  ].join('\n');
}

export function buildExpiredBodyComment({ author }) {
  return [
    EXPIRED_COMMENT_MARKER,
    `@${author}, this pull request was closed because its body did not meet Lody's contribution requirements for ${GRACE_PERIOD_DAYS} days.`,
    '',
    'To contribute this change, open a new pull request using the current template and complete every required section before submitting it. This pull request will not be reopened.',
  ].join('\n');
}

async function ensureRepositoryLabel(github, owner, repo, label) {
  let current;
  try {
    current = (
      await github.rest.issues.getLabel({
        owner,
        repo,
        name: label.name,
      })
    ).data;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    await github.rest.issues.createLabel({ owner, repo, ...label });
    return;
  }

  if (
    current.color.toUpperCase() !== label.color ||
    (current.description ?? '') !== label.description
  ) {
    await github.rest.issues.updateLabel({
      owner,
      repo,
      name: label.name,
      new_name: label.name,
      color: label.color,
      description: label.description,
    });
  }
}

export async function ensurePolicyLabels(github, owner, repo) {
  await ensureRepositoryLabel(github, owner, repo, NEEDS_BODY_LABEL);
  await ensureRepositoryLabel(github, owner, repo, EXPIRED_BODY_LABEL);
  await ensureRepositoryLabel(github, owner, repo, BYPASS_PR_POLICY_LABEL);
}

async function policyComments(github, owner, repo, issueNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return comments.filter(isActionsBotComment);
}

async function removeLabel(github, owner, repo, issueNumber, name) {
  try {
    await github.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name,
    });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }
}

export async function markInvalidPullRequest({
  github,
  owner,
  repo,
  pullRequest,
  findings,
  now = new Date(),
}) {
  if (hasPullRequestLabel(pullRequest, EXPIRED_BODY_LABEL.name)) {
    return { expired: true, invalidSince: null };
  }

  await ensurePolicyLabels(github, owner, repo);
  const comments = await policyComments(github, owner, repo, pullRequest.number);
  const existing = comments.find((comment) => comment.body?.includes(INVALID_COMMENT_PREFIX));
  const alreadyMarked = hasPullRequestLabel(pullRequest, NEEDS_BODY_LABEL.name);
  const preservedStart = alreadyMarked ? invalidSinceFromComment(existing?.body) : null;
  const invalidSince = preservedStart ?? asDate(now);
  if (!invalidSince) {
    throw new Error('A valid current timestamp is required.');
  }

  if (!alreadyMarked) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: [NEEDS_BODY_LABEL.name],
    });
  }

  const body = buildInvalidBodyComment({
    author: pullRequest.user.login,
    findings,
    invalidSince,
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

  return { expired: false, invalidSince };
}

export async function clearInvalidPullRequest({ github, owner, repo, pullRequest }) {
  await removeLabel(github, owner, repo, pullRequest.number, NEEDS_BODY_LABEL.name);
  const comments = await policyComments(github, owner, repo, pullRequest.number);
  const invalidComments = comments.filter((comment) =>
    comment.body?.includes(INVALID_COMMENT_PREFIX)
  );
  for (const comment of invalidComments) {
    await github.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: comment.id,
    });
  }
}

export async function clearPullRequestPolicyState({ github, owner, repo, pullRequest }) {
  await removeLabel(github, owner, repo, pullRequest.number, NEEDS_BODY_LABEL.name);
  await removeLabel(github, owner, repo, pullRequest.number, EXPIRED_BODY_LABEL.name);
  const comments = await policyComments(github, owner, repo, pullRequest.number);
  const managedComments = comments.filter(
    (comment) =>
      comment.body?.includes(INVALID_COMMENT_PREFIX) ||
      comment.body?.includes(EXPIRED_COMMENT_MARKER)
  );
  for (const comment of managedComments) {
    await github.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: comment.id,
    });
  }
}

export async function expirePullRequest({ github, owner, repo, pullRequest, beforeClose }) {
  await ensurePolicyLabels(github, owner, repo);
  const alreadyExpired = hasPullRequestLabel(pullRequest, EXPIRED_BODY_LABEL.name);
  if (!alreadyExpired) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: [EXPIRED_BODY_LABEL.name],
    });
  }

  if (beforeClose) {
    let shouldClose;
    try {
      shouldClose = await beforeClose();
    } catch (error) {
      if (!alreadyExpired) {
        await removeLabel(github, owner, repo, pullRequest.number, EXPIRED_BODY_LABEL.name);
      }
      throw error;
    }
    if (!shouldClose) {
      if (!alreadyExpired) {
        await removeLabel(github, owner, repo, pullRequest.number, EXPIRED_BODY_LABEL.name);
      }
      return false;
    }
  }

  try {
    await github.rest.pulls.update({
      owner,
      repo,
      pull_number: pullRequest.number,
      state: 'closed',
    });
  } catch (error) {
    if (!alreadyExpired) {
      await removeLabel(github, owner, repo, pullRequest.number, EXPIRED_BODY_LABEL.name);
    }
    throw error;
  }

  const feedbackErrors = [];
  try {
    const comments = await policyComments(github, owner, repo, pullRequest.number);
    const existing =
      comments.find((comment) => comment.body?.includes(EXPIRED_COMMENT_MARKER)) ??
      comments.find((comment) => comment.body?.includes(INVALID_COMMENT_PREFIX));
    const body = buildExpiredBodyComment({ author: pullRequest.user.login });
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
  } catch (error) {
    feedbackErrors.push(error);
  }

  try {
    await removeLabel(github, owner, repo, pullRequest.number, NEEDS_BODY_LABEL.name);
  } catch (error) {
    feedbackErrors.push(error);
  }
  if (feedbackErrors.length > 0) {
    throw new AggregateError(
      feedbackErrors,
      'PR was closed, but its final feedback was incomplete.'
    );
  }
  return true;
}
