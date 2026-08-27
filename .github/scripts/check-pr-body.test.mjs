import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkPullRequestBody } from './check-pr-body.mjs';

const validHumanBody = `## Author type

- [ ] I am an Agent (check this if an LLM agent authored this PR)
- [x] I am a human

## Problem / pressure

Reviewers could not identify whether an Agent or a human authored a PR.

## Summary

Require every external author to identify its author type.

## Test plan

Run pnpm check:github-config.`;

assert.deepEqual(checkPullRequestBody(validHumanBody), {
  ok: true,
  findings: [],
  agent: false,
  human: true,
});

const template = readFileSync(new URL('../PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
assert.deepEqual(checkPullRequestBody(template).findings, [
  'Author type: check exactly one of "I am an Agent" or "I am a human" (`- [x] ...`).',
  '## Problem / pressure must contain meaningful content, not only comments or placeholders.',
  '## Summary must contain meaningful content, not only comments or placeholders.',
  '## Test plan must contain meaningful content, not only comments or placeholders.',
]);

const validAgentBody = `${validHumanBody
  .replace(
    '- [ ] I am an Agent (check this if an LLM agent authored this PR)',
    '- [x] I am an Agent (check this if an LLM agent authored this PR)'
  )
  .replace('- [x] I am a human', '- [ ] I am a human')}

## Agent handoff

<!-- agent-handoff:begin -->

### Instructions for reviewing agents

Review the pressure before the implementation.

### Authoring context

- User requested Agent authorship identification.

### Sharing consent (author side)

- [x] Author-side user allowed putting directive context in this PR for review assistance

<!-- agent-handoff:end -->`;

assert.deepEqual(checkPullRequestBody(validAgentBody), {
  ok: true,
  findings: [],
  agent: true,
  human: false,
});

const emptyResult = checkPullRequestBody('');
assert.equal(emptyResult.ok, false);
assert.deepEqual(emptyResult.findings, [
  'PR body is empty. Fill `.github/PULL_REQUEST_TEMPLATE.md`.',
]);

const bothTypesResult = checkPullRequestBody(
  validHumanBody.replace(
    '- [ ] I am an Agent (check this if an LLM agent authored this PR)',
    '- [x] I am an Agent (check this if an LLM agent authored this PR)'
  )
);
assert.ok(
  bothTypesResult.findings.includes('Author type: check only one of Agent or human, not both.')
);

const missingSectionResult = checkPullRequestBody(
  validHumanBody.replace('## Test plan\n\nRun pnpm check:github-config.', '')
);
assert.ok(missingSectionResult.findings.includes('Missing required heading: ## Test plan'));

const duplicateResult = checkPullRequestBody(
  validHumanBody.replace(
    '## Summary\n\nRequire every external author to identify its author type.',
    '## Summary\n\nFirst summary.\n\n## Summary\n\nSecond summary.'
  )
);
assert.ok(
  duplicateResult.findings.includes(
    'Duplicate required section: ## Summary appears 2 times; each required section must appear exactly once.'
  )
);

const missingHandoffResult = checkPullRequestBody(
  validHumanBody
    .replace(
      '- [ ] I am an Agent (check this if an LLM agent authored this PR)',
      '- [x] I am an Agent (check this if an LLM agent authored this PR)'
    )
    .replace('- [x] I am a human', '- [ ] I am a human')
);
assert.ok(missingHandoffResult.findings.includes('Agent PRs must include ## Agent handoff.'));
assert.ok(
  missingHandoffResult.findings.includes(
    'Agent PRs must keep <!-- agent-handoff:begin/end --> markers.'
  )
);

assert.equal(checkPullRequestBody(validHumanBody.replaceAll('\n', '\r\n')).ok, true);

console.log('PR body checker regression tests passed');
