#!/usr/bin/env node

import { execFileSync as defaultExecFileSync } from 'node:child_process';
import {
  existsSync as defaultExistsSync,
  readdirSync as defaultReaddirSync,
  readFileSync as defaultReadFileSync,
  statSync as defaultStatSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODES = Object.freeze({
  SKIP_TESTS: 'skip-tests',
  AFFECTED: 'affected',
  FULL: 'full',
});

export const EXCLUDED_PACKAGES = Object.freeze(['acp-extension-claude', 'acp-extension-codex']);

export const ALWAYS_FULL_GLOBS = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'patches/**',
  '.github/workflows/**',
  '.github/scripts/**',
  'scripts/**',
  'packages/configs/**',
  '.oxlintrc.json',
  '.eslintignore',
  '.prettierrc',
  '.prettierignore',
  '.gitignore',
  '.gitmodules',
  'tsconfig.json',
  'tsconfig.*.json',
  'packages/acp-extension-kimi',
  'packages/acp-extension-kimi/**',
]);

const TEST_PATTERNS = Object.freeze([
  '**/*.{test,spec}.{ts,tsx,js,mjs,cjs,mts,cts}',
  '**/*.test.{ts,tsx,js,mjs,cjs}',
  '**/__tests__/**',
  '**/tests/**',
  '**/test/**',
  '**/*.test.mjs',
  '**/fixtures/**',
  '**/stories/**',
]);

const RUNTIME_MARKDOWN_GLOBS = Object.freeze(['packages/code-review-helper/prompts/**']);

const SKIPPABLE_GLOBS = Object.freeze([
  'specs/**',
  '.agents/**',
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'DEV.md',
  'LICENSE',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'AGENTS.md',
  'CLAUDE.md',
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/README.md',
  '**/README.*.md',
  '**/CHANGELOG.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/**',
  '.github/labeler.yml',
  '.github/AGENTS.md',
  '.github/CLAUDE.md',
  '.github/codex-review.md',
  '.github/workflow-security.md',
  'site-docs/README.md',
  '.vscode/**',
]);

const REMAINING_MARKDOWN = '**/*.{md,mdx}';

const ACP_PREFIXES = Object.freeze([
  ['packages/acp-extension-claude', 'acp-extension-claude'],
  ['packages/acp-extension-codex', 'acp-extension-codex'],
  ['packages/acp-extension-core', 'acp-extension-core'],
  ['packages/acp-extension-dsh', 'acp-extension-dsh'],
  ['packages/acp-extension-grok', 'acp-extension-grok'],
]);

const GITHUB_OUTPUT_KEYS = Object.freeze([
  'mode',
  'reason',
  'run_tests',
  'run_typecheck',
  'run_check_quick',
  'prepare_acp_adapters',
  'test_packages',
  'typecheck_packages',
]);

const defaultIo = {
  readFileSync: defaultReadFileSync,
  readdirSync: defaultReaddirSync,
  statSync: defaultStatSync,
  existsSync: defaultExistsSync,
};

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function expandBraces(pattern) {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (!match) return [pattern];
  const alternatives = match[1].split(',');
  const results = [];
  for (const alternative of alternatives) {
    const expanded =
      pattern.slice(0, match.index) + alternative + pattern.slice(match.index + match[0].length);
    results.push(...expandBraces(expanded));
  }
  return results;
}

function globToRegExp(glob) {
  let source = '^';
  let index = 0;
  while (index < glob.length) {
    if (glob[index] === '*') {
      if (glob[index + 1] === '*') {
        index += 2;
        if (glob[index] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
        index += 1;
      }
    } else {
      source += escapeRegex(glob[index]);
      index += 1;
    }
  }
  source += '$';
  return new RegExp(source);
}

const globCache = new Map();

export function matchGlob(filePath, pattern) {
  const path = toPosix(filePath);
  let regexes = globCache.get(pattern);
  if (!regexes) {
    regexes = expandBraces(pattern).map(globToRegExp);
    globCache.set(pattern, regexes);
  }
  return regexes.some((regex) => regex.test(path));
}

export function matchesAnyGlob(filePath, patterns) {
  return patterns.some((pattern) => matchGlob(filePath, pattern));
}

function toPosix(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function labelsIncludeCiFull(labels) {
  const list = Array.isArray(labels)
    ? labels
    : String(labels ?? '')
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean);
  return list.includes('ci-full');
}

export function parseWorkspacePackageGlobs(yamlText) {
  const lines = String(yamlText).split(/\r?\n/);
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inPackages) {
      if (trimmed === 'packages:' || trimmed.startsWith('packages:')) {
        inPackages = true;
      }
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const isIndented = line.startsWith(' ') || line.startsWith('\t');
    if (!isIndented && !trimmed.startsWith('-')) break;
    if (!trimmed.startsWith('-')) continue;
    let value = trimmed.slice(1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (value) globs.push(value);
  }
  if (globs.length === 0) {
    throw new Error('pnpm-workspace.yaml has no packages: entries');
  }
  return globs;
}

function isDirectory(io, path) {
  try {
    return io.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listImmediateDirectories(io, path) {
  if (!isDirectory(io, path)) return [];
  return io
    .readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function readPackageJson(io, filePath) {
  try {
    return JSON.parse(io.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function workspaceDependencyNames(manifest) {
  const names = [];
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (String(version).startsWith('workspace:')) names.push(name);
    }
  }
  return names;
}

function expandPackageDirs(root, globs, io) {
  const included = [];
  const excluded = new Set();
  for (const glob of globs) {
    if (glob.startsWith('!')) {
      excluded.add(glob.slice(1));
      continue;
    }
    if (glob.endsWith('/*') && !glob.includes('**')) {
      const parent = join(root, glob.slice(0, -2));
      for (const name of listImmediateDirectories(io, parent)) {
        included.push(toPosix(join(toPosix(glob.slice(0, -2)), name)));
      }
      continue;
    }
    included.push(toPosix(glob));
  }
  return included.filter((dir) => !excluded.has(dir));
}

export function loadWorkspace(root, io = defaultIo) {
  const yaml = io.readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = parseWorkspacePackageGlobs(yaml);
  const dirs = expandPackageDirs(root, globs, io);
  const packages = [];
  const seen = new Set();

  for (const dir of dirs) {
    const manifest = readPackageJson(io, join(root, dir, 'package.json'));
    if (!manifest?.name) continue;
    seen.add(manifest.name);
    packages.push({
      name: manifest.name,
      dir,
      hasTest: Boolean(manifest.scripts?.test),
      hasTypecheck: Boolean(manifest.scripts?.typecheck),
      workspaceDeps: workspaceDependencyNames(manifest),
    });
  }

  for (const [dir, name] of ACP_PREFIXES) {
    if (seen.has(name)) continue;
    const manifest = readPackageJson(io, join(root, dir, 'package.json'));
    packages.push({
      name,
      dir,
      hasTest: Boolean(manifest?.scripts?.test),
      hasTypecheck: Boolean(manifest?.scripts?.typecheck),
      workspaceDeps: manifest ? workspaceDependencyNames(manifest) : [],
    });
    seen.add(name);
  }

  return finalizeWorkspace(packages);
}

export function finalizeWorkspace(packages) {
  const dependents = new Map();
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of packages) {
    for (const dep of pkg.workspaceDeps) {
      if (!byName.has(dep)) continue;
      const list = dependents.get(dep) ?? [];
      list.push(pkg.name);
      dependents.set(dep, list);
    }
  }
  return { packages, dependents, byName };
}

function longestPackage(filePath, workspace) {
  if (!workspace) return null;
  let best = null;
  for (const pkg of workspace.packages) {
    if (filePath === pkg.dir || filePath.startsWith(`${pkg.dir}/`)) {
      if (!best || pkg.dir.length > best.dir.length) best = pkg;
    }
  }
  return best;
}

function extraMapClassification(filePath) {
  if (
    filePath === 'site-docs/content' ||
    filePath.startsWith('site-docs/content/') ||
    filePath === 'site-docs/public' ||
    filePath.startsWith('site-docs/public/') ||
    filePath === 'site-docs/context' ||
    filePath.startsWith('site-docs/context/')
  ) {
    return { kind: 'test', packages: ['@lody/site-docs'] };
  }
  if (filePath === 'locales' || filePath.startsWith('locales/')) {
    return { kind: 'source', packages: ['@lody/components', '@lody/electron'] };
  }
  if (filePath === 'e2e' || filePath.startsWith('e2e/')) {
    return { kind: 'source', packages: ['@lody/e2e'] };
  }
  return null;
}

export function classifyPath(filePath, workspace) {
  const path = toPosix(filePath);
  if (matchesAnyGlob(path, ALWAYS_FULL_GLOBS)) {
    return { kind: 'always-full' };
  }
  if (matchesAnyGlob(path, TEST_PATTERNS)) {
    const pkg = longestPackage(path, workspace);
    return pkg ? { kind: 'test', packages: [pkg.name] } : { kind: 'unknown' };
  }
  if (matchesAnyGlob(path, RUNTIME_MARKDOWN_GLOBS)) {
    return { kind: 'source', packages: ['@lody/code-review-helper'] };
  }
  const extra = extraMapClassification(path);
  if (extra) return extra;
  if (matchesAnyGlob(path, SKIPPABLE_GLOBS) || matchGlob(path, REMAINING_MARKDOWN)) {
    return { kind: 'skippable' };
  }
  const pkg = longestPackage(path, workspace);
  if (pkg) return { kind: 'source', packages: [pkg.name] };
  return { kind: 'unknown' };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function transitiveDependents(workspace, seeds) {
  const result = new Set();
  const stack = [...seeds];
  const seen = new Set(seeds);
  while (stack.length > 0) {
    const name = stack.pop();
    for (const dependent of workspace.dependents.get(name) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      result.add(dependent);
      stack.push(dependent);
    }
  }
  return result;
}

function emptyLists() {
  return {
    testPackages: [],
    typecheckPackages: [],
    seedPackages: [],
    fanoutPackages: [],
  };
}

function packagesWithScripts(workspace, selected, field) {
  if (!workspace) return [];
  return uniqueSorted(
    selected.filter((name) => {
      if (EXCLUDED_PACKAGES.includes(name)) return false;
      const pkg = workspace.byName.get(name);
      return Boolean(pkg?.[field]);
    })
  );
}

function fullScope(partial) {
  const selected = partial.workspace ? partial.workspace.packages.map((pkg) => pkg.name) : [];
  return {
    mode: MODES.FULL,
    reason: partial.reason,
    runTests: true,
    runTypecheck: true,
    runCheckQuick: true,
    prepareAcpAdapters: true,
    runScriptTests: true,
    testPackages: packagesWithScripts(partial.workspace, selected, 'hasTest'),
    typecheckPackages: packagesWithScripts(partial.workspace, selected, 'hasTypecheck'),
    seedPackages: [],
    fanoutPackages: [],
    changedFiles: partial.changedFiles ?? [],
    event: partial.event,
    base: partial.base,
  };
}

function skipScope(partial) {
  return {
    mode: MODES.SKIP_TESTS,
    reason: partial.reason,
    runTests: false,
    runTypecheck: false,
    runCheckQuick: false,
    prepareAcpAdapters: false,
    runScriptTests: false,
    ...emptyLists(),
    changedFiles: partial.changedFiles ?? [],
    event: partial.event,
    base: partial.base,
  };
}

export function selectCiScope(input) {
  const eventName = input.eventName ?? 'pull_request';
  const changedFiles = (input.files ?? []).map(toPosix);
  const meta = {
    workspace: input.workspace,
    changedFiles,
    event: eventName,
    base: input.baseSha,
  };

  if (eventName !== 'pull_request') {
    return fullScope({ ...meta, reason: `event:${eventName}` });
  }
  if (labelsIncludeCiFull(input.labels)) {
    return fullScope({ ...meta, reason: 'ci-full' });
  }
  if (input.gitError) {
    return fullScope({ ...meta, reason: 'git_diff_failed' });
  }
  if (input.workspaceError || !input.workspace) {
    return fullScope({ ...meta, reason: 'workspace_parse_failed' });
  }
  if (changedFiles.length === 0) {
    return skipScope({ ...meta, reason: 'empty_diff' });
  }

  const sourceSeeds = new Set();
  const testSeeds = new Set();
  let firstSource;
  let firstTest;

  for (const filePath of changedFiles) {
    const classified = classifyPath(filePath, input.workspace);
    if (classified.kind === 'always-full' || classified.kind === 'unknown') {
      const reason =
        classified.kind === 'always-full' ? `always_full:${filePath}` : `unknown:${filePath}`;
      return fullScope({ ...meta, reason });
    }
    if (classified.kind === 'skippable') continue;
    if (classified.kind === 'source') {
      firstSource ??= filePath;
      for (const name of classified.packages ?? []) sourceSeeds.add(name);
    } else if (classified.kind === 'test') {
      firstTest ??= filePath;
      for (const name of classified.packages ?? []) testSeeds.add(name);
    }
  }

  if (sourceSeeds.size === 0 && testSeeds.size === 0) {
    return skipScope({ ...meta, reason: 'docs_only' });
  }

  const seedPackages = uniqueSorted([...sourceSeeds, ...testSeeds]);
  const fanoutPackages = uniqueSorted([
    ...transitiveDependents(input.workspace, [...sourceSeeds]),
  ]).filter((name) => !seedPackages.includes(name));
  const selected = uniqueSorted([...seedPackages, ...fanoutPackages]);
  const testPackages = packagesWithScripts(input.workspace, selected, 'hasTest');
  const typecheckPackages = packagesWithScripts(input.workspace, selected, 'hasTypecheck');
  const runTests = testPackages.length > 0;
  const runTypecheck = typecheckPackages.length > 0;

  return {
    mode: MODES.AFFECTED,
    reason: firstSource ? `source:${firstSource}` : `test:${firstTest}`,
    runTests,
    runTypecheck,
    runCheckQuick: true,
    prepareAcpAdapters: runTests || runTypecheck,
    runScriptTests: false,
    testPackages,
    typecheckPackages,
    seedPackages,
    fanoutPackages,
    changedFiles,
    event: eventName,
    base: input.baseSha,
  };
}

export function formatCiScopeLog(scope) {
  const files = scope.changedFiles ?? [];
  const shown = files.slice(0, 200);
  const remainder = files.length - shown.length;
  const lines = [
    'CI scope',
    `  mode: ${scope.mode}`,
    `  reason: ${scope.reason}`,
    `  event: ${scope.event ?? ''}`,
    `  base: ${scope.base ?? ''}`,
    `  files: ${files.length}`,
    `  seeds: ${(scope.seedPackages ?? []).join(', ') || '(none)'}`,
    `  fanout: ${(scope.fanoutPackages ?? []).join(', ') || '(none)'}`,
    `  testPackages: ${(scope.testPackages ?? []).join(', ') || '(none)'}`,
    `  typecheckPackages: ${(scope.typecheckPackages ?? []).join(', ') || '(none)'}`,
    `  runTests: ${scope.runTests}`,
    `  runTypecheck: ${scope.runTypecheck}`,
    `  runCheckQuick: ${scope.runCheckQuick}`,
    `  prepareAcpAdapters: ${scope.prepareAcpAdapters}`,
  ];
  if (shown.length > 0) {
    lines.push('  changed:');
    for (const file of shown) lines.push(`    ${file}`);
    if (remainder > 0) lines.push(`    ... and ${remainder} more`);
  }
  return lines.join('\n');
}

function assertCompleteScope(scope) {
  if (!scope || typeof scope !== 'object') {
    throw new Error('scope is required');
  }
  const required = {
    mode: scope.mode,
    reason: scope.reason,
    runTests: scope.runTests,
    runTypecheck: scope.runTypecheck,
    runCheckQuick: scope.runCheckQuick,
    prepareAcpAdapters: scope.prepareAcpAdapters,
    testPackages: scope.testPackages,
    typecheckPackages: scope.typecheckPackages,
  };
  for (const [key, value] of Object.entries(required)) {
    if (value === undefined || value === null) {
      throw new Error(`missing GITHUB_OUTPUT field ${key}`);
    }
  }
}

export function formatGithubOutput(scope) {
  assertCompleteScope(scope);
  const values = {
    mode: scope.mode,
    reason: scope.reason,
    run_tests: String(scope.runTests),
    run_typecheck: String(scope.runTypecheck),
    run_check_quick: String(scope.runCheckQuick),
    prepare_acp_adapters: String(scope.prepareAcpAdapters),
    test_packages: JSON.stringify(scope.testPackages),
    typecheck_packages: JSON.stringify(scope.typecheckPackages),
  };
  for (const key of GITHUB_OUTPUT_KEYS) {
    if (values[key] === undefined) {
      throw new Error(`missing GITHUB_OUTPUT key ${key}`);
    }
  }
  return GITHUB_OUTPUT_KEYS.map((key) => `${key}=${values[key]}`).join('\n') + '\n';
}

export function writeGithubOutput(scope, stream) {
  const body = formatGithubOutput(scope);
  if (typeof stream.write === 'function') {
    stream.write(body);
    return;
  }
  throw new Error('stream.write is required');
}

export function parseNameStatusZ(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const parts = text.split('\0').filter((part) => part.length > 0);
  const files = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index];
    index += 1;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = parts[index];
      const newPath = parts[index + 1];
      if (!oldPath || !newPath) throw new Error('truncated git name-status rename');
      files.push(toPosix(oldPath), toPosix(newPath));
      index += 2;
    } else {
      const path = parts[index];
      if (!path) throw new Error('truncated git name-status path');
      files.push(toPosix(path));
      index += 1;
    }
  }
  return files;
}

export function listChangedFiles({
  baseSha,
  headSha,
  execFileSync = defaultExecFileSync,
  cwd,
} = {}) {
  if (!baseSha || !headSha) {
    throw new Error('baseSha and headSha are required');
  }
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseSha], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = execFileSync(
    'git',
    ['diff', '--name-status', '-z', '--diff-filter=ACDMRT', baseSha, headSha],
    { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return parseNameStatusZ(output);
}

function parseArgs(argv) {
  const options = {
    event: 'pull_request',
    baseSha: '',
    headSha: '',
    workspaceRoot: '.',
    labels: '',
    filesJson: null,
    githubOutput: process.env.GITHUB_OUTPUT ?? null,
    jsonOut: null,
    strict: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index];
    switch (argument) {
      case '--event':
        options.event = next() ?? '';
        break;
      case '--base-sha':
        options.baseSha = next() ?? '';
        break;
      case '--head-sha':
        options.headSha = next() ?? '';
        break;
      case '--workspace-root':
        options.workspaceRoot = next() ?? '.';
        break;
      case '--labels':
        options.labels = next() ?? '';
        break;
      case '--files-json':
        options.filesJson = next() ?? null;
        break;
      case '--github-output':
        options.githubOutput = next() ?? null;
        break;
      case '--json-out':
        options.jsonOut = next() ?? null;
        break;
      case '--strict':
        options.strict = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function defaultJsonOut(options) {
  if (options.jsonOut) return options.jsonOut;
  if (process.env.RUNNER_TEMP) return join(process.env.RUNNER_TEMP, 'ci-scope.json');
  return join(options.workspaceRoot, '.ci-scope.json');
}

export function runSelectCiScopeCli(argv, io = {}) {
  const options = parseArgs(argv);
  const execFileSync = io.execFileSync ?? defaultExecFileSync;
  const readFileSync = io.readFileSync ?? defaultReadFileSync;
  let workspace;
  let workspaceError;
  try {
    workspace = loadWorkspace(options.workspaceRoot, io.fs ?? defaultIo);
  } catch (error) {
    workspaceError = error;
    if (options.strict) throw error;
  }

  let files = [];
  let gitError;
  if (options.filesJson) {
    files = JSON.parse(readFileSync(options.filesJson, 'utf8'));
  } else if (options.event === 'pull_request') {
    try {
      files = listChangedFiles({
        baseSha: options.baseSha,
        headSha: options.headSha,
        execFileSync,
        cwd: options.workspaceRoot,
      });
    } catch (error) {
      gitError = error;
      if (options.strict) throw error;
    }
  }

  const scope = selectCiScope({
    eventName: options.event,
    labels: options.labels,
    files,
    workspace,
    workspaceError,
    gitError,
    baseSha: options.baseSha,
  });

  const jsonOut = defaultJsonOut(options);
  writeFileSync(jsonOut, `${JSON.stringify(scope, null, 2)}\n`);
  const log = formatCiScopeLog(scope);
  console.log(log);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${log}\n`);
  }
  if (options.githubOutput) {
    appendFileSync(options.githubOutput, formatGithubOutput(scope));
  }
  return scope;
}

function main() {
  try {
    runSelectCiScopeCli(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
