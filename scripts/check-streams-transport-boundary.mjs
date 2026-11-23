#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/**
 * Only the central factory (and the standalone e2ee-lab harness, which cannot depend on @lody/shared)
 * may instantiate `StreamsCrdt` directly in production source.
 * Product callers must go through `createStreamsCrdt` so WebSocket and shard policies are explicit.
 */
const STREAMS_CRDT_NEW_ALLOWLIST = new Set([
  'packages/shared/src/streams-crdt-factory.ts',
  'packages/e2ee-lab/src/platform/document-session.ts',
]);

/**
 * Explicit one-shot `syncOnce()` allowlist in production source.
 * Live joined rooms should never trigger polling catch-ups outside these documented edges.
 */
const SYNC_ONCE_ALLOWLIST = new Set([
  'packages/components/src/hooks/use-machine-flock-rows.ts',
  'packages/components/src/providers/create-workspace-runtime.ts',
  'packages/components/src/lib/memory-association-write.ts',
  'packages/components/src/lib/workspace-catalog-write.ts',
  'apps/cli/src/lib/agent-config-machine-flock.ts',
  'apps/cli/src/lib/code-collab/code-collab-flock-publish.ts',
  'apps/cli/src/lib/local-project-meta.ts',
  'apps/cli/src/lib/loro/doc.ts',
  'apps/cli/src/lib/loro/machine-flock-sync-coordinator.ts',
  'apps/cli/src/lib/schedules/schedule-command-service.ts',
  'apps/cli/src/lib/workspace-mcp-store.ts',
]);

/**
 * Governed machine `mf` (`getMachineFlockDocId` / `:mf:`) `openFlockDoc(...)` sites.
 * New renderer components/hooks should consume `useMachineFlockRows` instead of opening `mf` directly.
 */
const MACHINE_FLOCK_OPEN_ALLOWLIST = new Set([
  'packages/components/src/atoms/agents.ts',
  'packages/components/src/atoms/magpie-import.ts',
  'packages/components/src/hooks/use-machine-flock-rows.ts',
  'packages/components/src/hooks/use-session-actions.ts',
  'packages/components/src/lib/memory-association-write.ts',
  'packages/components/src/providers/create-workspace-runtime.ts',
  'apps/cli/src/commands/agent-config.ts',
  'apps/cli/src/commands/machine.ts',
  'apps/cli/src/commands/session.ts',
  'apps/cli/src/lib/agent-config-machine-flock.ts',
  'apps/cli/src/lib/local-project-meta.ts',
  'apps/cli/src/lib/loro/doc.ts',
  'apps/cli/src/lib/loro/machine-flock-sync-coordinator.ts',
  'apps/cli/src/lib/loro/machine-flock-command-watcher.ts',
  'apps/cli/src/lib/message-handler.ts',
  'apps/cli/src/lib/provider-setup-manager.ts',
  'apps/cli/src/lib/resource-discovery-runtime.ts',
  'apps/cli/src/lib/schedules/schedule-command-service.ts',
  'apps/cli/src/lib/schedules/schedule-workspace.ts',
  'apps/cli/src/mcp/lody-mcp-server.ts',
  'apps/cli/src/session/session-launch-config-resolver.ts',
]);

async function collectWorkspaceSrcFiles() {
  const results = [];
  for (const base of ['packages', 'apps']) {
    const baseDir = path.join(root, base);
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkg of entries) {
      if (!pkg.isDirectory()) continue;
      const srcDir = path.join(baseDir, pkg.name, 'src');
      try {
        await walkFiles(srcDir, `${base}/${pkg.name}/src`, results);
      } catch {
        // Package has no src directory.
      }
    }
  }
  return results.sort();
}

async function walkFiles(dir, relDir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkFiles(full, rel, out);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
    out.push(rel);
  }
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function expressionContainsMachineFlockMarker(node, machineFlockVars) {
  let found = false;
  walk(node, (child) => {
    if (found) return;
    if (ts.isIdentifier(child)) {
      if (child.text === 'getMachineFlockDocId' || machineFlockVars.has(child.text)) {
        found = true;
      }
    } else if (
      (ts.isStringLiteralLike(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
      child.text.includes(':mf:')
    ) {
      found = true;
    } else if (ts.isTemplateExpression(child)) {
      if (
        child.head.text.includes(':mf:') ||
        child.templateSpans.some((span) => span.literal.text.includes(':mf:'))
      ) {
        found = true;
      }
    }
  });
  return found;
}

function collectMachineFlockVarNames(ast) {
  const vars = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    walk(ast, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (
          !vars.has(node.name.text) &&
          expressionContainsMachineFlockMarker(node.initializer, vars)
        ) {
          vars.add(node.name.text);
          changed = true;
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        if (!vars.has(node.left.text) && expressionContainsMachineFlockMarker(node.right, vars)) {
          vars.add(node.left.text);
          changed = true;
        }
      }
    });
  }
  return vars;
}

const files = await collectWorkspaceSrcFiles();
const violations = [];
const observedStreamsCrdtNew = new Set();
const observedSyncOnce = new Set();
const observedMachineFlockOpen = new Set();

for (const file of files) {
  const content = await readFile(path.join(root, file), 'utf8');
  const scriptKind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  const machineFlockVars = collectMachineFlockVarNames(ast);

  walk(ast, (node) => {
    if (ts.isNewExpression(node)) {
      const targetName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (targetName === 'StreamsCrdt') {
        observedStreamsCrdtNew.add(file);
        if (!STREAMS_CRDT_NEW_ALLOWLIST.has(file)) {
          const pos = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          violations.push(
            `${file}:${pos.line + 1}: direct \`new StreamsCrdt(...)\` is forbidden outside streams-crdt-factory.ts (use createStreamsCrdt)`
          );
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression.name.text;
      if (prop === 'syncOnce') {
        observedSyncOnce.add(file);
        if (!SYNC_ONCE_ALLOWLIST.has(file)) {
          const pos = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          violations.push(
            `${file}:${pos.line + 1}: \`.syncOnce()\` call outside allowlist; joined live rooms must not add ad-hoc catch-up polling`
          );
        }
      } else if (prop === 'openFlockDoc') {
        const firstArg = node.arguments[0];
        if (firstArg && expressionContainsMachineFlockMarker(firstArg, machineFlockVars)) {
          observedMachineFlockOpen.add(file);
          if (!MACHINE_FLOCK_OPEN_ALLOWLIST.has(file)) {
            const pos = ast.getLineAndCharacterOfPosition(node.getStart(ast));
            violations.push(
              `${file}:${pos.line + 1}: machine \`mf\` \`openFlockDoc()\` outside allowlist`
            );
          }
        }
      }
    }
  });
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Streams transport boundary passed (new StreamsCrdt: ${observedStreamsCrdtNew.size}, syncOnce: ${observedSyncOnce.size}, machine mf openFlockDoc: ${observedMachineFlockOpen.size}).`
  );
}
