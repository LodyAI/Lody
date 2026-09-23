import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractFaqFromMdx, faqPlainText } from '../scripts/extract-docs-faq.mjs';
import { docsFaqByPath } from './docs-faq.generated.ts';
import { faqJsonLd } from './json-ld.ts';
import { pageHead } from './metadata.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readDoc(relativePath: string) {
  return readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

await test('faqPlainText strips emphasis and internal links', () => {
  assert.equal(
    faqPlainText('See [Copy Conversations](/docs/copy-md) and a *new* **existing** session.'),
    'See Copy Conversations and a new existing session.'
  );
});

await test('extractFaqFromMdx reads ### questions under FAQ', () => {
  const items = extractFaqFromMdx(`---
title: Example
description: Example
---

# Example

## FAQ

### Can I share a session?

Yes, if it runs in a Lody workspace.

### Can I send a transcript instead?

Yes. That does not continue the live session.
`);

  assert.deepEqual(
    items.map((item) => item.question),
    ['Can I share a session?', 'Can I send a transcript instead?']
  );
  assert.match(items[0]?.answer ?? '', /Lody workspace/u);
});

await test('extractFaqFromMdx ignores pages without an FAQ section', () => {
  assert.deepEqual(extractFaqFromMdx('# Sessions\n\nA session is the basic unit.\n'), []);
});

await test('session-handoff English FAQ matches the page and emits FAQPage JSON-LD', () => {
  const fromMdx = extractFaqFromMdx(readDoc('content/docs/en/(features)/session-handoff.mdx'));
  const items = docsFaqByPath['/docs/session-handoff'] ?? [];
  assert.equal(items.length, 5);
  assert.deepEqual(items, fromMdx);
  assert.equal(items[0]?.question, 'Can I share a Claude Code session so a teammate continues it?');
  assert.match(items[0]?.answer ?? '', /Lody workspace/u);
  assert.match(items[1]?.answer ?? '', /viewable record/u);
  assert.doesNotMatch(items[1]?.answer ?? '', /\*[^*]+\*/u);
  assert.match(items[4]?.answer ?? '', /Copy as Markdown/u);

  const jsonLd = faqJsonLd(items);
  assert.equal(jsonLd?.['@type'], 'FAQPage');
  assert.equal(Array.isArray(jsonLd?.mainEntity) && jsonLd.mainEntity.length, 5);

  const head = pageHead({
    title: 'Share a Coding Agent Session | Lody',
    path: '/docs/session-handoff',
    locale: 'en-US',
    jsonLd,
  });
  const script = head.scripts?.[0];
  assert.equal(script?.type, 'application/ld+json');
  assert.match(script?.children ?? '', /"@type":"FAQPage"/u);
  assert.equal(
    head.meta.some((entry) => entry.name === 'robots' && /noindex/u.test(entry.content ?? '')),
    false
  );
});

await test('session-handoff Chinese FAQ matches the page', () => {
  const fromMdx = extractFaqFromMdx(readDoc('content/docs/zh/(features)/session-handoff.mdx'));
  const items = docsFaqByPath['/zh/docs/session-handoff'] ?? [];
  assert.equal(items.length, 5);
  assert.deepEqual(items, fromMdx);
  assert.equal(items[0]?.question, '能不能把 Claude Code 会话交给同事接着做？');
  assert.match(items[0]?.answer ?? '', /Lody 工作空间/u);
  assert.match(items[4]?.answer ?? '', /Copy as Markdown/u);
});
