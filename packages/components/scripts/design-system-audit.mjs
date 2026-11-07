/** Read-only StyleX inventory. Candidates require owner review; they are not violations. */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const conditions = /^(?:default$|[:@&]|\[)/;
const colorProperty = /(?:color$|^color$|^fill$|^stroke$|^background$)/i;
const opacityProperty = /opacity$/i;
const shadowProperty = /shadow/i;
const literalColor =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(\s*[-+.\d]|^(?:white|black|red|blue|green|yellow|orange|purple|pink|cyan|magenta|gray|grey|silver|navy|teal|lime|maroon|olive|aqua|fuchsia|rebeccapurple)$/i;

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : node.getText();
}

function values(node, state = []) {
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((part) =>
      ts.isPropertyAssignment(part)
        ? values(part.initializer, [...state, propertyName(part.name)])
        : [{ node: part, state, unresolved: true }]
    );
  }
  return [{ node, state, unresolved: false }];
}

function scopeFor(file) {
  const normalized = file.replaceAll('\\', '/');
  const kind = /(?:^|\/)stories\//.test(normalized)
    ? 'story'
    : /(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)tests\//.test(normalized)
      ? 'test'
      : 'product';
  return {
    kind,
    area: normalized.match(/(?:^|\/)src\/(components\/[^/]+|ui|style|lib|hooks)/)?.[1] ?? 'other',
    owner: /(?:tokens|\.stylex|\/style\/)/.test(normalized) ? 'style-definition' : 'component',
  };
}

function semanticRole(kind, namespace, states, file) {
  const context = `${namespace} ${states.join(' ')}`;
  if (kind === 'keyframes') return 'animation';
  if (/:disabled|aria-disabled|data-disabled|data-\[disabled/.test(context)) return 'disabled';
  if (/disabled|unavailable|dimmed/i.test(namespace)) return 'disabled-candidate';
  if (/dragging|drag-overlay/i.test(context)) return 'drag-feedback';
  if (/hint|caption|muted|secondary|description|placeholder/i.test(context))
    return 'hint-candidate';
  if (/\/icons\/|\/theme\/theme-tile|\/onboarding\/(?:ceremony|blueprint)/.test(file)) {
    return 'artwork-candidate';
  }
  return 'unclassified';
}

/** Inventory declaration syntax and state scope without evaluating styles or rewriting source. */
export function auditSource(source, file = 'src/unknown.tsx') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const namespaces = new Set();
  const namedMethods = new Map();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@stylexjs/stylex')
      continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text);
    } else if (clause?.namedBindings) {
      for (const element of clause.namedBindings.elements) {
        namedMethods.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  const findings = [];
  let unresolved = 0;
  const seen = new Set();
  function inspectCall(call) {
    let method;
    if (
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      namespaces.has(call.expression.expression.text)
    ) {
      method = call.expression.name.text;
    } else if (ts.isIdentifier(call.expression)) method = namedMethods.get(call.expression.text);
    if (!['create', 'keyframes', 'defineVars', 'createTheme'].includes(method)) return;
    const argument = call.arguments[method === 'createTheme' ? 1 : 0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) {
      unresolved++;
      return;
    }
    const binding = ts.isVariableDeclaration(call.parent) ? call.parent.name.getText(ast) : method;
    const visit = (node, chain = []) => {
      if (ts.isSpreadAssignment(node)) unresolved++;
      if (ts.isPropertyAssignment(node)) {
        const name = propertyName(node.name);
        const next = [...chain, name];
        const topNamespace = method === 'create' && node.parent === argument;
        if (
          !topNamespace &&
          !conditions.test(name) &&
          (opacityProperty.test(name) ||
            colorProperty.test(name) ||
            shadowProperty.test(name) ||
            ts.isStringLiteralLike(node.initializer) ||
            ts.isTemplateExpression(node.initializer))
        ) {
          for (const value of values(node.initializer)) {
            const valueText = ts.isStringLiteralLike(value.node)
              ? value.node.text
              : value.node.getText(ast);
            const states = [...next.filter((key) => conditions.test(key)), ...value.state];
            const namespace = `${binding}.${next
              .filter((key) => !conditions.test(key))
              .slice(0, -1)
              .join('.')}`.replace(/\.$/, '');
            const role = semanticRole(method, `${namespace}.${name}`, states, file);
            const kinds = [];
            if (opacityProperty.test(name)) kinds.push('opacity');
            if (shadowProperty.test(name)) kinds.push('shadow');
            if (/\bcolor-mix\s*\(/i.test(valueText)) kinds.push('color-mix');
            if (literalColor.test(valueText)) kinds.push('literal-color');
            for (const kind of kinds) {
              const key = `${value.node.pos}:${kind}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const position = ast.getLineAndCharacterOfPosition(value.node.getStart(ast));
              findings.push({
                file,
                line: position.line + 1,
                column: position.character + 1,
                scope: scopeFor(file),
                namespace,
                property: name,
                states,
                kind,
                role,
                value: valueText,
                review:
                  role === 'animation' || role === 'drag-feedback'
                    ? 'intentional-state-candidate'
                    : 'owner-review',
              });
            }
            if (value.unresolved) unresolved++;
          }
        }
        ts.forEachChild(node.initializer, (child) => visit(child, next));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, chain));
    };
    visit(argument);
  }
  function walk(node) {
    if (ts.isCallExpression(node)) inspectCall(node);
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return { findings, unresolved, parseErrors: ast.parseDiagnostics.length };
}

async function sourceFiles(root) {
  const result = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en')
  )) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules')
      result.push(...(await sourceFiles(full)));
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) result.push(full);
  }
  return result;
}

async function main(argv) {
  let root = path.join(packageRoot, 'src');
  let scope = 'product';
  let asJson = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--json') asJson = true;
    else if (argv[index] === '--root') root = path.resolve(argv[++index]);
    else if (argv[index] === '--scope') scope = argv[++index];
    else throw Error(`Unknown argument: ${argv[index]}`);
  }
  if (!['product', 'story', 'test', 'all'].includes(scope))
    throw Error('--scope must be product, story, test or all');
  const findings = [];
  let files = 0,
    unresolved = 0,
    parseErrors = 0;
  for (const file of await sourceFiles(root)) {
    const relative = path.relative(repositoryRoot, file).replaceAll('\\', '/');
    if (scope !== 'all' && scopeFor(relative).kind !== scope) continue;
    files++;
    const result = auditSource(await readFile(file, 'utf8'), relative);
    findings.push(...result.findings);
    unresolved += result.unresolved;
    parseErrors += result.parseErrors;
  }
  const counts = {};
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  const result = {
    schema: 1,
    toolSHA256: createHash('sha256')
      .update(await readFile(scriptPath))
      .digest('hex'),
    purpose: 'review inventory, not a violation count',
    scope,
    files,
    counts,
    unresolved,
    parseErrors,
    findings,
  };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `${files} files; ${findings.length} declarations; ${unresolved} unresolved; ${parseErrors} parse errors`
    );
    console.log(
      'Candidates require semantic owner review; animation/artwork/state values are not automatically violations.'
    );
    for (const item of findings)
      console.log(
        `${item.file}:${item.line} ${item.kind} ${item.role} ${item.namespace}.${item.property} = ${item.value}`
      );
  }
  if (parseErrors) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
