#!/usr/bin/env node

// Every OS process the CLI starts, waits for or signals goes through the Effect
// process layer (apps/cli/src/platform/process). This guard fails when CLI
// source reaches for child_process, cross-spawn, node-pty or process.kill
// directly, so a second process implementation cannot creep back in.
// Rules: apps/cli/src/platform/AGENTS.md.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSourceRoot = 'apps/cli/src/';

/** Files allowed to reach the OS directly, each with the reason it is not a second implementation. */
const allowlist = new Map([
  ['apps/cli/src/platform/process/node-process.ts', 'the process layer’s single OS boundary'],
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

const forbidden = [
  {
    // Type-only imports carry no behaviour and stay allowed.
    pattern: /import\s+(?!type\b)[^;]*?from\s+['"](?:node:)?child_process['"]/gu,
    label: 'child_process import',
  },
  { pattern: /require\(\s*['"](?:node:)?child_process['"]\s*\)/gu, label: 'child_process require' },
  { pattern: /from\s+['"]cross-spawn['"]/gu, label: 'cross-spawn import' },
  { pattern: /['"](?:@lydell\/)?node-pty['"]/gu, label: 'node-pty reference' },
  { pattern: /\bprocess\.kill\s*\(/gu, label: 'process.kill call' },
];

async function listCliSources() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', cliSourceRoot], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter((file) => /\.(?:ts|tsx|mts|cts|js|mjs)$/u.test(file))
    .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) && !file.includes('/__tests__/'));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const violations = [];
for (const file of await listCliSources()) {
  if (allowlist.has(file)) continue;
  let text;
  try {
    text = await readFile(path.join(repoRoot, file), 'utf8');
  } catch {
    continue;
  }
  for (const { pattern, label } of forbidden) {
    for (const match of text.matchAll(pattern)) {
      violations.push(`${file}:${lineOf(text, match.index ?? 0)} ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error('CLI process boundary violations (use apps/cli/src/platform/process instead):');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('CLI process boundary guard passed.');
