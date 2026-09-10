import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAnchors } from './anchors.mjs';

const prefix = '// @dec:specs/flow\n';
test('hashes the complete TS declaration, including return types and template expressions', () => {
  const source =
    prefix +
    'export function run(): { value: string } {\n  return { value: `hello ${"}"}` };\n}\nconst unrelated = 1;';
  const [original] = extractAnchors('apps/flow.ts', source);
  assert.equal(
    extractAnchors('apps/flow.ts', source.replace('unrelated = 1', 'unrelated = 2'))[0].hash,
    original.hash
  );
  assert.notEqual(
    extractAnchors('apps/flow.ts', source.replace('hello', 'goodbye'))[0].hash,
    original.hash
  );
  assert.equal(
    extractAnchors('apps/flow.ts', source.replace(' };', ' };   '))[0].hash,
    original.hash
  );
});
test('handles TSX, a class method, and regex braces without truncating their bodies', () => {
  const jsx =
    prefix + 'export function View() { return <div>{ /}/.test("}") ? "yes" : "no" }</div>; }';
  assert.notEqual(
    extractAnchors('apps/view.tsx', jsx)[0].hash,
    extractAnchors('apps/view.tsx', jsx.replace('"no"', '"never"'))[0].hash
  );
  const method = 'class Store {\n' + prefix + 'save() { return 1; }\nother() { return 2; }\n}';
  assert.equal(
    extractAnchors('apps/store.ts', method)[0].hash,
    extractAnchors('apps/store.ts', method.replace('return 2', 'return 3'))[0].hash
  );
});
test('rejects dangling and malformed markers and invalid syntax', () => {
  assert.throws(() => extractAnchors('apps/flow.ts', prefix), /following declaration/);
  assert.throws(
    () => extractAnchors('apps/flow.ts', '// @dec:specs/flow extra\nconst x = 1;'),
    /use \/\//
  );
  assert.throws(() => extractAnchors('apps/flow.ts', prefix + 'function f( {'), /cannot parse/);
});
test('ordinary marker-like text in literals does not register an anchor', () => {
  assert.deepEqual(extractAnchors('apps/flow.ts', 'const text = `\n// @dec:specs/flow\n`;'), []);
});
