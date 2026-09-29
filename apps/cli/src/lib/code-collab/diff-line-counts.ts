import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { diffLines } from 'diff';

import { runCommandTextSync } from '@/platform/promise-facade';

/**
 * Added/deleted line counts for a single file change, as `[add, del]`.
 *
 * The goal is to match what `git diff --numstat` reports. We compute it with a
 * real line-level diff (jsdiff = Myers O(N*D)) instead of the old prefix/suffix
 * estimate, which collapsed everything between the first and last differing line
 * into "old=all deleted, new=all added" and badly over-counted scattered edits.
 *
 * jsdiff can be catastrophically slow on pathological inputs (a near-full
 * rewrite of a large file is O(N^2) and was measured at ~30s for 10k lines), so
 * the fallback chain is:
 *   1. jsdiff with a `maxEditLength` cap (bounded to ~50ms worst case);
 *   2. on cap/bail, shell out to `git diff --no-index --numstat` for the exact
 *      git numbers (when git is available);
 *   3. otherwise the cheap prefix/suffix estimate as a last resort.
 *
 * This module is intentionally dependency-light (`diff`, node builtins and the
 * platform process facade) so it can be bundled into the standalone diff worker entry.
 */

/**
 * jsdiff bail cost is dominated by the diagonal walk, ~O(maxEditLength^2), and is
 * empirically near-independent of N: a `maxEditLength` of 2000 took ~600ms at both
 * N=2k and N=10k on the dev box. ~600 therefore lands around the ~50ms target.
 * Tune here if the host class changes.
 */
const MAX_EDIT_LENGTH = 600;

/**
 * For very large files even a successful diff pays an O(N) snake-traversal term per
 * diagonal, which can exceed the time budget before the edit-length cap bites. Past
 * this combined line count we skip jsdiff and let git compute it instead.
 */
const MAX_LINES_FOR_JSDIFF = 200_000;

/** `git diff --no-index` capture cap; turn snapshots are already <= ~1MiB. */
const GIT_NUMSTAT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Both git calls block the worker thread, so each is bounded. A timed-out numstat
 * falls through to the prefix/suffix estimate like any other git failure.
 */
const GIT_VERSION_TIMEOUT_MS = 10_000;
const GIT_NUMSTAT_TIMEOUT_MS = 30_000;

export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function splitTextForDiffStats(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split('\n');
  if (text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/**
 * Cheap last-resort estimate: trim the common leading/trailing lines and treat the
 * middle as fully changed. Correct only for a single contiguous edit; over-counts
 * scattered edits. Kept solely as the final fallback when both jsdiff and git punt.
 */
export function prefixSuffixLineCounts(oldText: string, newText: string): [number, number] {
  const oldLines = splitTextForDiffStats(oldText);
  const newLines = splitTextForDiffStats(newText);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [newLines.length - prefix - suffix, oldLines.length - prefix - suffix];
}

/** Exact line-level diff via jsdiff, or `null` when it would exceed the time budget. */
function jsdiffLineCounts(oldText: string, newText: string): [number, number] | null {
  const totalLines = countTextLines(oldText) + countTextLines(newText);
  if (totalLines > MAX_LINES_FOR_JSDIFF) {
    return null;
  }
  const parts = diffLines(oldText, newText, { maxEditLength: MAX_EDIT_LENGTH });
  if (!parts) {
    // Edit distance exceeded MAX_EDIT_LENGTH: jsdiff bailed.
    return null;
  }
  let add = 0;
  let del = 0;
  for (const part of parts) {
    if (part.added) add += part.count ?? 0;
    else if (part.removed) del += part.count ?? 0;
  }
  return [add, del];
}

let gitAvailable: boolean | undefined;

function isGitAvailable(): boolean {
  if (gitAvailable === undefined) {
    try {
      gitAvailable =
        runCommandTextSync({
          command: 'git',
          args: ['--version'],
          timeout: GIT_VERSION_TIMEOUT_MS,
          check: 'none',
        }).code === 0;
    } catch {
      gitAvailable = false;
    }
  }
  return gitAvailable;
}

const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t/m;

/**
 * Exact counts from `git diff --no-index --numstat` over two temp files, or `null`
 * when git is unavailable, errors, or reports a binary diff (`-\t-`).
 */
function gitNumstatLineCounts(oldText: string, newText: string): [number, number] | null {
  if (!isGitAvailable()) {
    return null;
  }
  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'lody-diff-'));
    const oldPath = path.join(dir, 'old');
    const newPath = path.join(dir, 'new');
    writeFileSync(oldPath, oldText);
    writeFileSync(newPath, newText);
    const result = runCommandTextSync({
      command: 'git',
      args: ['diff', '--no-index', '--numstat', '--', oldPath, newPath],
      maxOutputBytes: GIT_NUMSTAT_MAX_BUFFER,
      timeout: GIT_NUMSTAT_TIMEOUT_MS,
      check: 'none',
    });
    // Exit 0 = identical, 1 = differences (expected), >1 = real error.
    if (result.code !== 0 && result.code !== 1) {
      return null;
    }
    const match = NUMSTAT_LINE.exec(result.stdout);
    if (!match) {
      // No diff line: identical content.
      return result.code === 0 ? [0, 0] : null;
    }
    if (match[1] === '-' || match[2] === '-') {
      // Binary diff: git reports no line counts.
      return null;
    }
    const add = Number.parseInt(match[1] ?? '', 10);
    const del = Number.parseInt(match[2] ?? '', 10);
    if (!Number.isFinite(add) || !Number.isFinite(del)) {
      return null;
    }
    return [add, del];
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** Added/deleted line counts for two text snapshots, matching git as closely as possible. */
export function computeTextLineCounts(oldText: string, newText: string): [number, number] {
  return (
    jsdiffLineCounts(oldText, newText) ??
    gitNumstatLineCounts(oldText, newText) ??
    prefixSuffixLineCounts(oldText, newText)
  );
}

/** Line counts for a diff where either side may be absent (file created/deleted). */
export function computeLineCounts(
  oldText: string | null,
  newText: string | null
): [number, number] {
  if (oldText !== null && newText !== null) {
    return computeTextLineCounts(oldText, newText);
  }
  if (oldText === null && newText !== null) {
    return [countTextLines(newText), 0];
  }
  if (oldText !== null && newText === null) {
    return [0, countTextLines(oldText)];
  }
  return [0, 0];
}

export type DiffLineCountInput = {
  readonly oldText: string | null;
  readonly newText: string | null;
};
