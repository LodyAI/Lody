import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const obsolete = new Set([
  'getHistory',
  'updateHistory',
  'readHistorySnapshot',
  'captureStoredHistory',
  'copyStoredHistory',
  'updateHistoryAndCursor',
  'setHistoryEntryField',
  'setLatestAssistantHistoryFileDiff',
  'getLatestAssistantHistory',
]);
const storageOwners = new Set([
  'apps/cli/src/lib/loro/doc.ts',
  'packages/components/src/lib/conversation-view/create-conversation-session.ts',
]);
export function sessionBoundaryViolations(file, source) {
  const result = [];
  const cli = file.startsWith('apps/cli/src/') && !file.startsWith('apps/cli/src/lib/loro/');
  const ui = file.startsWith('packages/components/src/');
  const publicPort = [
    'packages/shared/src/session-data/types.ts',
    'packages/shared/src/session-data/domain.ts',
  ].includes(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const report = (node, message) =>
    result.push(
      `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${message}`
    );
  function visit(node) {
    const member = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : ts.isBindingElement(node)
          ? (node.propertyName ?? node.name).getText(ast)
          : undefined;
    if (cli && obsolete.has(member)) report(node, `Use SessionData instead of ${member}`);
    if (cli && file !== 'apps/cli/src/lib/task-doc.ts' && member === 'mirror')
      report(node, 'Subscribe through the session facade, not Mirror');
    if (ui && !storageOwners.has(file) && member === 'historyWriter')
      report(node, 'Session UI must use SessionData commands');
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      if (
        publicPort &&
        (module.includes('loro') || ['../schema', '@lody/shared/schema'].includes(module))
      )
        report(node, 'Public session DTOs must not depend on the storage schema or CRDT');
      if (
        (cli || ui) &&
        !storageOwners.has(file) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const item of node.importClause.namedBindings.elements) {
          const name = (item.propertyName ?? item.name).text;
          if (['createHistoryWriter', 'createLoroSessionData'].includes(name))
            report(item, 'Construct session storage only at its composition root');
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(target);
    return /\.tsx?$/.test(entry.name) && !/(\.test\.|\.stories\.|\.d\.ts$)/.test(entry.name)
      ? [target]
      : [];
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = [
    'apps/cli/src',
    'packages/components/src',
    'packages/shared/src/session-data',
  ].flatMap((dir) => walk(path.join(root, dir)));
  const errors = files.flatMap((file) =>
    sessionBoundaryViolations(path.relative(root, file), fs.readFileSync(file, 'utf8'))
  );
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Session data boundary passed (${files.length} source files).`);
}
