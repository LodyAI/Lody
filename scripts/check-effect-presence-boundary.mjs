#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Static boundary guard, complementary to real cancellation/cleanup acceptance.
// Concrete upstream composition and the one presence-legacy entry are excluded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'apps/cli/src/lib/loro/workspace-presence.ts',
  'apps/cli/src/lib/loro/presence-replica.ts',
];
const forbidden = new Set([
  'Promise',
  'AbortController',
  'ManagedRuntime',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
]);
const launches = new Set([
  'runPromise',
  'runPromiseExit',
  'runFork',
  'runForkWith',
  'runSync',
  'runSyncExit',
  'runPromiseWith',
  'runPromiseExitWith',
  'runSyncWith',
  'runSyncExitWith',
  'squash',
]);
let failures = 0;
for (const file of files) {
  const text = await readFile(path.join(root, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const fail = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    console.error(`${file}:${line + 1}: ${message}`);
    failures++;
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && forbidden.has(node.text))
      fail(node, `native presence references ${node.text}`);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (
        specifier.includes('legacy') ||
        specifier === './presence' ||
        specifier.startsWith('node:') ||
        specifier.startsWith('@loro-dev/streams')
      )
        fail(node, 'native presence imports an execution or concrete I/O boundary');
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) {
          const original = (binding.propertyName ?? binding.name).text;
          if (launches.has(original) || forbidden.has(original))
            fail(binding, `native presence imports ${original}`);
        }
    }
    if (ts.isPropertyAccessExpression(node) && launches.has(node.name.text))
      fail(node, `native presence references execution/projection ${node.name.text}`);
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      launches.has(node.argumentExpression.text)
    )
      fail(node, `native presence references execution/projection ${node.argumentExpression.text}`);
    if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isIdentifier(node.propertyName) &&
      launches.has(node.propertyName.text)
    )
      fail(node, `native presence aliases execution/projection ${node.propertyName.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (failures) process.exitCode = 1;
else console.log('Native workspace presence boundary passed');
