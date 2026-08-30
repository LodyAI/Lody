import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasRelatedIssueLink, normalizeRelatedIssueLink } from './pr-issue-link.mjs';

const body = (reference) => `## Related issue

${reference}

## Summary

Focused change.
`;

void describe('pull request issue links', () => {
  void it('normalizes exact references without changing explicit intent', () => {
    assert.match(normalizeRelatedIssueLink(body('#121')), /\nCloses #121\n/);
    assert.match(
      normalizeRelatedIssueLink(body('https://github.com/LodyAI/Lody/issues/122')),
      /\nCloses #122\n/
    );
    assert.equal(normalizeRelatedIssueLink(body('Fixes #121')), body('Fixes #121'));
    assert.equal(normalizeRelatedIssueLink(body('Refs #121')), body('Refs #121'));
  });

  void it('does not infer issue links from other sections or prose', () => {
    const prose = body('Discussed in https://github.com/LodyAI/Lody/issues/121');
    assert.equal(normalizeRelatedIssueLink(prose), prose);
    assert.equal(
      normalizeRelatedIssueLink('## Summary\n\nhttps://github.com/LodyAI/Lody/issues/121\n'),
      '## Summary\n\nhttps://github.com/LodyAI/Lody/issues/121\n'
    );
    assert.equal(hasRelatedIssueLink(body('LodyAI/Lody#121')), true);
    assert.equal(hasRelatedIssueLink(body('Issue 121')), false);
  });

  void it('is idempotent after adding the native closing keyword', () => {
    const normalized = normalizeRelatedIssueLink(body('#121'));
    assert.equal(normalizeRelatedIssueLink(normalized), normalized);
  });
});
