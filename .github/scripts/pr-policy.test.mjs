import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PULL_REQUEST_DISPOSITION,
  pullRequestDisposition,
  reconcilePullRequest,
} from './pr-policy.mjs';

const BYPASS_LABEL = 'status:pr-policy-bypass';
const EXPIRED_LABEL = 'status:pr-policy-expired';
const NEEDS_ATTENTION_LABEL = 'status:needs-pr-attention';

const validBody = `## Related issue

Closes #121

## Problem / pressure

Policy state was duplicated.

## Summary

Use one policy state.

## Test plan

Run policy tests.

## Context handoff

<!-- context-handoff:begin -->

### Instructions for reviewing agents

- **Review focus:** Check policy transitions.
- **Decisions to challenge:** Confirm bypass semantics.
- **Plausible failures / evidence gaps:** API calls use fakes.

### Authoring context

- **User goal / directives:** Simplify PR policy.
- **Constraints / non-goals:** Never execute fork code.
- **Risk-bearing decisions:** Repository identity classifies PRs.
- **Destructive or irreversible behavior:** Expired PRs close.
- **Deliberately not done or tested:** No live API writes.
- **Unknowns / confidence:** Policy behavior is deterministic.

<!-- context-handoff:end -->
`;

const internalPullRequest = {
  author_association: 'NONE',
  base: { ref: 'main', repo: { id: 100, full_name: 'LodyAI/Lody' } },
  head: { repo: { id: 100, full_name: 'LodyAI/Lody' } },
  labels: [],
  additions: 20,
  deletions: 5,
  body: '',
  number: 42,
  state: 'open',
  user: { login: 'contributor' },
};

const externalPullRequest = {
  ...internalPullRequest,
  head: { repo: { id: 200, full_name: 'contributor/Lody' } },
};

function apiError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function createGithub({ comments = [], latestPullRequest = null } = {}) {
  const activity = {
    addedLabels: [],
    createdComments: [],
    deletedComments: [],
    pullUpdates: [],
    removedLabels: [],
    updatedComments: [],
  };
  const repositoryLabels = new Map();
  let nextCommentId = 100;
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        addLabels: async (input) => activity.addedLabels.push(input),
        createComment: async (input) => {
          const comment = {
            id: nextCommentId++,
            body: input.body,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          };
          comments.push(comment);
          activity.createdComments.push(input);
          return { data: comment };
        },
        createLabel: async (input) => repositoryLabels.set(input.name, { ...input }),
        deleteComment: async (input) => {
          activity.deletedComments.push(input);
          const index = comments.findIndex((comment) => comment.id === input.comment_id);
          if (index !== -1) {
            comments.splice(index, 1);
          }
        },
        getLabel: async ({ name }) => {
          const label = repositoryLabels.get(name);
          if (!label) {
            throw apiError(404);
          }
          return { data: label };
        },
        listComments: async () => ({ data: comments }),
        removeLabel: async (input) => activity.removedLabels.push(input),
        updateComment: async (input) => {
          activity.updatedComments.push(input);
          const comment = comments.find((candidate) => candidate.id === input.comment_id);
          if (comment) {
            comment.body = input.body;
          }
          return { data: comment };
        },
        updateLabel: async (input) => repositoryLabels.set(input.name, { ...input }),
      },
      pulls: {
        get: async () => ({ data: latestPullRequest }),
        update: async (input) => activity.pullUpdates.push(input),
      },
    },
  };
  return { activity, github };
}

void describe('pull request disposition', () => {
  void it('uses source repository identity with bot and bypass precedence', () => {
    assert.equal(pullRequestDisposition(internalPullRequest), PULL_REQUEST_DISPOSITION.INTERNAL);
    assert.equal(
      pullRequestDisposition({ ...externalPullRequest, author_association: 'OWNER' }),
      PULL_REQUEST_DISPOSITION.EXTERNAL
    );
    assert.equal(
      pullRequestDisposition({ ...externalPullRequest, head: { repo: null } }),
      PULL_REQUEST_DISPOSITION.EXTERNAL
    );
    assert.equal(
      pullRequestDisposition({ ...externalPullRequest, user: { login: 'renovate[bot]' } }),
      PULL_REQUEST_DISPOSITION.BOT
    );
    assert.equal(
      pullRequestDisposition({
        ...internalPullRequest,
        labels: [{ name: BYPASS_LABEL }],
      }),
      PULL_REQUEST_DISPOSITION.BYPASS
    );
  });
});

void describe('pull request validation', () => {
  void it('reports the size context through the same validation result', async () => {
    const { github } = createGithub();
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest: { ...externalPullRequest, additions: 200, deletions: 1 },
      defaultBranch: 'main',
    });

    assert.equal(result.state, 'invalid');
    assert.ok(result.validation.findings.some((finding) => finding.includes('PR body is empty')));
    assert.ok(result.validation.findings.some((finding) => finding.includes('changes 201 lines')));
  });
});

void describe('pull request reconciliation', () => {
  void it('leaves an internal PR without managed state completely untouched', async () => {
    const { activity, github } = createGithub();
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest: internalPullRequest,
      defaultBranch: 'main',
    });

    assert.equal(result.disposition, PULL_REQUEST_DISPOSITION.INTERNAL);
    assert.equal(result.state, 'skipped');
    assert.deepEqual(activity, {
      addedLabels: [],
      createdComments: [],
      deletedComments: [],
      pullUpdates: [],
      removedLabels: [],
      updatedComments: [],
    });
  });

  void it('normalizes an internal Issue reference without enforcing the template', async () => {
    const { activity, github } = createGithub();
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest: { ...internalPullRequest, body: '## Related issue\n\n#121\n' },
      defaultBranch: 'main',
    });

    assert.equal(result.state, 'skipped');
    assert.deepEqual(activity.pullUpdates, [
      {
        owner: 'LodyAI',
        repo: 'Lody',
        pull_number: 42,
        body: '## Related issue\n\nCloses #121\n',
      },
    ]);
  });

  void it('makes bypass hands-off while clearing prior enforcement state', async () => {
    const comments = [
      {
        id: 7,
        body: '<!-- lody-pr-size-policy -->\nLegacy policy feedback.',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ];
    const { activity, github } = createGithub({ comments });
    const pullRequest = {
      ...externalPullRequest,
      body: '## Related issue\n\n#121\n',
      labels: [{ name: BYPASS_LABEL }],
    };
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest,
      defaultBranch: 'main',
    });

    assert.equal(result.disposition, PULL_REQUEST_DISPOSITION.BYPASS);
    assert.equal(result.state, 'skipped');
    assert.deepEqual(activity.pullUpdates, []);
    assert.deepEqual(
      activity.deletedComments.map((input) => input.comment_id),
      [7]
    );
    assert.ok(activity.removedLabels.some((input) => input.name === NEEDS_ATTENTION_LABEL));
    assert.ok(activity.removedLabels.every((input) => input.name !== BYPASS_LABEL));
  });

  void it('puts an invalid external PR into one attention state', async () => {
    const { activity, github } = createGithub();
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest: externalPullRequest,
      defaultBranch: 'main',
      now: new Date('2026-08-30T00:00:00.000Z'),
    });

    assert.equal(result.state, 'invalid');
    assert.deepEqual(activity.addedLabels.at(-1).labels, [NEEDS_ATTENTION_LABEL]);
    assert.match(activity.createdComments[0].body, /invalid-since="2026-08-30T00:00:00.000Z"/);
    assert.match(activity.createdComments[0].body, /PR body is empty/);
  });

  void it('clears attention after an external PR becomes valid', async () => {
    const comments = [
      {
        id: 10,
        body: '<!-- lody-pr-policy invalid-since="2026-08-20T00:00:00.000Z" -->',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ];
    const { activity, github } = createGithub({ comments });
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest: {
        ...externalPullRequest,
        body: validBody,
        labels: [{ name: NEEDS_ATTENTION_LABEL }],
      },
      defaultBranch: 'main',
    });

    assert.equal(result.state, 'valid');
    assert.ok(activity.removedLabels.some((input) => input.name === NEEDS_ATTENTION_LABEL));
    assert.deepEqual(
      activity.deletedComments.map((input) => input.comment_id),
      [10]
    );
  });

  void it('keeps an expired external PR closed', async () => {
    const pullRequest = {
      ...externalPullRequest,
      labels: [{ name: EXPIRED_LABEL }],
    };
    const { activity, github } = createGithub();
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest,
      defaultBranch: 'main',
    });

    assert.equal(result.state, 'expired');
    assert.ok(
      activity.pullUpdates.some(
        (input) => input.pull_number === pullRequest.number && input.state === 'closed'
      )
    );
  });

  void it('expires an overdue invalid PR after revalidating its current state', async () => {
    const invalidSince = '2026-08-20T00:00:00.000Z';
    const pullRequest = {
      ...externalPullRequest,
      labels: [{ name: 'status:needs-pr-body' }],
    };
    const latestPullRequest = {
      ...pullRequest,
      labels: [{ name: NEEDS_ATTENTION_LABEL }],
    };
    const comments = [
      {
        id: 8,
        body: `<!-- lody-pr-body-format-check invalid-since="${invalidSince}" -->`,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ];
    const { activity, github } = createGithub({ comments, latestPullRequest });
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest,
      defaultBranch: 'main',
      expireOverdue: true,
      now: new Date('2026-08-30T00:00:00.000Z'),
    });

    assert.equal(result.state, 'expired');
    assert.ok(
      activity.pullUpdates.some(
        (input) => input.pull_number === pullRequest.number && input.state === 'closed'
      )
    );
    assert.ok(
      activity.updatedComments.some((input) =>
        input.body.includes('<!-- lody-pr-policy-expired -->')
      )
    );
  });

  void it('does not expire a PR that gains bypass during the final recheck', async () => {
    const invalidSince = '2026-08-20T00:00:00.000Z';
    const pullRequest = {
      ...externalPullRequest,
      labels: [{ name: NEEDS_ATTENTION_LABEL }],
    };
    const latestPullRequest = {
      ...pullRequest,
      labels: [{ name: NEEDS_ATTENTION_LABEL }, { name: BYPASS_LABEL }],
    };
    const comments = [
      {
        id: 9,
        body: `<!-- lody-pr-policy invalid-since="${invalidSince}" -->`,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ];
    const { activity, github } = createGithub({ comments, latestPullRequest });
    const result = await reconcilePullRequest({
      github,
      owner: 'LodyAI',
      repo: 'Lody',
      pullRequest,
      defaultBranch: 'main',
      expireOverdue: true,
      now: new Date('2026-08-30T00:00:00.000Z'),
    });

    assert.equal(result.state, 'invalid');
    assert.ok(!activity.pullUpdates.some((input) => input.state === 'closed'));
    assert.ok(!activity.addedLabels.some((input) => input.labels.includes(EXPIRED_LABEL)));
  });
});
