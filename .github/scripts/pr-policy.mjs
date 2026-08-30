import { checkPullRequestBody, hasRelatedIssueReference } from './check-pr-body.mjs';
import { normalizeRelatedIssueLink } from './pr-issue-link.mjs';

export const GRACE_PERIOD_DAYS = 7;
export const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1_000;
export const MAX_EXTERNAL_CHANGED_LINES = 200;

export const PULL_REQUEST_DISPOSITION = Object.freeze({
  BOT: 'bot',
  BYPASS: 'bypass',
  INTERNAL: 'internal',
  EXTERNAL: 'external',
});

export const NEEDS_ATTENTION_LABEL = Object.freeze({
  name: 'status:needs-pr-attention',
  color: 'FBCA04',
  description: 'External PR needs contributor attention before review',
});

export const EXPIRED_POLICY_LABEL = Object.freeze({
  name: 'status:pr-policy-expired',
  color: 'B60205',
  description: 'PR closed after contribution requirements remained unmet for seven days',
});

export const BYPASS_PR_POLICY_LABEL = Object.freeze({
  name: 'status:pr-policy-bypass',
  color: '0E8A16',
  description: 'Maintainer exempted this PR from contribution policy',
});

const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const ATTENTION_COMMENT_PREFIX = '<!-- lody-pr-policy invalid-since="';
const ATTENTION_SINCE_PATTERN =
  /<!-- (?:lody-pr-policy|lody-pr-body-format-check) invalid-since="([^"]+)" -->/;
const EXPIRED_COMMENT_MARKER = '<!-- lody-pr-policy-expired -->';
const LEGACY_COMMENT_MARKERS = Object.freeze([
  '<!-- lody-pr-body-format-check',
  '<!-- lody-pr-size-policy -->',
  '<!-- lody-pr-body-expired -->',
]);
const LEGACY_ATTENTION_LABELS = Object.freeze(['status:needs-pr-body', 'status:pr-too-large']);
const LEGACY_EXPIRED_LABELS = Object.freeze(['status:pr-body-expired']);
const MANAGED_POLICY_LABELS = Object.freeze([
  NEEDS_ATTENTION_LABEL.name,
  EXPIRED_POLICY_LABEL.name,
  ...LEGACY_ATTENTION_LABELS,
  ...LEGACY_EXPIRED_LABELS,
]);

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

function isManagedPolicyComment(comment) {
  const body = comment.body ?? '';
  return (
    isActionsBotComment(comment) &&
    (body.includes(ATTENTION_COMMENT_PREFIX) ||
      body.includes(EXPIRED_COMMENT_MARKER) ||
      LEGACY_COMMENT_MARKERS.some((marker) => body.includes(marker)))
  );
}

function isAttentionComment(comment) {
  const body = comment.body ?? '';
  return body.includes(ATTENTION_COMMENT_PREFIX) || body.includes('<!-- lody-pr-body-format-check');
}

function formatUtc(date) {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function attentionCommentMarker(invalidSince) {
  return `${ATTENTION_COMMENT_PREFIX}${invalidSince.toISOString()}" -->`;
}

function hasAnyPullRequestLabel(pullRequest, names) {
  return names.some((name) => hasPullRequestLabel(pullRequest, name));
}

function hasExpiredPolicyState(pullRequest) {
  return hasAnyPullRequestLabel(pullRequest, [EXPIRED_POLICY_LABEL.name, ...LEGACY_EXPIRED_LABELS]);
}

function warningMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function hasPullRequestLabel(pullRequest, name) {
  return (pullRequest.labels ?? []).some((label) => labelName(label) === name);
}

export function hasManagedPullRequestPolicyState(pullRequest) {
  return hasAnyPullRequestLabel(pullRequest, MANAGED_POLICY_LABELS);
}

export function isExternalPullRequest(pullRequest) {
  const baseRepositoryId = pullRequest.base?.repo?.id;
  const headRepositoryId = pullRequest.head?.repo?.id;
  return (
    baseRepositoryId == null || headRepositoryId == null || baseRepositoryId !== headRepositoryId
  );
}

export function pullRequestDisposition(pullRequest) {
  const login = pullRequest.user?.login ?? '';
  if (login.endsWith('[bot]')) {
    return PULL_REQUEST_DISPOSITION.BOT;
  }
  if (hasPullRequestLabel(pullRequest, BYPASS_PR_POLICY_LABEL.name)) {
    return PULL_REQUEST_DISPOSITION.BYPASS;
  }
  return isExternalPullRequest(pullRequest)
    ? PULL_REQUEST_DISPOSITION.EXTERNAL
    : PULL_REQUEST_DISPOSITION.INTERNAL;
}

export function changedLines(pullRequest) {
  return Number(pullRequest.additions ?? 0) + Number(pullRequest.deletions ?? 0);
}

export function checkPullRequestPolicy(pullRequest) {
  const result = checkPullRequestBody(pullRequest.body);
  const findings = [...result.findings];
  const lines = changedLines(pullRequest);
  if (lines > MAX_EXTERNAL_CHANGED_LINES && !hasRelatedIssueReference(pullRequest.body)) {
    findings.push(
      `PR changes ${lines} lines; changes over ${MAX_EXTERNAL_CHANGED_LINES} lines require the prior Lody Issue reference in ## Related issue.`
    );
  }
  return { ok: findings.length === 0, findings };
}

export function invalidSinceFromComment(body) {
  const match = body?.match(ATTENTION_SINCE_PATTERN);
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
  return [
    'PR does not meet Lody contribution requirements:',
    '',
    ...result.findings.map((finding) => `- ${finding}`),
    '',
    'See `.github/PULL_REQUEST_TEMPLATE.md`.',
  ].join('\n');
}

export function buildAttentionComment({ author, findings, invalidSince }) {
  const start = asDate(invalidSince);
  if (!start) {
    throw new Error('A valid invalid-since timestamp is required.');
  }

  const deadline = gracePeriodEndsAt(start);
  const visibleFindings = findings.trim().split('\n').slice(0, 40).join('\n');
  return [
    attentionCommentMarker(start),
    `@${author}, this pull request needs updates before review.`,
    '',
    `It is marked \`${NEEDS_ATTENTION_LABEL.name}\`. Address the findings below by **${formatUtc(deadline)}**. The label and this comment are removed automatically after the PR passes validation.`,
    '',
    `If the PR remains invalid for ${GRACE_PERIOD_DAYS} days, it will be closed and marked \`${EXPIRED_POLICY_LABEL.name}\`. Continue afterward by opening a new pull request with the current template.`,
    '',
    '<details><summary>Policy findings</summary>',
    '',
    '```text',
    visibleFindings || '(no details)',
    '```',
    '',
    '</details>',
  ].join('\n');
}

export function buildExpiredComment({ author }) {
  return [
    EXPIRED_COMMENT_MARKER,
    `@${author}, this pull request was closed because it did not meet Lody's contribution requirements for ${GRACE_PERIOD_DAYS} days.`,
    '',
    'Open a new pull request using the current template to continue contributing this change. This pull request will not be reopened.',
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
  await ensureRepositoryLabel(github, owner, repo, NEEDS_ATTENTION_LABEL);
  await ensureRepositoryLabel(github, owner, repo, EXPIRED_POLICY_LABEL);
  await ensureRepositoryLabel(github, owner, repo, BYPASS_PR_POLICY_LABEL);
}

async function policyComments(github, owner, repo, issueNumber) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return comments.filter(isManagedPolicyComment);
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

async function removeLabels(github, owner, repo, issueNumber, names) {
  for (const name of names) {
    await removeLabel(github, owner, repo, issueNumber, name);
  }
}

async function deleteComments(github, owner, repo, comments) {
  for (const comment of comments) {
    await github.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: comment.id,
    });
  }
}

export async function clearInvalidPullRequest({ github, owner, repo, pullRequest }) {
  await removeLabels(github, owner, repo, pullRequest.number, [
    NEEDS_ATTENTION_LABEL.name,
    ...LEGACY_ATTENTION_LABELS,
  ]);
  const comments = await policyComments(github, owner, repo, pullRequest.number);
  await deleteComments(
    github,
    owner,
    repo,
    comments.filter((comment) => !comment.body?.includes(EXPIRED_COMMENT_MARKER))
  );
}

export async function clearPullRequestPolicyState({ github, owner, repo, pullRequest }) {
  await removeLabels(github, owner, repo, pullRequest.number, MANAGED_POLICY_LABELS);
  const comments = await policyComments(github, owner, repo, pullRequest.number);
  await deleteComments(github, owner, repo, comments);
}

export async function markInvalidPullRequest({
  github,
  owner,
  repo,
  pullRequest,
  findings,
  now = new Date(),
}) {
  if (hasExpiredPolicyState(pullRequest)) {
    return { expired: true, invalidSince: null };
  }

  await ensurePolicyLabels(github, owner, repo);
  const comments = await policyComments(github, owner, repo, pullRequest.number);
  const existing = comments.find(isAttentionComment);
  const invalidSince = invalidSinceFromComment(existing?.body) ?? asDate(now);
  if (!invalidSince) {
    throw new Error('A valid current timestamp is required.');
  }

  if (!hasPullRequestLabel(pullRequest, NEEDS_ATTENTION_LABEL.name)) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: [NEEDS_ATTENTION_LABEL.name],
    });
  }
  await removeLabels(github, owner, repo, pullRequest.number, LEGACY_ATTENTION_LABELS);

  const body = buildAttentionComment({
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
  await deleteComments(
    github,
    owner,
    repo,
    comments.filter((comment) => comment.id !== existing?.id)
  );

  return { expired: false, invalidSince };
}

export async function expirePullRequest({ github, owner, repo, pullRequest, beforeClose }) {
  await ensurePolicyLabels(github, owner, repo);
  const alreadyExpired = hasPullRequestLabel(pullRequest, EXPIRED_POLICY_LABEL.name);

  if (beforeClose) {
    const shouldClose = await beforeClose();
    if (!shouldClose) {
      return false;
    }
  }

  if (!alreadyExpired) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pullRequest.number,
      labels: [EXPIRED_POLICY_LABEL.name],
    });
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
      await removeLabel(github, owner, repo, pullRequest.number, EXPIRED_POLICY_LABEL.name);
    }
    throw error;
  }

  const feedbackErrors = [];
  try {
    const comments = await policyComments(github, owner, repo, pullRequest.number);
    const existing = comments.find(isAttentionComment) ?? comments[0];
    const body = buildExpiredComment({ author: pullRequest.user.login });
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
    await deleteComments(
      github,
      owner,
      repo,
      comments.filter((comment) => comment.id !== existing?.id)
    );
  } catch (error) {
    feedbackErrors.push(error);
  }

  try {
    await removeLabels(github, owner, repo, pullRequest.number, [
      NEEDS_ATTENTION_LABEL.name,
      ...LEGACY_ATTENTION_LABELS,
      ...LEGACY_EXPIRED_LABELS,
    ]);
  } catch (error) {
    feedbackErrors.push(error);
  }
  if (feedbackErrors.length > 0) {
    throw new AggregateError(
      feedbackErrors,
      'PR was closed, but its final policy feedback was incomplete.'
    );
  }
  return true;
}

async function normalizeIssueLink({ github, owner, repo, pullRequest, defaultBranch }) {
  if (pullRequest.base?.ref !== defaultBranch) {
    return { changed: false, body: pullRequest.body ?? '' };
  }
  const body = normalizeRelatedIssueLink(pullRequest.body);
  if (body === (pullRequest.body ?? '')) {
    return { changed: false, body };
  }
  await github.rest.pulls.update({
    owner,
    repo,
    pull_number: pullRequest.number,
    body,
  });
  return { changed: true, body };
}

async function clearSkippedPolicyState(input, warnings, { force = false } = {}) {
  if (!force && !hasManagedPullRequestPolicyState(input.pullRequest)) {
    return;
  }
  try {
    await clearPullRequestPolicyState(input);
  } catch (error) {
    warnings.push(`Could not clear stale PR policy state: ${warningMessage(error)}`);
  }
}

async function normalizeIssueLinkBestEffort(input, warnings) {
  try {
    return await normalizeIssueLink(input);
  } catch (error) {
    warnings.push(`Could not normalize the related Issue link: ${warningMessage(error)}`);
    return { changed: false, body: input.pullRequest.body ?? '' };
  }
}

export async function reconcilePullRequest({
  github,
  owner,
  repo,
  pullRequest,
  defaultBranch,
  now = new Date(),
  expireOverdue = false,
}) {
  const disposition = pullRequestDisposition(pullRequest);
  const warnings = [];
  const input = { github, owner, repo, pullRequest };

  if (
    disposition === PULL_REQUEST_DISPOSITION.BOT ||
    disposition === PULL_REQUEST_DISPOSITION.BYPASS
  ) {
    await clearSkippedPolicyState(input, warnings, {
      force: disposition === PULL_REQUEST_DISPOSITION.BYPASS,
    });
    return { disposition, state: 'skipped', validation: null, warnings };
  }

  const normalized = await normalizeIssueLinkBestEffort({ ...input, defaultBranch }, warnings);
  const currentPullRequest = normalized.changed
    ? { ...pullRequest, body: normalized.body }
    : pullRequest;

  if (disposition === PULL_REQUEST_DISPOSITION.INTERNAL) {
    await clearSkippedPolicyState({ ...input, pullRequest: currentPullRequest }, warnings);
    return { disposition, state: 'skipped', validation: null, warnings };
  }

  if (hasExpiredPolicyState(currentPullRequest)) {
    if (currentPullRequest.state === 'open') {
      await expirePullRequest({ ...input, pullRequest: currentPullRequest });
    }
    return { disposition, state: 'expired', validation: null, warnings };
  }

  const validation = checkPullRequestPolicy(currentPullRequest);
  if (validation.ok) {
    try {
      await clearInvalidPullRequest({ ...input, pullRequest: currentPullRequest });
    } catch (error) {
      warnings.push(`Could not clear resolved PR policy state: ${warningMessage(error)}`);
    }
    return { disposition, state: 'valid', validation, warnings };
  }

  const policyState = await markInvalidPullRequest({
    ...input,
    pullRequest: currentPullRequest,
    findings: formatCheckerFindings(validation),
    now,
  });
  if (
    expireOverdue &&
    policyState.invalidSince &&
    isGracePeriodExpired(policyState.invalidSince, now)
  ) {
    const expired = await expirePullRequest({
      ...input,
      pullRequest: currentPullRequest,
      beforeClose: async () => {
        const latest = (
          await github.rest.pulls.get({
            owner,
            repo,
            pull_number: currentPullRequest.number,
          })
        ).data;
        return (
          latest.state === 'open' &&
          pullRequestDisposition(latest) === PULL_REQUEST_DISPOSITION.EXTERNAL &&
          hasPullRequestLabel(latest, NEEDS_ATTENTION_LABEL.name) &&
          !checkPullRequestPolicy(latest).ok
        );
      },
    });
    return { disposition, state: expired ? 'expired' : 'invalid', validation, warnings };
  }

  return { disposition, state: 'invalid', validation, warnings };
}
