import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const transitional = new Set();
const observedBridges = new Set();

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    return entry.isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

for (const layer of ['pure', 'ports', 'workflows']) {
  for (const file of files(join(root, 'src', layer))) {
    const name = relative(join(root, 'src'), file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const report = (node, reason) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      failures.push(`${name}:${line}: ${reason}`);
    };
    const visit = (node) => {
      if (ts.isThrowStatement(node)) report(node, 'explicit throw in migrated layer');
      if (ts.isImportDeclaration(node)) {
        const specifier = node.moduleSpecifier.text;
        const clause = node.importClause;
        const typeOnly =
          clause?.isTypeOnly ||
          (clause?.name === undefined &&
            clause?.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.every((item) => item.isTypeOnly));
        if (!typeOnly) {
          if (specifier.startsWith('node:') || specifier.includes('/platform/'))
            report(node, 'platform dependency');
          if (layer === 'pure' && specifier.startsWith('../'))
            report(node, 'pure runtime dependency outside pure/');
          if (layer === 'workflows' && specifier.startsWith('../ledger/')) {
            const bridge = `${name} -> ${specifier}`;
            observedBridges.add(bridge);
            if (!transitional.has(bridge)) report(node, 'unlisted protocol migration bridge');
          }
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const call = node.expression.getText(source);
        if (
          /^(?:globalThis\.)?(?:fetch|Date|setTimeout|setInterval|crypto\.|performance\.|Math\.random)/.test(
            call
          )
        ) {
          report(node, `implicit environment access: ${call}`);
        }
        if (/\b(?:runPromise|runPromiseExit|runSync|runSyncExit|runFork)$/.test(call))
          report(node, 'nested Effect runtime');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

for (const bridge of transitional) {
  if (!observedBridges.has(bridge)) failures.push(`Remove obsolete migration exception: ${bridge}`);
}
if (process.argv.includes('--complete') && observedBridges.size > 0) {
  failures.push(
    'Migration is not complete: remove protocol bridges, migrate legacy consumers, then run the full acceptance suite.'
  );
}
console.log(
  JSON.stringify(
    {
      failures,
      protocolBridgesRemaining: observedBridges.size,
      scope: 'pure/ports/workflows only; does not certify unconverted modules',
    },
    null,
    2
  )
);
if (failures.length) process.exitCode = 1;
