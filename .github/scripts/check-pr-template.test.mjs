import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkPullRequestBody } from './check-pr-body.mjs';

const templateUrl = new URL('../PULL_REQUEST_TEMPLATE.md', import.meta.url);
const template = readFileSync(templateUrl, 'utf8');

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

void test('an author who fills every required field passes', () => {
  const body = template
    .replace('## Related issue', '## Related issue\n\nRefs #123')
    .replace(
      '## Problem / pressure',
      '## Problem / pressure\n\nRepeated routing errors obscure ownership.'
    )
    .replace('## Summary', '## Summary\n\nDocument the local route and state owner.')
    .replace('## Test plan', '## Test plan\n\nChecked the routing example against source.')
    .replace(
      /(- \*\*[^\n]+?:\*\*)\s*<!--[^\n]*-->/g,
      '$1 Reviewed local routing only; no runtime behavior changes.'
    );
  const result = checkPullRequestBody(body);
  assert.equal(result.ok, true, result.findings.join('\n'));
});
