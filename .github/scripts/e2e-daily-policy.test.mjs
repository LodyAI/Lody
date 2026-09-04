import assert from 'node:assert/strict';
import test from 'node:test';

import { findOwnedDailyFailureIssue, hasCompleteOwnedComment } from './e2e-daily-policy.mjs';

const bot = { login: 'github-actions[bot]', type: 'Bot' };
const outsider = { login: 'outside-reporter', type: 'User' };

void test('selects only the Actions-owned Daily failure Issue', () => {
  const marker = '<!-- desktop-e2e-daily-failure -->';
  const issue = findOwnedDailyFailureIssue(
    [
      { number: 1, body: marker, user: outsider },
      { number: 3, body: marker, user: bot },
      { number: 2, body: marker, user: bot, pull_request: {} },
    ],
    marker
  );
  assert.equal(issue.number, 3);
});

void test('does not let an outsider spoof a completed attachment marker', () => {
  const marker = '<!-- desktop-e2e-daily-failure-run:123:video:LODY-TEST-001 -->';
  const uploaded = 'https://github.com/user-attachments/assets/example';
  assert.equal(
    hasCompleteOwnedComment([{ body: `${marker}\n${uploaded}`, user: outsider }], marker, 1),
    false
  );
});

void test('retries a bot comment until its video reference was uploaded', () => {
  const marker = '<!-- desktop-e2e-daily-failure-run:123:video:LODY-TEST-001 -->';
  const localReference = '![](daily-evidence/scenarios/lody-test-001/failure.webm)';
  assert.equal(
    hasCompleteOwnedComment([{ body: `${marker}\n${localReference}`, user: bot }], marker, 1),
    false
  );
  assert.equal(
    hasCompleteOwnedComment(
      [
        {
          body: `${marker}\nhttps://github.com/user-attachments/assets/example`,
          user: bot,
        },
      ],
      marker,
      1
    ),
    true
  );
});

void test('accepts one bot-owned summary comment when no video exists', () => {
  const marker = '<!-- desktop-e2e-daily-failure-run:123:summary -->';
  assert.equal(hasCompleteOwnedComment([{ body: marker, user: bot }], marker, 0), true);
});
