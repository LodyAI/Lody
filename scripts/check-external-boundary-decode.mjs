import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const BOUNDARY_FILES = Object.freeze([
  'apps/electron/src/renderer/src/auth-query-generation.ts',
  'apps/electron/src/renderer/src/auth.ts',
  'apps/electron/src/main/services/auth-service.ts',
  'packages/components/src/lib/organization-session-queries.ts',
  'packages/components/src/providers/cloud-platform-api.ts',
  'packages/components/src/lib/electron-ipc-client.ts',
  'packages/components/src/router.tsx',
]);

const BARE_DATA_ASSERTION_FILES = new Set([
  'apps/electron/src/renderer/src/auth-query-generation.ts',
  'apps/electron/src/main/services/auth-service.ts',
  'packages/components/src/lib/organization-session-queries.ts',
]);

function getLine(ast, node) {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

function isUnwrapOrResponseDataExpr(expr) {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
    current = current.expression;
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return isUnwrapOrResponseDataExpr(current.left);
  }
  if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
    return (
      current.expression.text === 'unwrapData' || current.expression.text === 'unwrapResponseData'
    );
  }
  if (
    ts.isPropertyAccessExpression(current) &&
    current.name.text === 'data' &&
    ts.isIdentifier(current.expression) &&
    (current.expression.text === 'response' || current.expression.text === 'raw')
  ) {
    return true;
  }
  return false;
}

function getEnclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Audit a single source file for external-boundary decoding invariants.
 * Exported for unit testing.
 */
export function auditExternalBoundarySource(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors = [];

  if (BARE_DATA_ASSERTION_FILES.has(file)) {
    function visitAuthBoundary(node) {
      if (ts.isAsExpression(node) && isUnwrapOrResponseDataExpr(node.expression)) {
        errors.push(
          `${file}:${getLine(ast, node)}: bare type assertion on external response data; validate with a runtime Zod decoder instead`
        );
      }
      ts.forEachChild(node, visitAuthBoundary);
    }
    visitAuthBoundary(ast);
  }

  if (file === 'apps/electron/src/renderer/src/auth.ts') {
    function visitElectronAuth(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createAuthQueryStore'
      ) {
        const optionsArg = node.arguments[2];
        const hasDecode =
          optionsArg &&
          ts.isObjectLiteralExpression(optionsArg) &&
          optionsArg.properties.some(
            (prop) =>
              (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'decode'
          );
        if (!hasDecode) {
          errors.push(
            `${file}:${getLine(ast, node)}: createAuthQueryStore must provide a runtime decode option`
          );
        }
      }
      ts.forEachChild(node, visitElectronAuth);
    }
    visitElectronAuth(ast);
  }

  if (file === 'packages/components/src/providers/cloud-platform-api.ts') {
    function visitCloudApi(node) {
      if (
        ts.isAsExpression(node) &&
        getEnclosingFunctionName(node) !== 'decodeCloudResult'
      ) {
        const typeText = node.type.getText(ast).trim();
        if (
          typeText === 'Result' ||
          typeText === 'Result | undefined' ||
          typeText === 'Promise<Result>' ||
          typeText === 'CloudQueryState<Result>'
        ) {
          errors.push(
            `${file}:${getLine(ast, node)}: bare "${typeText}" assertion bypasses decodeCloudResult/decodeCloudQueryState`
          );
        }
      }
      ts.forEachChild(node, visitCloudApi);
    }
    visitCloudApi(ast);
  }

  if (file === 'packages/components/src/lib/electron-ipc-client.ts') {
    function visitIpcClient(node) {
      if (ts.isAsExpression(node) && getEnclosingFunctionName(node) === 'onIpcEvent') {
        errors.push(
          `${file}:${getLine(ast, node)}: onIpcEvent must decode push payloads through decodeIpcPushPayload instead of bare type assertions`
        );
      }
      ts.forEachChild(node, visitIpcClient);
    }
    visitIpcClient(ast);
  }

  if (file === 'packages/components/src/router.tsx') {
    let hasDefaultErrorComponent = false;
    function visitRouter(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createTanstackRouter'
      ) {
        const configArg = node.arguments[0];
        if (configArg && ts.isObjectLiteralExpression(configArg)) {
          hasDefaultErrorComponent = configArg.properties.some(
            (prop) =>
              (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'defaultErrorComponent'
          );
        }
      }
      ts.forEachChild(node, visitRouter);
    }
    visitRouter(ast);
    if (!hasDefaultErrorComponent) {
      errors.push(
        `${file}: createTanstackRouter must configure defaultErrorComponent so route errors render ErrorBoundaryFallback`
      );
    }
  }

  return { errors };
}

export function auditExternalBoundaryTree(root) {
  const errors = [];
  for (const file of BOUNDARY_FILES) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) {
      errors.push(`${file}: expected external boundary file is missing`);
      continue;
    }
    const source = fs.readFileSync(fullPath, 'utf8');
    errors.push(...auditExternalBoundarySource(file, source).errors);
  }
  return { checked: BOUNDARY_FILES.length, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { checked, errors } = auditExternalBoundaryTree(root);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`External boundary decode guard: ${checked} boundary files verified.`);
  }
}
