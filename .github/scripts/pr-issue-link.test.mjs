import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasRelatedIssueLink, normalizeRelatedIssueLink } from './pr-issue-link.mjs';

const body = (reference) => `## Related issue

${reference}

## Summary

Focused change.
`;

void describe('pull request issue links', () => {
  void it('defaults bare references and full Lody issue URLs to closing links', () => {
    assert.match(normalizeRelatedIssueLink(body('#121')), /\nCloses #121\n/);
    assert.match(
      normalizeRelatedIssueLink(body('https://github.com/LodyAI/Lody/issues/122')),
      /\nCloses #122\n/
    );
  });

  void it('preserves explicit closing and non-closing intent', () => {
    assert.equal(normalizeRelatedIssueLink(body('Fixes #121')), body('Fixes #121'));
    assert.equal(normalizeRelatedIssueLink(body('Refs #121')), body('Refs #121'));
    assert.match(
      normalizeRelatedIssueLink(body('Refs https://github.com/LodyAI/Lody/issues/121')),
      /\nRefs #121\n/
    );
  });

  void it('does not infer issue links from other sections or prose', () => {
    const prose = body('Discussed in https://github.com/LodyAI/Lody/issues/121');
    assert.equal(normalizeRelatedIssueLink(prose), prose);
    assert.equal(
      normalizeRelatedIssueLink('## Summary\n\nhttps://github.com/LodyAI/Lody/issues/121\n'),
      '## Summary\n\nhttps://github.com/LodyAI/Lody/issues/121\n'
    );
  });

  void it('recognizes every supported related-issue form', () => {
    for (const reference of [
      '#121',
      'LodyAI/Lody#121',
      'Closes #121',
      'Refs #121',
      'https://github.com/LodyAI/Lody/issues/121',
    ]) {
      assert.equal(hasRelatedIssueLink(body(reference)), true, reference);
    }
    assert.equal(hasRelatedIssueLink(body('Issue 121')), false);
  });

  void it('is idempotent after adding the native closing keyword', () => {
    const normalized = normalizeRelatedIssueLink(body('#121'));
    assert.equal(normalizeRelatedIssueLink(normalized), normalized);
  });
});
