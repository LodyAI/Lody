import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { slugFromMdxFile } from './site-paths.mjs';
import { LLMS_ANSWERS } from './llms-answers.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsEnRoot = path.join(packageRoot, 'content', 'docs', 'en');

await test('llms answer blocks cover the GEO questions and only link live docs', async () => {
  const { readdirSync } = await import('node:fs');
  const questions = LLMS_ANSWERS.map((block) => block.question);

  assert.ok(questions.some((question) => /hand off a coding agent session/iu.test(question)));
  assert.ok(questions.some((question) => /parallel/iu.test(question)));
  assert.ok(questions.some((question) => /Claude.*Kimi.*DeepSeek|ACP/iu.test(question)));

  for (const block of LLMS_ANSWERS) {
    assert.ok(block.answer.length > 80, `answer too short: ${block.question}`);
    assert.doesNotMatch(block.answer, /\/docs\/parallel-agents/u);
    assert.doesNotMatch(block.answer, /\/blog\/handoff-claude-code-session/u);
    assert.ok(block.links.length >= 2, `expected docs links for: ${block.question}`);

    for (const link of block.links) {
      assert.ok(link.sitePath.startsWith('/docs/'), `expected a docs path: ${link.sitePath}`);
      assert.notEqual(link.sitePath, '/docs/parallel-agents');

      const stack = [docsEnRoot];
      let found = false;
      while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(entryPath);
          } else if (
            entry.name.endsWith('.mdx') &&
            `/docs/${slugFromMdxFile(entryPath, docsEnRoot)}` === link.sitePath
          ) {
            found = true;
          }
        }
      }
      assert.ok(found, `missing docs page for ${link.sitePath}`);
    }
  }

  const handoff = LLMS_ANSWERS.find((block) => /hand off/iu.test(block.question));
  assert.ok(handoff?.links.some((link) => link.sitePath === '/docs/session-handoff'));
  assert.ok(existsSync(path.join(docsEnRoot, '(features)', 'session-handoff.mdx')));
});
