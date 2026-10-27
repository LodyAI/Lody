/**
 * Review checks for the Tailwind → StyleX migration.
 *
 * These are the mistakes a migration makes that neither the type checker nor
 * a unit test catches — they are all about what happens to a class that was
 * already there.
 *
 *   node scripts/stylex-review.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '../src');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

const findings = [];

function report(file, line, kind, detail) {
  findings.push({ file: path.relative(srcRoot, file), line, kind, detail });
}

for (const file of await walk(srcRoot)) {
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n');
  const usesStylex = /@stylexjs\/stylex/.test(source);

  // A focus-scoped Tailwind ring is invisible on its own, but its `box-shadow`
  // declaration erased the app's GLOBAL focus ring (the base layer's inset
  // primary ring). Dropping it without reproducing that side effect gives the
  // element a focus indicator it never had. Compare the ring classes the file
  // had before the migration with the ones it has now, and with the StyleX
  // neutralisations that replace them.
  const repositoryFile = path.relative(path.resolve(here, '../../..'), file);
  let original = '';
  try {
    original = execFileSync('git', ['show', `HEAD:${repositoryFile}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    original = '';
  }
  if (original) {
    // One element per class string that carries a focus ring (a string often
    // carries both `focus-visible:ring-2` and `focus-visible:ring-ring`).
    const ringString = /(['"`])[^'"`]*\b(?:focus|focus-visible):ring-[^'"`]*\1/g;
    const originalRings = (original.match(ringString) ?? []).length;
    const currentRings = (source.match(ringString) ?? []).length;
    const neutralised = (source.match(/':focus-visible': 'none'/g) ?? []).length;
    if (currentRings + neutralised < originalRings) {
      report(
        file,
        0,
        'focus-ring-lost',
        `${originalRings} focus rings before, ${currentRings} kept, ${neutralised} neutralised`
      );
    }
  }

  lines.forEach((line, index) => {
    const isComment = /^\s*(\*|\/\/|\/\*)/.test(line);
    // A style prop written before the StyleX props loses to the spread's own
    // inline style, and the other way round it hides the caller's style.
    if (/style=\{\s*(style|props\.style)\s*\}/.test(line) && /\{\.\.\.stylex\.props\(/.test(line)) {
      report(file, index + 1, 'style-overwritten', line.trim());
    }
    // A Tailwind ring that was scoped to a focus state paints nothing in this
    // app, so a migrated surface must not have gained a visible one — and a
    // surface that still declares one has not been migrated yet.
    if (!isComment && /['"`][^'"`]*focus-visible:ring-|['"`][^'"`]*focus:ring-/.test(line)) {
      report(file, index + 1, 'focus-ring-left', line.trim());
    }
    // A StyleX ring next to a Tailwind shadow: the Tailwind shadow is a
    // `utilities`-layer box-shadow and would erase the StyleX ring.
    if (usesStylex && /boxShadow:/.test(line) && /shadow-(sm|md|lg|xl|2xl|none)/.test(line)) {
      report(file, index + 1, 'mixed-shadow', line.trim());
    }
    // The StyleX compiler resolves a `.stylex` import itself and does not read
    // the bundler's aliases.
    if (/from\s+['"]@\/style\//.test(line)) {
      report(file, index + 1, 'aliased-stylex-import', line.trim());
    }
    // `text-sm` sets a size AND a line height; a style that keeps only the
    // size re-wraps its copy.
    const sizeMatch = line.match(/fontSize:\s*themeFontSize\.([A-Za-z0-9]+)/);
    if (sizeMatch) {
      const block = lines.slice(index, index + 30).join('\n');
      const expected = `themeLineHeight.${sizeMatch[1]}`;
      if (!block.includes(expected) && !block.includes('lineHeight')) {
        report(file, index + 1, 'text-size-without-leading', line.trim());
      }
    }
  });

  // Read actual JSX attributes so child nodes, multiline spreads and either
  // attribute order are handled consistently. Regex cannot delimit JSX tags.
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const propsVariables = new Map();
  const classVariables = new Map();
  function walkAst(node, visit) {
    visit(node);
    ts.forEachChild(node, (child) => walkAst(child, visit));
  }
  walkAst(ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      classVariables.set(node.name.text, node.initializer);
      if (node.initializer.getText(ast).startsWith('stylex.props(')) {
        propsVariables.set(node.name.text, node.initializer.getText(ast));
      }
    }
  });
  walkAst(ast, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const attributes = node.attributes.properties;
    const classAttribute = attributes.find(
      (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'className'
    );
    if (!classAttribute) return;
    let classValue = classAttribute.initializer;
    if (classValue && ts.isJsxExpression(classValue)) classValue = classValue.expression;
    const seen = new Set();
    while (classValue && ts.isIdentifier(classValue) && !seen.has(classValue.text)) {
      seen.add(classValue.text);
      const initializer = classVariables.get(classValue.text);
      if (!initializer) break;
      classValue = initializer;
    }
    const classExpression = classValue?.getText(ast) ?? '';
    const spreads = attributes.filter((attribute) => ts.isJsxSpreadAttribute(attribute));
    for (const spread of spreads) {
      const expression = spread.expression.getText(ast);
      if (!expression.startsWith('stylex.props(') && !propsVariables.has(expression)) continue;
      // A merged class explicitly includes this spread's generated className.
      if (classExpression.includes(`${expression}.className`)) continue;
      const line = ast.getLineAndCharacterOfPosition(classAttribute.getStart(ast)).line + 1;
      report(
        file,
        line,
        'classname-replaced',
        node.getText(ast).replace(/\s+/g, ' ').slice(0, 180)
      );
    }
  });
}

if (!findings.length) {
  console.log('stylex-review: no findings');
} else {
  const byKind = new Map();
  for (const finding of findings) {
    if (!byKind.has(finding.kind)) byKind.set(finding.kind, []);
    byKind.get(finding.kind).push(finding);
  }
  for (const [kind, items] of byKind) {
    console.log(`\n## ${kind} (${items.length})`);
    for (const item of items.slice(0, 40)) {
      console.log(`  ${item.file}:${item.line}  ${item.detail.slice(0, 150)}`);
    }
    if (items.length > 40) console.log(`  …and ${items.length - 40} more`);
  }
  console.log(`\n${findings.length} findings`);
}
