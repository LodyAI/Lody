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

const validAgentHandoff = `## Agent handoff

<!-- agent-handoff:begin -->

### Instructions for reviewing agents

- **Review focus:** Inspect the target-event workflows and body parser.
- **Decisions to challenge:** Verify that organization membership is the right exemption boundary.
- **Plausible failures / evidence gaps:** A fork-controlled file could execute with a write token; the workflows cannot execute until merged.

### Authoring context

- **User goal / directives:** Make Agent-authored changes easier to review safely.
- **Constraints / non-goals:** Do not publish raw author-side transcripts.
- **Risk-bearing decisions:** Use a write-capable target workflow only with trusted base code.
- **Destructive or irreversible behavior:** None.
- **Deliberately not done or tested:** Remote branch protection is not changed.
- **Unknowns / confidence:** The workflow starts after merge to the default branch.

### Sharing consent (author side)

- [x] Author-side user explicitly allowed publishing the Authoring context above
- [ ] Author-side user explicitly declined publishing Authoring context and understands that maintainers may decline or close the contribution; keep every field as \`N/A\` / redacted

<!-- agent-handoff:end -->`;

const validAgentBody = `${validHumanBody
  .replace(
    '- [ ] I am an Agent (check this if an LLM agent authored this PR)',
    '- [x] I am an Agent (check this if an LLM agent authored this PR)'
  )
  .replace('- [x] I am a human', '- [ ] I am a human')}

${validAgentHandoff}`;

assert.deepEqual(checkPullRequestBody(validHumanBody), {
  ok: true,
  findings: [],
  agent: false,
  human: true,
});

assert.deepEqual(checkPullRequestBody(validAgentBody), {
  ok: true,
  findings: [],
  agent: true,
  human: false,
});

const template = readFileSync(new URL('../PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
assert.deepEqual(checkPullRequestBody(template).findings, [
  'Author type: check exactly one of "I am an Agent" or "I am a human" (`- [x] ...`).',
  '## Problem / pressure must contain meaningful content, not only comments or placeholders.',
  '## Summary must contain meaningful content, not only comments or placeholders.',
  '## Test plan must contain meaningful content, not only comments or placeholders.',
]);

const emptyResult = checkPullRequestBody('');
assert.deepEqual(emptyResult, {
  ok: false,
  findings: ['PR body is empty. Fill `.github/PULL_REQUEST_TEMPLATE.md`.'],
  agent: false,
  human: false,
});

const bothTypesResult = checkPullRequestBody(
  validHumanBody.replace(
    '- [ ] I am an Agent (check this if an LLM agent authored this PR)',
    '- [x] I am an Agent (check this if an LLM agent authored this PR)'
  )
);

const misplacedAuthorTypeResult = checkPullRequestBody(`${validHumanBody.replace(
  '- [x] I am a human',
  '- [ ] I am a human'
)}

- [x] I am a human`);
assert.ok(
  misplacedAuthorTypeResult.findings.includes(
    'Author type: check exactly one of "I am an Agent" or "I am a human" (`- [x] ...`).'
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

const missingConsentResult = checkPullRequestBody(
  validAgentBody.replace(
    '- [x] Author-side user explicitly allowed publishing the Authoring context above',
    '- [ ] Author-side user explicitly allowed publishing the Authoring context above'
  )
);
assert.ok(
  missingConsentResult.findings.includes(
    'Agent sharing consent: ask the author-side user and check exactly one consent option.'
  )
);

const bothConsentResult = checkPullRequestBody(
  validAgentBody.replace(
    '- [ ] Author-side user explicitly declined publishing Authoring context and understands that maintainers may decline or close the contribution; keep every field as `N/A` / redacted',
    '- [x] Author-side user explicitly declined publishing Authoring context and understands that maintainers may decline or close the contribution; keep every field as `N/A` / redacted'
  )
);
assert.ok(
  bothConsentResult.findings.includes(
    'Agent sharing consent: check only one consent option, not both.'
  )
);

const incompleteContextResult = checkPullRequestBody(
  validAgentBody.replace(
    '- **Risk-bearing decisions:** Use a write-capable target workflow only with trusted base code.',
    '- **Risk-bearing decisions:** <!-- Not filled. -->'
  )
);
assert.ok(
  incompleteContextResult.findings.includes(
    'Shared Authoring context must fill **Risk-bearing decisions** with meaningful content.'
  )
);

const incompleteReviewInstructionsResult = checkPullRequestBody(
  validAgentBody.replace(
    '- **Plausible failures / evidence gaps:** A fork-controlled file could execute with a write token; the workflows cannot execute until merged.',
    '- **Plausible failures / evidence gaps:** <!-- Not filled. -->'
  )
);
assert.ok(
  incompleteReviewInstructionsResult.findings.includes(
    'Agent review instructions must fill **Plausible failures / evidence gaps** with PR-specific content.'
  )
);

const oversizedReviewInstructionsResult = checkPullRequestBody(
  validAgentBody.replace('Inspect the target-event workflows and body parser.', 'x'.repeat(1_201))
);
assert.ok(
  oversizedReviewInstructionsResult.findings.includes(
    'Agent review instructions must stay under 1200 characters and include only the highest-value review guidance.'
  )
);

const declinedConsentBody = validAgentBody
  .replace(
    '- [x] Author-side user explicitly allowed publishing the Authoring context above',
    '- [ ] Author-side user explicitly allowed publishing the Authoring context above'
  )
  .replace(
    '- [ ] Author-side user explicitly declined publishing Authoring context and understands that maintainers may decline or close the contribution; keep every field as `N/A` / redacted',
    '- [x] Author-side user explicitly declined publishing Authoring context and understands that maintainers may decline or close the contribution; keep every field as `N/A` / redacted'
  )
  .replace(
    /- \*\*(?:User goal \/ directives|Constraints \/ non-goals|Risk-bearing decisions|Destructive or irreversible behavior|Deliberately not done or tested|Unknowns \/ confidence):\*\*[^\n]*/g,
    (line) => `${line.slice(0, line.indexOf(':**') + 3)} N/A / redacted`
  );
assert.equal(checkPullRequestBody(declinedConsentBody).ok, true);

const leakedDeclinedContextResult = checkPullRequestBody(
  declinedConsentBody.replace(
    '- **User goal / directives:** N/A / redacted',
    '- **User goal / directives:** Publish private author-side instructions.'
  )
);
assert.ok(
  leakedDeclinedContextResult.findings.includes(
    'Declined Authoring context must keep **User goal / directives** empty or redacted.'
  )
);

assert.equal(checkPullRequestBody(validHumanBody.replaceAll('\n', '\r\n')).ok, true);

console.log('PR body checker regression tests passed');
