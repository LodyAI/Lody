import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkPullRequestBody } from './check-pr-body.mjs';

const templateUrl = new URL('../PULL_REQUEST_TEMPLATE.md', import.meta.url);
const template = readFileSync(templateUrl, 'utf8');
const originalPromptPlaceholder = '<!-- Paste the triggering user\'s original prompt here, verbatim. -->';
const originalPrompt = 'Keep the original user prompt in the PR body so reviewers can verify intent.';

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
    .replace(
      /(- \*\*[^\n]+?:\*\*)\s*<!--[^\n]*-->/g,
      '$1 Reviewed local routing only; no runtime behavior changes.'
    )
    .replace(originalPromptPlaceholder, originalPrompt);
}

void test('the unedited template is not a valid PR body', () => {
  const result = checkPullRequestBody(template);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.startsWith('## Summary must contain')));
});

void test('guidance stays in comments, so it cannot pass as a filled field', () => {
  const visible = template.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/[^\s|\-#]/.test(visible.split('## Summary')[1].split('##')[0]), false);
});

void test('every repository path the template names resolves', () => {
  const referenced = [...template.matchAll(/(?:^|\s)((?:\.[\w-]+|[\w-]+)(?:\/[\w.-]+)+\.md)/gm)].map(
    (match) => match[1]
  );
  assert.ok(referenced.length > 0, 'template should point authors at guidance');
  for (const target of referenced) {
    assert.ok(existsSync(new URL(`../../${target}`, import.meta.url)), `missing ${target}`);
  }
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
    '### Instructions for reviewing agents',
    '### Authoring context',
    '### Original user prompt',
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
