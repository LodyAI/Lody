export const NEEDS_ISSUE_BODY_LABEL = Object.freeze({
  name: 'status:needs-issue-body',
  color: 'FBCA04',
  description: 'Issue does not meet the Bug or Feature form requirements',
});

const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
const COMMENT_MARKER = '<!-- lody-issue-body-format-check -->';

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function isActionsBotComment(comment) {
  return comment.user?.login === ACTIONS_BOT_LOGIN && comment.user?.type === 'Bot';
}

export function shouldEnforceIssue(issue) {
  const login = issue.user?.login ?? '';
  return issue.author_association !== 'OWNER' && !login.endsWith('[bot]');
}

export function hasIssueLabel(issue, name) {
  return (issue.labels ?? []).some((label) => labelName(label) === name);
}

export function formatIssueFindings(result) {
  return [
    'Issue does not match a Lody Issue Form:',
    '',
    ...result.findings.map((finding) => `- ${finding}`),
  ].join('\n');
}

export function buildInvalidIssueComment({ author, findings }) {
  const visibleFindings = findings.trim().split('\n').slice(0, 50).join('\n');
  return [
    COMMENT_MARKER,
    `@${author}, this issue does **not** match Lody's Bug report or Feature request form.`,
    '',
    `It is marked \`${NEEDS_ISSUE_BODY_LABEL.name}\`. Update the title and body without removing required sections or confirmations; the warning is cleared automatically when the issue passes validation. Repository owners and automated bots are exempt, but organization members are not.`,
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

async function ensureRepositoryLabel(github, owner, repo) {
  let current;
  try {
    current = (
      await github.rest.issues.getLabel({ owner, repo, name: NEEDS_ISSUE_BODY_LABEL.name })
    ).data;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    await github.rest.issues.createLabel({ owner, repo, ...NEEDS_ISSUE_BODY_LABEL });
    return;
  }

  if (
    current.color.toUpperCase() !== NEEDS_ISSUE_BODY_LABEL.color ||
    (current.description ?? '') !== NEEDS_ISSUE_BODY_LABEL.description
  ) {
    await github.rest.issues.updateLabel({
      owner,
      repo,
      name: NEEDS_ISSUE_BODY_LABEL.name,
      new_name: NEEDS_ISSUE_BODY_LABEL.name,
      color: NEEDS_ISSUE_BODY_LABEL.color,
      description: NEEDS_ISSUE_BODY_LABEL.description,
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
      name: NEEDS_ISSUE_BODY_LABEL.name,
    });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }
}

export async function markInvalidIssue({ github, owner, repo, issue, findings }) {
  await ensureRepositoryLabel(github, owner, repo);
  if (!hasIssueLabel(issue, NEEDS_ISSUE_BODY_LABEL.name)) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issue.number,
      labels: [NEEDS_ISSUE_BODY_LABEL.name],
    });
  }

  const comments = await policyComments(github, owner, repo, issue.number);
  const existing = comments[0];
  const body = buildInvalidIssueComment({ author: issue.user.login, findings });
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
      issue_number: issue.number,
      body,
    });
  }
}

export async function clearInvalidIssue({ github, owner, repo, issue }) {
  await removeLabel(github, owner, repo, issue.number);
  const comments = await policyComments(github, owner, repo, issue.number);
  for (const comment of comments) {
    await github.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: comment.id,
    });
  }
}
