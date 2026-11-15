import {
  codeCollabFileIndexToSharedState,
  type CodeCollabV2AllChangesState,
  type CodeCollabV2FileIndexState,
  type CodeCollabV2FileTreeState,
  type SessionId,
} from '@lody/shared';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll } from 'vitest';
import {
  CodeCollabV2Service,
  type CodeCollabV2FileIndexPublication,
  type CodeCollabV2FileIndexSignalPublication,
  type CodeCollabV2WorkspaceResolver,
} from '../src/lib/code-collab/code-collab-v2-service';
import type {
  WorkspaceWatchCoordinatorApi,
  WorkspaceWatchDirtyReason,
} from '../src/lib/code-collab/workspace-watch-coordinator';

const SESSION_ID = 'session-v2' as SessionId;

const execFileAsync = promisify(execFile);

const digestText = (text: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;

const digestRaw = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

type PublishedSharedState = {
  readonly fileTree: CodeCollabV2FileTreeState;
  readonly allChanges: CodeCollabV2AllChangesState;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly allChangesDiffStats: CodeCollabV2FileIndexPublication['allChangesDiffStats'];
  readonly persistAllChangesDiffStats: boolean;
  readonly updatedAtMs: number;
};

function collectPublishedSharedStates(): {
  readonly published: PublishedSharedState[];
  readonly signals: CodeCollabV2FileIndexSignalPublication[];
  readonly publishFileIndex: (state: CodeCollabV2FileIndexPublication) => Promise<void>;
  readonly publishFileIndexSignal: (state: CodeCollabV2FileIndexSignalPublication) => Promise<void>;
} {
  const published: PublishedSharedState[] = [];
  const signals: CodeCollabV2FileIndexSignalPublication[] = [];
  return {
    published,
    signals,
    publishFileIndex: async (state) => {
      const { fileTree, allChanges } = codeCollabFileIndexToSharedState(state.fileIndex);
      published.push({
        fileTree,
        allChanges,
        fileIndex: state.fileIndex,
        allChangesDiffStats: state.allChangesDiffStats,
        persistAllChangesDiffStats: state.persistAllChangesDiffStats,
        updatedAtMs: state.updatedAtMs,
      });
    },
    publishFileIndexSignal: async (state) => {
      signals.push(state);
    },
  };
}

const makeResolver =
  (workspaceRoot: string): CodeCollabV2WorkspaceResolver =>
  async () => ({
    ok: true,
    ownerSessionId: SESSION_ID,
    workspaceRoot,
  });

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lody-code-collab-v2-'));
  try {
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function activeWorkspaceWatchCount(service: CodeCollabV2Service): number {
  return (
    service as unknown as {
      readonly watchByOwnerSessionId: ReadonlyMap<SessionId, unknown>;
    }
  ).watchByOwnerSessionId.size;
}

function makeWorkspaceWatchCoordinator(): {
  coordinator: WorkspaceWatchCoordinatorApi;
  dirty: (reason?: WorkspaceWatchDirtyReason) => void;
  releaseCount: () => number;
} {
  let onDirty: ((reason: WorkspaceWatchDirtyReason) => void) | null = null;
  let releases = 0;
  return {
    coordinator: {
      subscribe: async (options) => {
        onDirty = options.onDirty;
        return {
          canonicalRoot: options.workspaceRoot,
          release: () => {
            releases += 1;
          },
        };
      },
    },
    dirty: (reason = 'event') => onDirty?.(reason),
    releaseCount: () => releases,
  };
}

let gitInitSeedDir: string | undefined;

async function initGitRepoWithCommit(workspaceRoot: string): Promise<void> {
  if (!gitInitSeedDir) {
    const seed = await mkdtemp(path.join(tmpdir(), 'lody-cc-git-seed-'));
    await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: seed });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: seed });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: seed });
    gitInitSeedDir = seed;
  }
  await cp(path.join(gitInitSeedDir, '.git'), path.join(workspaceRoot, '.git'), {
    recursive: true,
  });
}

async function gitCommitAll(workspaceRoot: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: workspaceRoot });
  await execFileAsync('git', ['commit', '-m', message], { cwd: workspaceRoot });
}

const plainSnapshotText = (snapshot: { kind: string }): string | undefined => {
  if (snapshot.kind !== 'text') return undefined;
  const payload = (snapshot as { text: { encoding: string; text?: string } }).text;
  return payload.encoding === 'plain' ? payload.text : undefined;
};

const gitText = async (workspaceRoot: string, ...args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd: workspaceRoot })).stdout.trim();

const entryPaths = (
  result: Awaited<ReturnType<CodeCollabV2Service['openAllChangesDiff']>>
): string[] => {
  if (result.status !== 'ok') throw new Error(`Expected ok, received ${result.status}`);
  return result.entries.map((entry) => entry.path).sort();
};
export {
  activeWorkspaceWatchCount,
  collectPublishedSharedStates,
  digestRaw,
  digestText,
  entryPaths,
  execFileAsync,
  gitCommitAll,
  gitInitSeedDir,
  gitText,
  initGitRepoWithCommit,
  makeResolver,
  makeWorkspaceWatchCoordinator,
  plainSnapshotText,
  PublishedSharedState,
  SESSION_ID,
  withWorkspace,
};

export function registerCodeCollabSeedCleanup() {
  afterAll(async () => {
    if (gitInitSeedDir) {
      await rm(gitInitSeedDir, { recursive: true, force: true });
      gitInitSeedDir = undefined;
    }
  });
}
