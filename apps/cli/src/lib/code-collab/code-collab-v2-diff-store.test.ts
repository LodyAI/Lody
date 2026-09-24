import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionId, WorkspaceId } from '@lody/shared';
import { CodeCollabV2DiffStore } from './code-collab-v2-diff-store';

const SESSION_ID = 'session-v2' as SessionId;
const WORKSPACE_ID = 'workspace-v2' as WorkspaceId;
const DAY_MS = 24 * 60 * 60 * 1000;

async function withStore<T>(
  fn: (store: CodeCollabV2DiffStore, workspaceRoot: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-code-collab-v2-diff-store-'));
  const store = new CodeCollabV2DiffStore(WORKSPACE_ID, {
    dbPath: path.join(root, 'diff-store.sqlite3'),
    retentionDays: 1,
  });
  try {
    return await fn(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('CodeCollabV2DiffStore', () => {
  it('stores exact turn snapshots and keeps the earliest old snapshot', async () => {
    await withStore(async (store, workspaceRoot) => {
      const absolutePath = path.join(workspaceRoot, 'src', 'app.ts');
      const turnOneFileDiff = await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [
          {
            path: absolutePath,
            oldText: 'one\n',
            newText: 'one\ntwo\n',
          },
        ],
      });
      const turnTwoFileDiff = await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-2',
        capturedAtMs: 2000,
        recordedAtMs: 2000,
        events: [
          {
            path: absolutePath,
            oldText: 'one\ntwo\n',
            newText: 'three\n',
          },
        ],
      });

      expect(turnOneFileDiff).toEqual([{ filePath: 'src/app.ts', add: 1, del: 0 }]);
      expect(turnTwoFileDiff).toEqual([{ filePath: 'src/app.ts', add: 1, del: 2 }]);
      expect(
        await store.listTurnFileDiffs({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          nowMs: 3000,
        })
      ).toEqual([{ filePath: 'src/app.ts', add: 1, del: 0 }]);
      expect(await store.listChangedPaths({ ownerSessionId: SESSION_ID, nowMs: 3000 })).toEqual([
        'src/app.ts',
      ]);
      expect(
        await store.getEarliestOldSnapshot({
          ownerSessionId: SESSION_ID,
          path: 'src/app.ts',
          nowMs: 3000,
        })
      ).toEqual({ status: 'ready', text: 'one\n' });
      expect(
        await store.getTurnDiffSnapshot({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          path: 'src/app.ts',
          nowMs: 3000,
        })
      ).toEqual({ status: 'ready', oldText: 'one\n', newText: 'one\ntwo\n' });
      expect(
        await store.getTurnDiffSnapshot({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-2',
          path: 'src/app.ts',
          nowMs: 3000,
        })
      ).toEqual({ status: 'ready', oldText: 'one\ntwo\n', newText: 'three\n' });
    });
  });

  it('exposes getLatestText so turn diffs can chain (old = previous recorded new)', async () => {
    await withStore(async (store, workspaceRoot) => {
      const absolutePath = path.join(workspaceRoot, 'note.txt');

      expect(await store.getLatestText({ ownerSessionId: SESSION_ID, path: 'note.txt' })).toEqual({
        status: 'untracked',
      });

      await writeFile(absolutePath, 'B\n');
      await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [{ path: absolutePath, oldText: 'A\n', newText: 'B\n' }],
      });
      expect(await store.getLatestText({ ownerSessionId: SESSION_ID, path: 'note.txt' })).toEqual({
        status: 'tracked',
        text: 'B\n',
      });

      // Turn 2 chains: old = the previous recorded new (B), new = C — no commit needed.
      const chained = await store.getLatestText({ ownerSessionId: SESSION_ID, path: 'note.txt' });
      await writeFile(absolutePath, 'C\n');
      await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-2',
        capturedAtMs: 2000,
        recordedAtMs: 2000,
        events: [
          {
            path: absolutePath,
            oldText: chained.status === 'tracked' ? chained.text : null,
            newText: 'C\n',
          },
        ],
      });

      // Each turn stays scoped to that turn — not cumulative.
      expect(
        await store.getTurnDiffSnapshot({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          path: 'note.txt',
          nowMs: 3000,
        })
      ).toEqual({ status: 'ready', oldText: 'A\n', newText: 'B\n' });
      expect(
        await store.getTurnDiffSnapshot({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-2',
          path: 'note.txt',
          nowMs: 3000,
        })
      ).toEqual({ status: 'ready', oldText: 'B\n', newText: 'C\n' });
      expect(await store.getLatestText({ ownerSessionId: SESSION_ID, path: 'note.txt' })).toEqual({
        status: 'tracked',
        text: 'C\n',
      });
    });
  });

  it('reads exact turn snapshots through the async store API', async () => {
    await withStore(async (store, workspaceRoot) => {
      const absolutePath = path.join(workspaceRoot, 'src', 'app.ts');
      await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [{ path: absolutePath, oldText: 'one\n', newText: 'one\ntwo\n' }],
      });

      const query = {
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        path: 'src/app.ts',
        nowMs: 3000,
      } as const;

      expect(await store.getTurnDiffSnapshot(query)).toEqual({
        status: 'ready',
        oldText: 'one\n',
        newText: 'one\ntwo\n',
      });

      expect(await store.getTurnDiffSnapshot({ ...query, turnId: 'missing-turn' })).toEqual({
        status: 'unavailable',
      });
    });
  });

  it('drops expired events and ignores evidence outside the workspace', async () => {
    await withStore(async (store, workspaceRoot) => {
      const fileDiff = await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [
          {
            path: path.join(workspaceRoot, 'notes.txt'),
            oldText: null,
            newText: 'new\n',
          },
          {
            path: path.join(workspaceRoot, '..', 'outside.txt'),
            oldText: null,
            newText: 'ignore\n',
          },
        ],
      });

      expect(fileDiff).toEqual([{ filePath: 'notes.txt', add: 1, del: 0 }]);
      expect(await store.listChangedPaths({ ownerSessionId: SESSION_ID, nowMs: 1000 })).toEqual([
        'notes.txt',
      ]);
      await store.gc(1000 + DAY_MS + 1);
      expect(
        await store.listChangedPaths({ ownerSessionId: SESSION_ID, nowMs: 1000 + DAY_MS + 1 })
      ).toEqual([]);
      expect(
        await store.listTurnFileDiffs({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          nowMs: 1000 + DAY_MS + 1,
        })
      ).toEqual([]);
      expect(
        await store.getEarliestOldSnapshot({
          ownerSessionId: SESSION_ID,
          path: 'notes.txt',
          nowMs: 1000 + DAY_MS + 1,
        })
      ).toEqual({ status: 'unavailable' });
      expect(
        await store.getTurnDiffSnapshot({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          path: 'notes.txt',
          nowMs: 1000 + DAY_MS + 1,
        })
      ).toEqual({ status: 'unavailable' });
    });
  });

  it('keeps the first old text and last new text for repeated edits in one turn', async () => {
    await withStore(async (store, workspaceRoot) => {
      const absolutePath = path.join(workspaceRoot, 'created.txt');
      const fileDiff = await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [
          {
            path: absolutePath,
            oldText: null,
            newText: 'draft\n',
          },
          {
            path: absolutePath,
            oldText: 'draft\n',
            newText: 'final\n',
          },
        ],
      });

      expect(fileDiff).toEqual([{ filePath: 'created.txt', add: 1, del: 0 }]);
      expect(
        await store.getEarliestOldSnapshot({
          ownerSessionId: SESSION_ID,
          path: 'created.txt',
          nowMs: 1000,
        })
      ).toEqual({ status: 'ready', text: null });
      expect(
        await store.getTurnDiffSnapshot({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          path: 'created.txt',
          nowMs: 1000,
        })
      ).toEqual({ status: 'ready', oldText: null, newText: 'final\n' });
    });
  });

  it('keeps zero-line file changes as clickable per-turn file diffs', async () => {
    await withStore(async (store, workspaceRoot) => {
      const fileDiff = await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [
          {
            path: path.join(workspaceRoot, 'empty-created.txt'),
            oldText: null,
            newText: '',
          },
          {
            path: path.join(workspaceRoot, 'empty-deleted.txt'),
            oldText: '',
            newText: null,
          },
          {
            path: path.join(workspaceRoot, 'unchanged.txt'),
            oldText: 'same\n',
            newText: 'same\n',
          },
        ],
      });

      expect(fileDiff).toEqual([
        { filePath: 'empty-created.txt', add: 0, del: 0 },
        { filePath: 'empty-deleted.txt', add: 0, del: 0 },
        { filePath: 'unchanged.txt', add: 0, del: 0 },
      ]);
      expect(
        await store.listTurnFileDiffs({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          nowMs: 1000,
        })
      ).toEqual([
        { filePath: 'empty-created.txt', add: 0, del: 0 },
        { filePath: 'empty-deleted.txt', add: 0, del: 0 },
        { filePath: 'unchanged.txt', add: 0, del: 0 },
      ]);
    });
  });

  it('counts a trailing-newline-only change like git (1 add / 1 del)', async () => {
    await withStore(async (store, workspaceRoot) => {
      const fileDiff = await store.recordTurnDiffs({
        workspaceRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [
          {
            path: path.join(workspaceRoot, 'newline.txt'),
            oldText: 'one\n',
            newText: 'one',
          },
        ],
      });

      // git diff --numstat reports the "\ No newline at end of file" change as 1/1;
      // the old prefix/suffix estimate dropped it to 0/0.
      expect(fileDiff).toEqual([{ filePath: 'newline.txt', add: 1, del: 1 }]);
      expect(
        await store.getTurnDiffSnapshot({
          ownerSessionId: SESSION_ID,
          turnId: 'turn-1',
          path: 'newline.txt',
          nowMs: 1000,
        })
      ).toEqual({ status: 'ready', oldText: 'one\n', newText: 'one' });
    });
  });

  it('accepts evidence paths that use the workspace realpath spelling', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'lody-code-collab-v2-diff-store-realpath-'));
    const linkRoot = path.join(parent, 'link');
    const actualRealRoot = await mkdtemp(path.join(parent, 'actual-'));
    await symlink(actualRealRoot, linkRoot, 'dir');
    const store = new CodeCollabV2DiffStore(WORKSPACE_ID, {
      dbPath: path.join(parent, 'diff-store.sqlite3'),
      retentionDays: 1,
    });
    try {
      const fileDiff = await store.recordTurnDiffs({
        workspaceRoot: linkRoot,
        ownerSessionId: SESSION_ID,
        turnId: 'turn-1',
        capturedAtMs: 1000,
        recordedAtMs: 1000,
        events: [
          {
            path: path.join(actualRealRoot, 'src', 'app.ts'),
            oldText: 'old\n',
            newText: 'new\n',
          },
        ],
      });

      expect(fileDiff).toEqual([{ filePath: 'src/app.ts', add: 1, del: 1 }]);
    } finally {
      await store.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
