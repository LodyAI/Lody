#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];
async function source(file) {
  return ts.createSourceFile(
    file,
    await readFile(path.join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
}
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
for (const entry of await readdir(path.join(root, 'packages/shared/src/local-loro-writer'))) {
  if (!entry.endsWith('.ts') || entry === 'legacy.ts') continue;
  const file = `packages/shared/src/local-loro-writer/${entry}`;
  const ast = await source(file);
  walk(ast, (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier.text;
      if (/legacy|^node:|\/node\//iu.test(specifier))
        violations.push(`${file}: native workflow imports platform/Legacy`);
    }
    if (ts.isIdentifier(node) && /Legacy$/u.test(node.text))
      violations.push(`${file}: native workflow references Legacy`);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const property = node.expression.name.text;
      if (/^run(?:Sync|Promise|Fork)/u.test(property))
        violations.push(`${file}: internal runtime execution`);
      if (property === 'tryPromise' && entry !== 'sdk.ts')
        violations.push(`${file}: Promise adapter outside Flock SDK boundary`);
    }
    if (
      ts.isIdentifier(node) &&
      ['setTimeout', 'setInterval', 'setImmediate', 'AbortController'].includes(node.text)
    ) {
      violations.push(`${file}: platform scheduler/cancellation in native workflow`);
    }
  });
}
async function cliFiles(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? cliFiles(`${dir}/${entry.name}`)
          : entry.name.endsWith('.ts')
            ? [`${dir}/${entry.name}`]
            : []
      )
    )
  ).flat();
}
const unloadSites = [];
for (const file of await cliFiles('apps/cli/src')) {
  walk(await source(file), (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'unloadDoc'
    )
      unloadSites.push(file);
  });
}
if (unloadSites.length !== 1 || unloadSites[0] !== 'apps/cli/src/lib/loro/doc.ts')
  violations.push('repo.unloadDoc must use the single LoroDocumentManager unloader');
if (violations.length) {
  console.error([...new Set(violations)].join('\n'));
  process.exitCode = 1;
} else console.log('Local Loro writer native/execution/platform and unload boundaries passed.');
