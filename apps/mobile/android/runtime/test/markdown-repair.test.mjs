import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildMarkdownRepair } from '../src/markdown-repair.mjs';

// Runs the exact asset QuickJS loads, in a bare context with no host APIs.
const script = await buildMarkdownRepair();
const sandbox = vm.createContext({});
vm.runInContext(script, sandbox);
const repair = (text) => sandbox.repairMarkdown(text);

test('closes unfinished inline syntax while streaming', () => {
  assert.equal(repair('Use **bold'), 'Use **bold**');
  assert.equal(repair('Call `openSession'), 'Call `openSession`');
});

test('leaves an open code fence to CommonMark and does not repair inside it', () => {
  // An unclosed fence already renders as code to the end of the document.
  assert.equal(repair('```kotlin\nval x = 1'), '```kotlin\nval x = 1');
  assert.equal(repair('```js\nconst a = 2 ** 3'), '```js\nconst a = 2 ** 3');
});

test('leaves complete Markdown untouched', () => {
  const done = '# Title\n\n- **one**\n- `two`\n\n```js\nx()\n```\n';
  assert.equal(repair(done), done);
});

test('keeps disabled repairs off (links stay text, no KaTeX)', () => {
  assert.equal(repair('See [docs'), 'See docs');
  assert.equal(repair('cost $5'), 'cost $5');
});

test('iOS and Android pin the same remend', async () => {
  const android = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).dependencies.remend;
  const ios = JSON.parse(await readFile(new URL('../../../ios/apps/ios/package.json', import.meta.url))).dependencies.remend;
  assert.equal(android, ios);
});
