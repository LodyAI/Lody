#!/usr/bin/env node
/**
 * Comment ratchet
 *
 * Prose comments in product source only ever shrink. Each scanned scope keeps a
 * baseline count of lines that carry a `//` line comment or a `/*` block comment
 * in scripts/comment-ratchet-baseline.json. Deleting comments always passes.
 *
 * A change is judged by what it adds, never by the baseline's slack: locally
 * the working tree (untracked files included) against its merge base with
 * origin/main, and on a pull request merge ref the merged tree against the
 * base tip. A scope may grow only as far as the same change raises its baseline
 * (`--update`), so concurrent changes cannot jointly exceed it. A push to the
 * base branch, or a checkout without one, is checked against the baseline.
 *
 * Exempt (not counted, allowed to grow):
 * - `/**` JSDoc blocks: machine-consumed API documentation.
 * - Tool directives: `@ts-*`, oxlint/eslint/biome/prettier, istanbul, c8, v8,
 *   cspell, #region/#endregion, @generated, sourceMappingURL, PURE annotations,
 *   vite/webpack pragmas, triple-slash reference/types, and @dec doc anchors.
 *
 * Usage:
 *   node scripts/check-comment-ratchet.mjs            check against baseline
 *   node scripts/check-comment-ratchet.mjs --update   rewrite baseline
 *   node scripts/check-comment-ratchet.mjs --report   print per-scope counts
 *   node scripts/check-comment-ratchet.mjs --dump <dir>  list comments under dir
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRel = 'scripts/comment-ratchet-baseline.json';
const baselinePath = path.join(repoRoot, baselineRel);
const baseBranchRef = 'origin/main';

const scanRoots = ['apps', 'packages', 'e2e'];
const scanExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs']);
const excludedPrefixes = ['packages/acp-extension-kimi/', 'packages/acp-extension-pi/'];
const excludedFilePatterns = [/\.gen\.[tj]sx?$/, /\.generated\.[tj]sx?$/, /\.snap$/];

const directivePatterns = [
  /^@ts-/,
  /^@dec:?/,
  /^eslint/,
  /^oxlint/,
  /^biome/,
  /^prettier/,
  /^istanbul/,
  /^c8 /,
  /^v8 /,
  /^cspell/,
  /^spell-/,
  /^region\b/,
  /^endregion\b/,
  /^#region\b/,
  /^#endregion\b/,
  /^@generated/,
  /^generated\b/,
  /^auto-generated/,
  /^sourceMappingURL/,
  /^@__PURE__/,
  /^#__PURE__/,
  /^@__NO_SIDE_EFFECTS__/,
  /^vite-/,
  /^webpack/,
  /^<reference\b/,
  /^\/ <reference\b/,
  /^\/ <types\b/,
  /^@jsx/,
  /^@module/,
  /^global\b/,
  /^exported\b/,
];

function isDirective(text) {
  const trimmed = text.replace(/^\*+/, '').trim().toLowerCase();
  if (trimmed === '') return false;
  return directivePatterns.some((pattern) => pattern.test(trimmed));
}

/**
 * Scan source text and return comment descriptors:
 * { kind: 'line' | 'block' | 'jsdoc', startLine, endLine, text, directive }
 */
export function scanComments(source) {
  const comments = [];
  const stack = ['code'];
  let i = 0;
  let line = 1;
  let prevSignificant = '';
  const n = source.length;

  const top = () => stack[stack.length - 1];
  const isRegexStart = () => {
    if (prevSignificant === '') return true;
    if ('=(,:;!&|?{}[]+-*%<>~^'.includes(prevSignificant)) return true;
    return false;
  };

  while (i < n) {
    const state = top();
    const c = source[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (state === 'code') {
      if (c === "'") {
        stack.push('sq');
      } else if (c === '"') {
        stack.push('dq');
      } else if (c === '`') {
        stack.push('template');
      } else if (c === '/') {
        const next = source[i + 1];
        if (next === '/') {
          const start = i + 2;
          const startLine = line;
          let end = source.indexOf('\n', start);
          if (end === -1) end = n;
          const text = source.slice(start, end);
          comments.push({
            kind: 'line',
            startLine,
            endLine: line,
            text,
            directive: text.startsWith('/')
              ? /^\/ <(reference|types)\b/.test(text)
              : isDirective(text),
          });
          i = end;
          continue;
        }
        if (next === '*') {
          const jsdoc = source[i + 2] === '*' && source[i + 3] !== '/';
          const startLine = line;
          let j = i + 2;
          let closed = false;
          while (j < n - 1) {
            if (source[j] === '*' && source[j + 1] === '/') {
              closed = true;
              break;
            }
            if (source[j] === '\n') line += 1;
            j += 1;
          }
          if (!closed && j === n - 1) {
            if (source[j] === '\n') line += 1;
          }
          const endIndex = closed ? j : n;
          const text = source.slice(i + 2, endIndex);
          comments.push({
            kind: jsdoc ? 'jsdoc' : 'block',
            startLine,
            endLine: line,
            text,
            directive: jsdoc ? false : isDirective(text),
          });
          i = closed ? j + 2 : n;
          prevSignificant = '/';
          continue;
        }
        if (isRegexStart()) {
          let j = i + 1;
          let inClass = false;
          while (j < n) {
            const rc = source[j];
            if (rc === '\\') {
              j += 2;
              continue;
            }
            if (rc === '\n') break;
            if (rc === '[') inClass = true;
            else if (rc === ']') inClass = false;
            else if (rc === '/' && !inClass) break;
            j += 1;
          }
          if (source[j] === '/' && j > i + 1) {
            i = j + 1;
            prevSignificant = '/';
            continue;
          }
        }
        prevSignificant = '/';
      } else if (c === '}') {
        if (stack.length > 1 && stack[stack.length - 1] === 'code') {
          stack.pop();
        } else {
          prevSignificant = '}';
        }
      } else if (c === '$' && source[i + 1] === '{') {
        // handled in template state; unreachable in code
      } else if (!/\s/.test(c)) {
        if (!'()'.includes(c)) prevSignificant = c;
        else prevSignificant = c;
      }
    } else if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (c === '\\') {
        i += 2;
        if (source[i - 1] === '\n') line += 1;
        continue;
      }
      if (c === quote) {
        stack.pop();
        prevSignificant = quote;
      }
    } else if (state === 'template') {
      if (c === '\\') {
        i += 2;
        if (source[i - 1] === '\n') line += 1;
        continue;
      }
      if (c === '`') {
        stack.pop();
        prevSignificant = '`';
      } else if (c === '$' && source[i + 1] === '{') {
        stack.push('code');
        i += 1;
        prevSignificant = '{';
      }
    }
    i += 1;
  }
  return comments;
}

function scopeOf(relPath) {
  const parts = relPath.split('/');
  if (parts[0] === 'e2e') return parts.length > 1 ? `e2e/${parts[1]}` : 'e2e';
  if (parts.length < 2) return parts[0];
  return `${parts[0]}/${parts[1]}`;
}

function countFile(source) {
  const counted = new Set();
  const exempt = new Set();
  let jsdocLines = 0;
  for (const comment of scanComments(source)) {
    const target = comment.directive || comment.kind === 'jsdoc' ? exempt : counted;
    for (let l = comment.startLine; l <= comment.endLine; l += 1) target.add(l);
    if (comment.kind === 'jsdoc') jsdocLines += comment.endLine - comment.startLine + 1;
  }
  return { counted: counted.size, exempt: exempt.size, jsdocLines };
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const splitZ = (text) => text.split('\0').filter(Boolean);

function isScanned(rel) {
  if (!scanExtensions.has(path.extname(rel))) return false;
  if (!scanRoots.some((r) => rel === r || rel.startsWith(`${r}/`))) return false;
  if (excludedPrefixes.some((p) => rel.startsWith(p))) return false;
  return !excludedFilePatterns.some((p) => p.test(rel));
}

// Tracked sources only, so untracked install/codegen artifacts and checked-out
// native client submodules never shift the counts.
function listTrackedFiles(root) {
  return splitZ(git(root, ['ls-files', '--cached', '-z']));
}

export function collectCounts(root = repoRoot) {
  const scopes = new Map();
  const fileCounts = new Map();
  for (const rel of listTrackedFiles(root).filter(isScanned)) {
    let counts;
    try {
      counts = countFile(readFileSync(path.join(root, rel), 'utf8'));
    } catch {
      continue;
    }
    fileCounts.set(rel, counts);
    const scope = scopeOf(rel);
    const entry = scopes.get(scope) ?? { counted: 0, exempt: 0, jsdoc: 0, files: 0 };
    entry.counted += counts.counted;
    entry.exempt += counts.exempt;
    entry.jsdoc += counts.jsdocLines;
    entry.files += 1;
    scopes.set(scope, entry);
  }
  return { scopes, fileCounts };
}

function hasCommit(root, rev) {
  try {
    git(root, ['cat-file', '-e', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the change is compared with. `head: null` is the working tree.
 * Under CI a merge HEAD is a pull request merge ref: its first parent is the
 * base tip, which a shallow checkout may need to fetch.
 */
export function resolveComparison(root, env = process.env) {
  if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') {
    try {
      const commit = git(root, ['cat-file', '-p', 'HEAD']);
      const parents = [...commit.matchAll(/^parent (\S+)$/gm)].map((m) => m[1]);
      if (parents.length < 2) return { kind: 'baseline' };
      const [baseTip] = parents;
      if (!hasCommit(root, baseTip))
        execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseTip], {
          cwd: root,
          stdio: 'inherit',
        });
      return { kind: 'change', base: baseTip, head: 'HEAD', label: 'the base tip' };
    } catch {
      return { kind: 'baseline' };
    }
  }
  try {
    const base = git(root, ['merge-base', 'HEAD', baseBranchRef]).trim();
    return base
      ? { kind: 'change', base, head: null, label: `its merge base with ${baseBranchRef}` }
      : { kind: 'baseline' };
  } catch {
    return { kind: 'baseline' };
  }
}

function readAt(root, rev, rel) {
  if (rev === null) return readFileSync(path.join(root, rel), 'utf8');
  return git(root, ['show', `${rev}:${rel}`]);
}

function countAt(root, rev, rel) {
  try {
    return countFile(readAt(root, rev, rel)).counted;
  } catch {
    return 0;
  }
}

function baselineAt(root, rev) {
  try {
    return JSON.parse(readAt(root, rev, baselineRel)).scopes ?? {};
  } catch {
    return {};
  }
}

function changedFiles(root, { base, head }) {
  const tracked = splitZ(
    git(root, ['diff', '--name-only', '--no-renames', '-z', base, ...(head ? [head] : [])])
  );
  const untracked = head
    ? []
    : splitZ(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].filter(isScanned).sort();
}

/** Per-scope comment growth of the change, with the files that grew. */
export function measureChange(root, comparison) {
  const scopes = new Map();
  for (const rel of changedFiles(root, comparison)) {
    const delta = countAt(root, comparison.head, rel) - countAt(root, comparison.base, rel);
    if (delta === 0) continue;
    const scope = scopeOf(rel);
    const entry = scopes.get(scope) ?? { delta: 0, grown: [] };
    entry.delta += delta;
    if (delta > 0) entry.grown.push({ rel, delta });
    scopes.set(scope, entry);
  }
  return scopes;
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return { version: 1, scopes: {} };
  }
}

function overBaseline(scopes, baseline) {
  const over = [];
  for (const [scope, entry] of scopes) {
    const allowed = baseline.scopes[scope];
    if (allowed === undefined) {
      if (entry.counted > 0)
        over.push(
          `${scope}: ${entry.counted} comment lines but no baseline entry (new scopes must start at zero)`
        );
    } else if (entry.counted > allowed)
      over.push(`${scope}: ${entry.counted} comment lines exceeds baseline ${allowed}`);
  }
  return over;
}

function checkChange(comparison) {
  const growth = measureChange(repoRoot, comparison);
  const headBaseline = baselineAt(repoRoot, comparison.head);
  const baseBaseline = baselineAt(repoRoot, comparison.base);
  const failures = [];
  for (const [scope, entry] of [...growth.entries()].sort()) {
    const raised = Math.max(0, (headBaseline[scope] ?? 0) - (baseBaseline[scope] ?? 0));
    if (entry.delta <= raised) continue;
    const files = entry.grown.map(({ rel, delta }) => `    ${rel}: +${delta}`).join('\n');
    failures.push(`  ${scope}: +${entry.delta} comment lines\n${files}`);
  }
  if (failures.length > 0) {
    process.stderr.write(
      `Comment ratchet: this change adds prose comments against ${comparison.label}. Prose comments may only shrink; delete comments or move durable rationale into docs/notes.\n${failures.join('\n')}\nIf a refactor merely moved comments between scopes, run: node scripts/check-comment-ratchet.mjs --update\n`
    );
    process.exit(1);
  }
  const { scopes } = collectCounts(repoRoot);
  const inherited = overBaseline(scopes, loadBaseline());
  if (inherited.length > 0)
    process.stdout.write(
      `Comment ratchet: the base already exceeds the baseline; not counted against this change:\n${inherited
        .map((s) => `  ${s.replace(/ comment lines exceeds baseline /, ' > ')}`)
        .join('\n')}\n`
    );
  process.stdout.write(
    `Comment ratchet: this change adds no prose comments against ${comparison.label}.\n`
  );
}

function checkBaseline() {
  const { scopes } = collectCounts(repoRoot);
  const baseline = loadBaseline();
  const failures = overBaseline(scopes, baseline);
  const shrunk = [];
  for (const [scope, entry] of scopes) {
    const allowed = baseline.scopes[scope];
    if (allowed !== undefined && entry.counted < allowed)
      shrunk.push(`${scope}: ${entry.counted} < ${allowed}`);
  }
  if (shrunk.length > 0)
    process.stdout.write(
      `Comment ratchet: scopes below baseline (run --update to tighten):\n${shrunk.map((s) => `  ${s}`).join('\n')}\n`
    );
  if (failures.length > 0) {
    process.stderr.write(
      `Comment ratchet exceeded baseline. Prose comments may only shrink; delete comments or move durable rationale into docs/notes.\n${failures.map((f) => `  ${f}`).join('\n')}\nIf a refactor merely moved comments between scopes, run: node scripts/check-comment-ratchet.mjs --update\n`
    );
    process.exit(1);
  }
  process.stdout.write('Comment ratchet: all scopes at or below baseline.\n');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--dump')) {
    const dir = args[args.indexOf('--dump') + 1] ?? '';
    const { fileCounts } = collectCounts(repoRoot);
    for (const [rel] of fileCounts) {
      if (dir && !rel.startsWith(dir)) continue;
      const text = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const c of scanComments(text)) {
        const firstLine = c.text.split('\n')[0].trim().slice(0, 160);
        process.stdout.write(
          `${rel}:${c.startLine}-${c.endLine}\t${c.kind}${c.directive ? ':directive' : ''}\t${firstLine}\n`
        );
      }
    }
    return;
  }

  if (args.includes('--report')) {
    const { scopes } = collectCounts(repoRoot);
    const sorted = [...scopes.entries()].sort((a, b) => b[1].counted - a[1].counted);
    let total = 0;
    let totalExempt = 0;
    let totalJsdoc = 0;
    for (const [scope, entry] of sorted) {
      total += entry.counted;
      totalExempt += entry.exempt;
      totalJsdoc += entry.jsdoc;
      process.stdout.write(
        `${String(entry.counted).padStart(6)} counted  ${String(entry.jsdoc).padStart(6)} jsdoc  ${String(entry.exempt).padStart(5)} exempt  ${scope} (${entry.files} files)\n`
      );
    }
    process.stdout.write(
      `${String(total).padStart(6)} counted  ${String(totalJsdoc).padStart(6)} jsdoc  ${String(totalExempt).padStart(5)} exempt  TOTAL\n`
    );
    return;
  }

  if (args.includes('--update')) {
    const { scopes } = collectCounts(repoRoot);
    const baseline = { version: 1, scopes: {} };
    for (const [scope, entry] of [...scopes.entries()].sort()) {
      baseline.scopes[scope] = entry.counted;
    }
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`Updated ${path.relative(repoRoot, baselinePath)}\n`);
    return;
  }

  const comparison = resolveComparison(repoRoot);
  if (comparison.kind === 'change') checkChange(comparison);
  else checkBaseline();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
