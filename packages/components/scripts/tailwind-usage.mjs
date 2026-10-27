/**
 * Count source occurrences accepted by this project's Tailwind compiler.
 *
 * node scripts/tailwind-usage.mjs [--files | --json] [--root <file-or-directory>]
 *
 * Reads JSX class attributes, cn/clsx/cva/twMerge/withClassName calls, local class constants,
 * pure literal string concatenations, and complete static template tokens.
 * Each source token is counted once, even
 * if a constant has several consumers. Runtime values remain unresolved. CSS
 * hooks and group/peer markers emit no utilities and are excluded. Counts measure
 * source usage, not emitted CSS size; JSON lists unresolved expressions.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex >= 0 && (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))) {
  throw new Error('--root requires a file or directory');
}
const sourceRoot =
  rootIndex >= 0
    ? path.resolve(process.cwd(), args[rootIndex + 1])
    : path.join(packageRoot, 'src/components');
const require = createRequire(import.meta.url);
// Use the direct dependency's compiler so validation follows the locked version.
const tailwind = createRequire(require.resolve('@tailwindcss/postcss'))('@tailwindcss/node');
const cssFile = path.join(packageRoot, 'src/tailwind/index.css');
const design = await tailwind.__unstable__loadDesignSystem(await readFile(cssFile, 'utf8'), {
  base: path.dirname(cssFile),
});
const validity = new Map();
const valid = (candidate) => {
  if (!validity.has(candidate)) {
    validity.set(candidate, design.candidatesToCss([candidate])[0] !== null);
  }
  return validity.get(candidate);
};

async function walk(file) {
  if (!(await stat(file)).isDirectory()) return /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  const entries = await readdir(file, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((entry) => !['node_modules', '.git', 'dist', 'artifacts'].includes(entry.name))
      .map((entry) => walk(path.join(file, entry.name)))
  );
  return children.flat().sort();
}

const classHelpers = new Set(['cn', 'clsx', 'cva', 'twMerge', 'withClassName']);
const className = (name) =>
  /class(?:es|names?)?$/i.test(name) || /CLASS(?:_NAME)?(?:_[A-Z0-9]+)*$/.test(name);

function inspect(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  const literals = new Map();
  const unresolved = new Map();
  const active = new Set();
  const location = (node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const literalString = (node) => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return literalString(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literalString(node.left);
      const right = literalString(node.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
    return undefined;
  };
  const visit = (node, callback) => {
    callback(node);
    ts.forEachChild(node, (child) => visit(child, callback));
  };
  visit(ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      declarations.set(name, [...(declarations.get(name) ?? []), node.initializer]);
    }
  });
  const unknown = (node, reason) =>
    unresolved.set(node.pos, {
      line: location(node),
      expression: node.getText(ast).slice(0, 200),
      reason,
    });
  function tokens(node, value, leadingHole = false, trailingHole = false) {
    if (leadingHole) value = value.replace(/^\S*/, '');
    if (trailingHole) value = value.replace(/\S*$/, '');
    if (!literals.has(node.pos)) {
      const candidates = value.split(/\s+/).filter(Boolean).filter(valid);
      if (candidates.length) literals.set(node.pos, { line: location(node), candidates });
    }
  }
  function collect(node, objectKeys = false) {
    if (!node || active.has(node)) return;
    active.add(node);
    if (ts.isStringLiteralLike(node)) tokens(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      tokens(node.head, node.head.text, false, true);
      for (const span of node.templateSpans) {
        collect(span.expression);
        tokens(span.literal, span.literal.text, true, !ts.isTemplateTail(span.literal));
      }
      unknown(
        node,
        'Only complete static template tokens are counted; interpolations may add classes.'
      );
    } else if (ts.isIdentifier(node)) {
      const values = declarations.get(node.text);
      if (values?.length === 1) collect(values[0], objectKeys);
      else if (!['undefined', 'null', 'true', 'false'].includes(node.text)) {
        unknown(
          node,
          values
            ? 'Multiple local declarations; scope resolution is ambiguous.'
            : 'Imported, parameter, or runtime value.'
        );
      }
    } else if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue, objectKeys);
      collect(node.whenFalse, objectKeys);
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const value = literalString(node);
        if (value === undefined)
          unknown(node, 'Concatenated tokens may cross expression boundaries.');
        else tokens(node, value);
      } else if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind)
      ) {
        // The left side of && is a condition, not a class expression.
        if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
          collect(node.left, objectKeys);
        collect(node.right, objectKeys);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach((element) => collect(element, objectKeys));
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          if (objectKeys && !ts.isComputedPropertyName(property.name)) {
            tokens(property.name, property.name.text);
          } else collect(property.initializer, objectKeys);
        } else if (ts.isSpreadAssignment(property)) collect(property.expression, objectKeys);
      }
    } else if (ts.isCallExpression(node)) {
      const helper = node.expression.getText(ast);
      if (helper === 'withClassName') {
        collect(node.arguments[1]);
      } else if (classHelpers.has(helper)) {
        node.arguments.forEach((argument) => collect(argument, helper !== 'cva'));
      } else if (!helper.startsWith('stylex.')) unknown(node, 'Runtime helper output.');
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      collect(node.expression, objectKeys);
    } else if (ts.isJsxExpression(node)) collect(node.expression, objectKeys);
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!node.getText(ast).includes('stylex.props('))
        unknown(node, 'Property lookup or external class map.');
    }
    active.delete(node);
  }
  visit(ast, (node) => {
    if (ts.isJsxAttribute(node) && className(node.name.getText(ast))) collect(node.initializer);
    if (ts.isCallExpression(node) && classHelpers.has(node.expression.getText(ast))) collect(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && className(node.name.text)) {
      collect(node.initializer);
    }
  });
  const entries = [...literals.values()].sort((a, b) => a.line - b.line);
  return {
    file: path.relative(packageRoot, file).split(path.sep).join('/'),
    count: entries.reduce((sum, entry) => sum + entry.candidates.length, 0),
    entries,
    unresolved: [...unresolved.values()].sort((a, b) => a.line - b.line),
  };
}

const files = [];
for (const file of await walk(sourceRoot)) files.push(inspect(file, await readFile(file, 'utf8')));
const used = files
  .filter((file) => file.count > 0)
  .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
const areas = new Map();
for (const file of used) {
  const relative = path.relative(sourceRoot, path.join(packageRoot, file.file));
  const area = relative.split(path.sep)[0] || path.basename(sourceRoot);
  areas.set(area, (areas.get(area) ?? 0) + file.count);
}
const totals = {
  occurrences: used.reduce((sum, file) => sum + file.count, 0),
  uniqueCandidates: new Set(
    used.flatMap((file) => file.entries.flatMap((entry) => entry.candidates))
  ).size,
  files: used.length,
  scannedFiles: files.length,
  unresolvedExpressions: files.reduce((sum, file) => sum + file.unresolved.length, 0),
};
if (args.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        root: path.relative(packageRoot, sourceRoot) || '.',
        method:
          'Static source-token occurrences accepted by the installed project Tailwind compiler; deduplicated by source location.',
        limits:
          'Runtime concatenations, imported constants, ambiguous local declarations, and computed class maps are not resolved. Inspect unresolved entries; counts are a lower bound. CSS hooks and group/peer markers are excluded.',
        totals,
        areas: Object.fromEntries([...areas].sort((a, b) => b[1] - a[1])),
        files: files
          .filter((file) => file.count || file.unresolved.length)
          .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
      },
      null,
      2
    )
  );
} else {
  const rows = args.includes('--files')
    ? used.map((file) => [file.file, file.count])
    : [...areas].sort((a, b) => b[1] - a[1]);
  for (const [label, count] of rows) console.log(`${String(count).padStart(6)}  ${label}`);
  console.log(
    `${String(totals.occurrences).padStart(6)}  TOTAL (${totals.files} files; ${totals.uniqueCandidates} distinct utilities)`
  );
  console.log(
    `${totals.unresolvedExpressions} unresolved expressions; --json lists static-analysis limits and locations.`
  );
}
