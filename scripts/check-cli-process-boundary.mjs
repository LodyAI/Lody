#!/usr/bin/env node

// Every OS process the CLI starts, waits for or signals goes
// through the Effect process layer (`@lody/shared/node/process`). This guard
// fails when their source reaches for child_process, a process-spawning library
// (cross-spawn, execa, shell-env, node-pty, ...) or a direct kill, so a second
// process implementation cannot creep back in.
// Rules: packages/shared/src/node/AGENTS.md.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = [
  'apps/cli/src/',
  'packages/shared/src/node/process.ts',
  'packages/shared/src/node/login-shell-env.ts',
];

/** Files allowed to reach the OS directly, each with the reason it is not a second implementation. */
const allowlist = new Map([
  ['packages/shared/src/node/process.ts', 'the process layer and its single OS boundary'],
  [
    'packages/shared/src/node/process-testing.ts',
    'test support that models the OS process table; imported only by tests',
  ],
  [
    'apps/cli/src/lib/terminal-pty-service.ts',
    'loads node-pty, the only PTY spawner; PTY trees end through the process layer',
  ],
  [
    'apps/cli/src/lib/github-git-transport.ts',
    'source text of a standalone git wrapper script that runs in its own process',
  ],
  [
    'apps/cli/src/lib/gh-shim-script.ts',
    'source text of a standalone gh shim script that runs in its own process',
  ],
  [
    'apps/cli/src/lib/git-credential-helper-script.ts',
    'source text of a standalone credential helper that runs in its own process',
  ],
  [
    'apps/cli/src/agent/deepseek-harness-runtime.ts',
    'source text injected into the DeepSeek Harness child, not daemon code',
  ],
]);

// A module specifier position: `from`, a side-effect `import`, dynamic
// `import(...)`, `require(...)` and `createRequire(...)(...)`. A string that
// only names a module (Tinypool's `runtime: 'child_process'`) is not one.
const MODULE_POSITION = String.raw`(?:\bfrom|\bimport\s*\(?|(?:\brequire|\))\s*\()\s*`;
const PROCESS_MODULES = String.raw`(?:node:)?child_process|cross-spawn|execa|shell-env|tree-kill|ps-tree|find-process|pidusage|(?:@lydell/)?node-pty`;
/** The statement before a specifier is a type-only import or export, possibly multi-line. */
const TYPE_ONLY_STATEMENT = /\b(?:import|export)\s+type\b[^;'"]*$/u;

const forbidden = [
  {
    // `child_process` and the libraries that start or signal processes on
    // their own, in any import form. Type-only imports carry no behaviour.
    pattern: new RegExp(`${MODULE_POSITION}['"](?:${PROCESS_MODULES})['"]`, 'gu'),
    label: 'process module reference',
    skip: (match, text) => TYPE_ONLY_STATEMENT.test(text.slice(0, match.index)),
  },
  { pattern: /\bprocess\.kill\s*\(/gu, label: 'process.kill call' },
  // Signalling a ChildProcess (or PTY) directly is a hand-written termination
  // path; `terminateTree` owns escalation and bounded waits. The `NodeProcess`
  // service's own `kill` is the sanctioned door. Covers `child?.kill(`,
  // `(child as T).kill(` and `children[i].kill(` too. `yield* handle.kill(...)`
  // is the official Effect handle operation; yielding Node's boolean kill result
  // is rejected by TypeScript and must not be mistaken for an OS bypass.
  {
    pattern: /([\w$]+|[)\]])\s*\??\.kill\s*\(/gu,
    label: 'direct child signal',
    skip: (match, text) =>
      ['process', 'np', 'nodeProcess', 'nodeProcessLive'].includes(match[1] ?? '') ||
      /\byield\s*\*\s*$/u.test(text.slice(0, match.index)),
  },
];

async function listSources() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-co', '--exclude-standard', ...sourceRoots],
    {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  return stdout
    .split('\n')
    .filter((file) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file))
    .filter(
      (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) && !file.includes('/__tests__/')
    );
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Migration-only execution doors keep Legacy visible; core Effect APIs keep
// their original names. Parse bindings so comments and unrelated identifiers
// cannot be mistaken for an import, and an alias cannot hide the boundary.
const retiredFacades = new Set([
  'runCommandText',
  'runCommandTextSync',
  'startProcess',
  'terminateChildTree',
  'signalChildTreeNow',
  'isPidAliveSync',
  'probePidSync',
  'makeProcessRunner',
  'runPromiseSquashed',
  'ProcessRunner',
  'ProcessHandle',
]);
const legacyFacades = new Set([...retiredFacades].map((name) => `${name}Legacy`));

function checkFacadeBindings(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const report = (node, label) =>
    violations.push(`${file}:${lineOf(text, node.getStart(source))} ${label}`);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const module = statement.moduleSpecifier;
      if (!module || !ts.isStringLiteral(module)) continue;
      if (
        module.text !== '@lody/shared/node/process' &&
        !(file.startsWith('packages/shared/src/node/') && module.text === './process')
      )
        continue;
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : statement.exportClause;
      if (!bindings || !(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) continue;
      for (const binding of bindings.elements) {
        const imported = (binding.propertyName ?? binding.name).text;
        if (retiredFacades.has(imported)) report(binding, `retired process facade ${imported}`);
        if (legacyFacades.has(imported) && !binding.name.text.endsWith('Legacy'))
          report(binding, `process facade alias hides Legacy: ${binding.name.text}`);
      }
    }
    if (
      file === 'packages/shared/src/node/process.ts' &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const names = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((declaration) => declaration.name)
        : [statement.name];
      for (const name of names) {
        if (name && ts.isIdentifier(name) && retiredFacades.has(name.text))
          report(name, `retired process facade export ${name.text}`);
      }
    }
  }
}

const violations = [];
for (const file of await listSources()) {
  let text;
  try {
    text = await readFile(path.join(repoRoot, file), 'utf8');
  } catch {
    continue;
  }
  checkFacadeBindings(file, text);
  if (allowlist.has(file)) continue;
  for (const { pattern, label, skip } of forbidden) {
    for (const match of text.matchAll(pattern)) {
      if (skip?.(match, text)) continue;
      violations.push(`${file}:${lineOf(text, match.index ?? 0)} ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Process boundary violations (use @lody/shared/node/process instead):');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('Process boundary guard passed.');
