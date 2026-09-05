import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canCloseDailyFailureIssue,
  findDailyEvidenceArtifact,
  findOwnedDailyFailureIssue,
  findPrEvidenceArtifact,
  hasCompleteOwnedComment,
} from './e2e-daily-policy.mjs';

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

void test('identifies the suite from the exact Daily evidence artifact', () => {
  assert.deepEqual(
    findDailyEvidenceArtifact([{ id: 7, name: 'desktop-e2e-daily-full-123', expired: false }], 123),
    {
      artifact: { id: 7, name: 'desktop-e2e-daily-full-123', expired: false },
      suite: 'full',
    }
  );
  assert.equal(
    findDailyEvidenceArtifact([{ id: 8, name: 'desktop-e2e-daily-smoke-123', expired: false }], 123)
      ?.suite,
    'smoke'
  );
});

void test('treats legacy Daily artifacts as evidence without assuming their suite', () => {
  assert.equal(
    findDailyEvidenceArtifact([{ id: 9, name: 'desktop-e2e-daily-123', expired: false }], 123)
      ?.suite,
    'unknown'
  );
});

void test('rejects ambiguous and expired Daily evidence artifacts', () => {
  assert.equal(
    findDailyEvidenceArtifact(
      [
        { id: 7, name: 'desktop-e2e-daily-full-123', expired: false },
        { id: 8, name: 'desktop-e2e-daily-smoke-123', expired: false },
      ],
      123
    ),
    undefined
  );
  assert.equal(
    findDailyEvidenceArtifact([{ id: 7, name: 'desktop-e2e-daily-full-123', expired: true }], 123),
    undefined
  );
});

void test('only a successful full Daily can close the shared failure Issue', () => {
  assert.equal(canCloseDailyFailureIssue('success', 'full'), true);
  assert.equal(canCloseDailyFailureIssue('success', 'smoke'), false);
  assert.equal(canCloseDailyFailureIssue('success', 'unknown'), false);
  assert.equal(canCloseDailyFailureIssue('failure', 'full'), false);
});

void test('identifies one exact PR evidence artifact and rejects ambiguity', () => {
  assert.equal(
    findPrEvidenceArtifact([{ id: 10, name: 'desktop-e2e-full-123', expired: false }], 123)?.suite,
    'full'
  );
  assert.equal(
    findPrEvidenceArtifact(
      [
        { id: 10, name: 'desktop-e2e-full-123', expired: false },
        { id: 11, name: 'desktop-e2e-smoke-123', expired: false },
      ],
      123
    ),
    undefined
  );
});
