import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkPullRequestBody } from './check-pr-body.mjs';

const templateUrl = new URL('../PULL_REQUEST_TEMPLATE.md', import.meta.url);
const template = readFileSync(templateUrl, 'utf8');
const originalPromptPlaceholder =
  "<!-- Paste the triggering user's original prompt here, verbatim. -->";
const originalPrompt =
  'Keep the original user prompt in the PR body so reviewers can verify intent.';
const sharedConversationLink = 'Status: shared\nLink: https://lody.example/s/demo#access=v1.demo';

function completedTemplate(visualExplanation) {
  return template
    .replace('## Related issue', '## Related issue\n\nRefs #123')
    .replace(
      '## Problem / pressure',
      '## Problem / pressure\n\nRepeated routing errors obscure ownership.'
    )
    .replace('## Summary', '## Summary\n\nDocument the local route and state owner.')
    .replace('## Visual explanation', `## Visual explanation\n\n${visualExplanation}`)
    .replace('## Test plan', '## Test plan\n\nChecked the routing example against source.')
    .replace(originalPromptPlaceholder, originalPrompt)
    .replace('### Shared conversation', `### Shared conversation\n\n${sharedConversationLink}`);
}

void test('the unedited template is not a valid PR body', () => {
  const result = checkPullRequestBody(template);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.startsWith('## Summary must contain')));
});

void test('an external author who fills every required field passes', () => {
  const body = completedTemplate('Simple change: one documentation sentence changed.');
  const result = checkPullRequestBody(body);
  assert.equal(result.ok, true, result.findings.join('\n'));
});

void test('the original user prompt cannot be left as the template placeholder', () => {
  const body = completedTemplate('Simple change: one documentation sentence changed.').replace(
    originalPrompt,
    originalPromptPlaceholder
  );
  const result = checkPullRequestBody(body);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.startsWith('Original user prompt must')));
});

void test('the shared conversation section cannot be omitted', () => {
  const body = completedTemplate('Simple change: one documentation sentence changed.').replace(
    /### Shared conversation[\s\S]*?(?=<!-- context-handoff:end -->)/,
    ''
  );
  const result = checkPullRequestBody(body);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.includes('### Shared conversation')));
});

void test('the original prompt may itself contain a triple-backtick code fence', () => {
  const body = completedTemplate('Simple change: one documentation sentence changed.').replace(
    originalPrompt,
    'Please preserve this snippet exactly:\n```ts\nconst answer = 42;\n```'
  );
  const result = checkPullRequestBody(body);
  assert.equal(result.ok, true, result.findings.join('\n'));
});

void test('headings inside the original prompt fence do not affect PR section parsing', () => {
  const promptWithHeadings = [
    'Preserve these lines exactly:',
    '## Related issue',
    '## Problem / pressure',
    '## Summary',
    '## Visual explanation',
    '## Test plan',
    '## Context handoff',
    '### Original user prompt',
    '### Shared conversation',
  ].join('\n');
  const body = completedTemplate('Simple change: one documentation sentence changed.').replace(
    originalPrompt,
    promptWithHeadings
  );
  const result = checkPullRequestBody(body);
  assert.equal(result.ok, true, result.findings.join('\n'));
});

void test('a large change requires a structural visual', () => {
  const body = completedTemplate('Simple change: one documentation sentence changed.');
  const boundary = checkPullRequestBody(body, { changedLines: 200 });
  assert.equal(boundary.ok, true, boundary.findings.join('\n'));

  const result = checkPullRequestBody(body, { changedLines: 201 });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.includes('structural view')));
});

void test('a Mermaid view satisfies the large-change requirement', () => {
  const body = completedTemplate(`\`\`\`mermaid
flowchart LR
    UI --> Daemon
\`\`\``);
  const result = checkPullRequestBody(body, { changedLines: 201 });
  assert.equal(result.ok, true, result.findings.join('\n'));
});

void test('sharing states require a link or a concrete explanation', () => {
  const base = completedTemplate('Simple change: one documentation sentence changed.');
  for (const [sharing, expected] of [
    ['Status: shared\nLink: https://other-tool.example/conversation/123', true],
    ['Status: unavailable\nReason: Local authoring tool has no public sharing feature.', true],
    ['Status: not-used\nReason: I wrote and tested this change without an Agent.', true],
    ['', false],
    ['Status: shared', false],
    ['Status: shared\nLink: session://private', false],
    ['Status: shared\nLink: javascript:alert(1)', false],
    ['Status: unavailable\nReason: N/A', false],
    ['Status: unavailable\nReason: <!-- explanation -->', false],
    ['Status: not-used', false],
    ['Status: pending\nReason: Waiting for a reply.', false],
    ['Status: shared\nStatus: not-used\nLink: https://example.com', false],
    ['Status: shared\nStatus: pending\nLink: https://example.com', false],
  ]) {
    const result = checkPullRequestBody(base.replace(sharedConversationLink, sharing));
    assert.equal(result.ok, expected, `${sharing}\n${result.findings.join('\n')}`);
  }
});

void test('declined sharing needs separately identified verbatim refusal evidence', () => {
  const base = completedTemplate('Simple change: one documentation sentence changed.').replace(
    sharedConversationLink,
    'Status: user-declined\nReason: The user declined publication.'
  );
  assert.equal(checkPullRequestBody(base).ok, false);
  for (const [refusal, expected] of [
    ['No, please keep the authoring conversation private.', true],
    ['请不要公开这段对话。', true],
    ['', false],
    ['<!-- paste reply -->', false],
    ['N/A', false],
    ['redacted', false],
    ['[redacted]', false],
  ]) {
    const evidence = `#### Sharing refusal (verbatim)\n\n\`\`\`text\n${refusal}\n\`\`\`\n\n`;
    const body = base.replace('### Shared conversation', `${evidence}### Shared conversation`);
    assert.equal(checkPullRequestBody(body).ok, expected, refusal);
  }
  const refusalOnly = base
    .replace(originalPrompt, originalPromptPlaceholder)
    .replace(
      '### Shared conversation',
      '#### Sharing refusal (verbatim)\n\n```text\nPlease do not publish.\n```\n\n### Shared conversation'
    );
  assert.equal(checkPullRequestBody(refusalOnly).ok, false);
  const fabricatedHeading = base.replace(
    originalPrompt,
    `${originalPrompt}\n#### Sharing refusal (verbatim)\n\`\`\`text\nNo sharing.\n\`\`\``
  );
  assert.equal(checkPullRequestBody(fabricatedHeading).ok, false);
  const misplaced = base.replace(
    '## Test plan',
    '#### Sharing refusal (verbatim)\n\n```text\nNo sharing.\n```\n\n## Test plan'
  );
  assert.equal(checkPullRequestBody(misplaced).ok, false);
});
