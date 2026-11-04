import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'apps/cli/src/orchestration/inbox');
const errors = [];
const retiredMethods = new Set([
  'deliverIfRunnable',
  'listPendingDeliveries',
  'getDelivery',
  'claimDeliveryExecution',
  'prepareClaimedDeliveryExecution',
  'markClaimedDeliveryExecutionStarted',
  'markClaimedDeliveryExecutionUncertain',
  'claimDeliveryFinalization',
  'releaseDeliveryClaim',
  'consumeClaimedDelivery',
  'recoverOrphanedDeliveryClaims',
  'abandonDeliveryClaimsOwnedBy',
  'startAfterLegacyDrain',
  'settleVisibleTurn',
]);
for (const relative of [
  'apps/cli/src/orchestration/operation-store.ts',
  'apps/cli/src/orchestration/operation-coordinator.ts',
  'apps/cli/src/session/session-execution-service.ts',
]) {
  const file = ts.createSourceFile(
    relative,
    fs.readFileSync(path.join(root, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const visit = (node) => {
    if (
      (ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        retiredMethods.has(node.name.text)) ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        retiredMethods.has(node.expression.name.text))
    ) {
      errors.push(`${relative}: retired Delivery scheduler API`);
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === 'dispatchSource' &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === 'delivery'
    ) {
      errors.push(`${relative}: retired per-Delivery dispatch source`);
    }
    if (
      (ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) &&
      node.name.getText(file) === 'onTurnSettled'
    )
      errors.push(`${relative}: retired Delivery settlement callback`);
    ts.forEachChild(node, visit);
  };
  visit(file);
}
const nativeFiles = [
  ...fs
    .readdirSync(dir)
    .filter(
      (n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !['legacy.ts', 'sqlite.ts'].includes(n)
    )
    .map((n) => 'apps/cli/src/orchestration/inbox/' + n),
  ...[
    'coordinator-activity.ts',
    'coordinator-workflow.ts',
    'coordinator-model.ts',
    'coordinator-ports.ts',
    'operation-repository.ts',
    'storage-error.ts',
  ].map((n) => 'apps/cli/src/orchestration/' + n),
  'apps/cli/src/lib/workspace-cleanup-owner.ts',
];
for (const name of nativeFiles) {
  const file = ts.createSourceFile(
    name,
    fs.readFileSync(path.join(root, name), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const bad = (node, reason) =>
    errors.push(
      `${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${reason}`
    );
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (
        /operation-coordinator|operation-store|inbox\/legacy|\/platform\/|^@\/(session|lib\/loro)|^(node:)?(fs|child_process|os)$|better-sqlite3/u.test(
          spec
        )
      )
        bad(node, 'native workflow depends on a concrete platform or upstream implementation');
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(file);
      if (
        /^(Effect\.run|ManagedRuntime\.make|setTimeout|setInterval|Date\.now|Math\.random|randomUUID)/u.test(
          expression
        )
      )
        bad(node, 'runtime, clock, random source or timer escapes the native capability boundary');
      if (expression === 'Effect.tryPromise')
        bad(node, 'unfinished Promise orchestration must stay in a named platform adapter');
    }
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'Promise')
      bad(node, 'native workflow must compose Effects');
    ts.forEachChild(node, visit);
  };
  visit(file);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Operation Inbox native boundary passed');
