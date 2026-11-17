import { existsSync } from 'node:fs';
import path from 'node:path';

const MODULE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

/**
 * Whether Vitest's import graph can see every effect of this changed file.
 * Config, setup files, `__mocks__`, fixtures and non-module inputs are loaded
 * by configuration or the filesystem rather than imported, so they cannot be
 * traced from a test file.
 */
function isTraceableModule(filePath, exists) {
  if (!/^(apps|packages)\//.test(filePath)) return false;
  if (filePath.startsWith('packages/acp-extension-')) return false;
  if (!MODULE_EXTENSIONS.has(path.posix.extname(filePath))) return false;
  const segments = filePath.split('/');
  if (!segments.some((segment) => ['src', 'test', 'tests'].includes(segment))) return false;
  if (segments.some((segment) => ['fixtures', '__fixtures__', '__mocks__'].includes(segment))) {
    return false;
  }
  if (/setup|\.config\./i.test(path.posix.basename(filePath))) return false;
  return exists(filePath);
}

/**
 * Repository-relative files for `vitest related`, or null when the affected
 * package suites must run in full. Only an affected pull-request scope may
 * narrow; markdown never influences a Vitest import graph and is ignored.
 * Deleted files return null: their former importers cannot be traced.
 */
export function relatedTestFiles(
  scope,
  { exists = (filePath) => existsSync(filePath), root = process.cwd() } = {}
) {
  if (scope?.mode !== 'affected' || !Array.isArray(scope.changedFiles)) return null;
  const files = scope.changedFiles.filter((filePath) => !filePath.endsWith('.md'));
  if (files.length === 0) return null;
  const existsInRoot = (filePath) => exists(path.join(root, filePath));
  return files.every((filePath) => isTraceableModule(filePath, existsInRoot)) ? files : null;
}

/** Vitest flags shared by every related run: shards and filtered projects may match nothing. */
export const RELATED_FLAGS = ['--run', '--passWithNoTests'];
