import type { MessagePort } from 'node:worker_threads';
import { opendir } from 'node:fs/promises';
import path from 'node:path';

import {
  buildCodeCollabFileIndexState,
  type CodeCollabV2AllChangesState,
  type CodeCollabV2FileIndexState,
  type CodeCollabV2FileTreeValue,
} from '@lody/shared';

import { closeDirectoryQuietly } from './directory-handle';
import {
  computeAllChanges,
  isInsideGitWorktree,
  joinWorkspacePath,
  pathSegmentComparisonKey,
  scanGitDirectoryEntries,
} from './file-index-scan-core';

export type FileIndexScanWorkerInput = {
  readonly kind?: 'scan';
  readonly cancellationPort?: MessagePort;
  readonly cancellationId?: string;
  readonly signal?: AbortSignal;
  readonly directoryAbsolutePath: string;
  readonly directoryWorkspacePath: string;
  readonly maxRawTextBytes: number;
  readonly entryBudget: number;
  readonly recursive: boolean;
};

export type FileIndexScanWorkerResult = {
  readonly kind: 'scan';
  readonly entries: readonly (readonly [string, CodeCollabV2FileTreeValue])[];
};

export type FileIndexFullStateWorkerInput = {
  readonly kind: 'full-state';
  readonly cancellationPort?: MessagePort;
  readonly cancellationId?: string;
  readonly signal?: AbortSignal;
  readonly workspaceRoot: string;
  readonly maxRawTextBytes: number;
  readonly entryBudget: number;
  readonly preferredBaseBranch?: string;
  readonly providedAllChanges?: {
    readonly source: 'diff-store';
    readonly state: CodeCollabV2AllChangesState;
    readonly computeMs: number;
  };
};

export type FileIndexFullStateWorkerResult =
  | {
      readonly kind: 'full-state';
      readonly status: 'ok';
      readonly fileTreeEntries: readonly (readonly [string, CodeCollabV2FileTreeValue])[];
      readonly allChanges: CodeCollabV2AllChangesState;
      readonly fileIndex: CodeCollabV2FileIndexState;
      readonly allChangesSource: 'git' | 'diff-store';
      readonly changedPaths: number;
      readonly pathCount: number;
      readonly durationMs: number;
      readonly scanMs: number;
      readonly allChangesMs: number;
      readonly buildMs: number;
    }
  | {
      readonly kind: 'full-state';
      readonly status: 'needs-provided-all-changes';
      readonly reason: 'not-git';
    };

export type FileIndexWorkerInput = FileIndexScanWorkerInput | FileIndexFullStateWorkerInput;
export type FileIndexWorkerResult = FileIndexScanWorkerResult | FileIndexFullStateWorkerResult;

const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
]);

export default async function fileIndexScanWorker(
  input: FileIndexWorkerInput
): Promise<FileIndexWorkerResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('File-index scan cancelled', 'AbortError'));
  const port = input.cancellationPort;
  port?.on('message', abort);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  const onMessage = (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'cancellationId' in message &&
      message.cancellationId === input.cancellationId &&
      'type' in message &&
      message.type === 'code-collab-abort'
    )
      abort();
  };
  try {
    if (input.cancellationId) {
      process.on('message', onMessage);
      process.send?.({ cancellationId: input.cancellationId, type: 'code-collab-ready' });
    }
    signal.throwIfAborted();
    if (input.kind === 'full-state') {
      return await computeFullFileIndexState({ ...input, signal });
    }
    const entries = await scanDirectoryEntries({ ...input, signal });
    return { kind: 'scan', entries: [...entries] };
  } finally {
    if (input.cancellationId) process.off('message', onMessage);
    port?.off('message', abort);
    port?.close();
  }
}

async function computeFullFileIndexState(
  input: FileIndexFullStateWorkerInput
): Promise<FileIndexFullStateWorkerResult> {
  const startedAtMs = Date.now();
  const allChangesResult = await resolveFullStateAllChanges(input);
  if (allChangesResult.status !== 'ok') {
    return {
      kind: 'full-state',
      status: 'needs-provided-all-changes',
      reason: allChangesResult.reason,
    };
  }

  const scanStartedAtMs = Date.now();
  const fileTreeEntries = await scanDirectoryEntries({
    directoryAbsolutePath: input.workspaceRoot,
    directoryWorkspacePath: '',
    maxRawTextBytes: input.maxRawTextBytes,
    entryBudget: input.entryBudget,
    recursive: true,
    signal: input.signal,
  });
  const scanMs = Date.now() - scanStartedAtMs;
  const fileTree = Object.fromEntries(fileTreeEntries);
  const buildStartedAtMs = Date.now();
  const fileIndex = buildCodeCollabFileIndexState(fileTree, allChangesResult.allChanges);
  const buildMs = Date.now() - buildStartedAtMs;
  return {
    kind: 'full-state',
    status: 'ok',
    fileTreeEntries: [...fileTreeEntries],
    allChanges: allChangesResult.allChanges,
    fileIndex,
    allChangesSource: allChangesResult.source,
    changedPaths: Object.keys(allChangesResult.allChanges).length,
    pathCount: Object.keys(fileIndex).length,
    durationMs: Date.now() - startedAtMs,
    scanMs,
    allChangesMs: allChangesResult.allChangesMs,
    buildMs,
  };
}

async function resolveFullStateAllChanges(input: FileIndexFullStateWorkerInput): Promise<
  | {
      readonly status: 'ok';
      readonly source: 'git' | 'diff-store';
      readonly allChanges: CodeCollabV2AllChangesState;
      readonly allChangesMs: number;
    }
  | { readonly status: 'needs-provided-all-changes'; readonly reason: 'not-git' }
> {
  if (input.providedAllChanges) {
    return {
      status: 'ok',
      source: input.providedAllChanges.source,
      allChanges: input.providedAllChanges.state,
      allChangesMs: input.providedAllChanges.computeMs,
    };
  }
  if (!(await isInsideGitWorktree(input.workspaceRoot, input.signal))) {
    return { status: 'needs-provided-all-changes', reason: 'not-git' };
  }

  const allChangesStartedAtMs = Date.now();
  const allChanges = await computeAllChanges(input.workspaceRoot, {
    preferredBaseBranch: input.preferredBaseBranch,
    signal: input.signal,
  });
  return {
    status: 'ok',
    source: 'git',
    allChanges,
    allChangesMs: Date.now() - allChangesStartedAtMs,
  };
}

async function scanDirectoryEntries(
  options: FileIndexScanWorkerInput
): Promise<Map<string, CodeCollabV2FileTreeValue>> {
  const gitEntries = await scanGitDirectoryEntries(options);
  if (gitEntries) {
    return gitEntries;
  }

  const entries = new Map<string, CodeCollabV2FileTreeValue>();
  const queue: Array<{ readonly absolutePath: string; readonly workspacePath: string }> = [
    {
      absolutePath: options.directoryAbsolutePath,
      workspacePath: options.directoryWorkspacePath,
    },
  ];
  let remainingEntries = Math.max(0, options.entryBudget);

  while (queue.length > 0 && remainingEntries > 0) {
    options.signal?.throwIfAborted();
    const currentDirectory = queue.shift();
    if (!currentDirectory) {
      break;
    }

    const directoryEntries = await readDirectoryEntriesForScan(currentDirectory).catch(
      (error: unknown) => {
        if (currentDirectory.workspacePath === options.directoryWorkspacePath) {
          throw error;
        }
        entries.set(currentDirectory.workspacePath, scanDirectoryReadErrorValue(error));
        return null;
      }
    );
    if (!directoryEntries) {
      continue;
    }
    const collisionKeys = findDirectoryEntryCollisionKeys(directoryEntries);
    for (const { entry, comparisonKey } of directoryEntries) {
      if (remainingEntries <= 0) {
        break;
      }
      const workspacePath = joinWorkspacePath(currentDirectory.workspacePath, entry.name);
      const absolutePath = path.join(currentDirectory.absolutePath, entry.name);
      const value = collisionKeys.has(comparisonKey)
        ? ({ kind: 'skipped', reason: 'path_conflict' } as const)
        : classifyDirectoryEntry(entry);
      if (value === undefined) {
        continue;
      }
      entries.set(workspacePath, value);
      remainingEntries -= 1;
      if (options.recursive && isLazyDirectoryValue(value) && remainingEntries > 0) {
        queue.push({ absolutePath, workspacePath });
      }
    }
  }
  return entries;
}

function scanDirectoryReadErrorValue(error: unknown): CodeCollabV2FileTreeValue {
  const code = errorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return { kind: 'skipped', reason: 'permission_denied' };
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { kind: 'skipped', reason: 'not_found' };
  }
  return { kind: 'skipped', reason: 'transient_io' };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function readDirectoryEntriesForScan(directoryPath: {
  readonly absolutePath: string;
}): Promise<
  Array<{
    readonly entry: {
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    };
    readonly comparisonKey: string;
  }>
> {
  const directory = await opendir(directoryPath.absolutePath);
  try {
    const directoryEntries: Array<{
      readonly entry: {
        readonly name: string;
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
      };
      readonly comparisonKey: string;
    }> = [];
    for await (const entry of directory) {
      if (entry.name === '.' || entry.name === '..') {
        continue;
      }
      directoryEntries.push({
        entry,
        comparisonKey: pathSegmentComparisonKey(entry.name),
      });
    }
    return directoryEntries.sort((left, right) => {
      const keyOrder = left.comparisonKey.localeCompare(right.comparisonKey);
      return keyOrder === 0 ? left.entry.name.localeCompare(right.entry.name) : keyOrder;
    });
  } finally {
    await closeDirectoryQuietly(directory);
  }
}

function classifyDirectoryEntry(entry: {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): CodeCollabV2FileTreeValue | undefined {
  if (entry.isDirectory()) {
    return DEFAULT_IGNORED_DIRECTORY_NAMES.has(entry.name)
      ? undefined
      : ({ kind: 'lazy' } as const);
  }
  if (entry.isSymbolicLink()) {
    return { kind: 'skipped', reason: 'symlink' };
  }
  if (!entry.isFile()) {
    return { kind: 'skipped', reason: 'special' };
  }
  return true;
}

function findDirectoryEntryCollisionKeys(
  entries: readonly { readonly entry: { readonly name: string }; readonly comparisonKey: string }[]
): Set<string> {
  const namesByKey = new Map<string, Set<string>>();
  for (const { entry, comparisonKey } of entries) {
    const names = namesByKey.get(comparisonKey);
    if (names) {
      names.add(entry.name);
    } else {
      namesByKey.set(comparisonKey, new Set([entry.name]));
    }
  }
  const collisionKeys = new Set<string>();
  for (const [comparisonKey, names] of namesByKey) {
    if (names.size > 1) {
      collisionKeys.add(comparisonKey);
    }
  }
  return collisionKeys;
}

function isLazyDirectoryValue(value: CodeCollabV2FileTreeValue | undefined): boolean {
  return value !== undefined && value !== true && value.kind === 'lazy';
}
