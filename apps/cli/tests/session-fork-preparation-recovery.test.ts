import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  SessionStatusFactory,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { SessionDocument } from '../src/lib/loro/doc';
import {
  abandonSessionAccountEdit,
  beginSessionAccountEdit,
  commitSessionAccountEdit,
  createSessionAccountForkBinding,
  getSessionAccountBinding,
  hashSessionAccountEditHistory,
  resolveSessionAccountMeta,
  setSessionAccountBinding,
} from '../src/session/session-account-binding-store';
import { createSessionAccountEditRecovery } from '../src/session/session-account-edit-recovery';
import {
  createFileSessionForkOperationStore,
  type SessionForkOperationMarker,
} from '../src/session/session-fork-operation-store';
import { cloneHistoryThroughTurn, SessionForkService } from '../src/session/session-fork-service';

const sourceId = 'durable-fork-source';
const targetId = 'durable-fork-target';
const scope = { workspaceId: 'workspace', machineId: 'machine', sessionId: targetId };
const operationId = `session-fork:${targetId}`;
const managedProfile = '00000000-0000-4000-8000-00000000000b';
const sourceHistory: SessionHistoryInput[] = [
  {
    id: 'user-source',
    timestamp: '2026-09-06T00:00:00.000Z',
    role: 'user',
    items: [{ type: 'text', text: 'Synthetic source prompt' }],
    fileDiff: [],
    finished: true,
    read: true,
    status: 'handled',
  },
  {
    id: 'assistant-source',
    timestamp: '2026-09-06T00:00:01.000Z',
    role: 'assistant',
    items: [{ type: 'text', text: 'Synthetic source answer' }],
    fileDiff: [],
    finished: true,
    read: true,
    acpTurnId: 'native-source-turn',
  },
];

let directory: string;
const cleanups = new Set<() => Promise<void>>();
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lody-fork-preparation-recovery-'));
  vi.stubEnv('LODY_DATA_DIR', directory);
  vi.stubEnv('LODY_PLATFORM', 'local');
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
});
afterEach(async () => {
  for (const close of [...cleanups]) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function sessionMeta(id: string, profile: string): SessionMeta {
  return {
    id,
    machineId: 'machine',
    accountProfileId: profile,
    createdAt: '2026-09-06T00:00:00.000Z',
    lastMessageAt: 1,
    title: id,
    userId: 'synthetic-user',
    status: SessionStatusFactory.idle(),
    isArchived: false,
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: 'synthetic-config',
  };
}

async function openWorkspace() {
  const store = new SqliteRepoStore({ path: path.join(directory, 'repo.sqlite3') });
  const repo = await LoroRepo.create({ storageAdapter: store.storage });
  const documents = new Map<SessionId, SessionDocument>();
  const opened: SessionId[] = [];
  const document = async (id: SessionId) => {
    const existing = documents.get(id);
    if (existing) return existing;
    opened.push(id);
    const created = new SessionDocument(repo, id, async () => undefined);
    await created.init({ skipAutoRead: true });
    documents.set(id, created);
    return created;
  };
  const closeDocument = async (id: SessionId) => {
    await documents.get(id)?.destroy({ preserveStatus: true });
    documents.delete(id);
  };
  const close = async () => {
    if (!cleanups.delete(close)) return;
    for (const id of [...documents.keys()]) await closeDocument(id);
    await repo.destroy();
  };
  cleanups.add(close);
  const workspaceDocument = {
    repo,
    getOrCreateSessionDoc: document,
    getSessionHistorySnapshot: async (id: SessionId) => await (await document(id)).getHistory(),
    cleanSessionDoc: closeDocument,
    unloadDocRoom: async (roomId: string) => {
      for (const id of documents.keys()) {
        if (getSessionRoomId(id) === roomId) await closeDocument(id);
      }
    },
    persistPendingChanges: async () => await repo.flush(),
  };
  const worktreeCleanup = vi.fn(async () => {});
  const errors: string[] = [];
  const markerStore = createFileSessionForkOperationStore();
  const service = new SessionForkService({
    workspaceDocument: workspaceDocument as never,
    sessionManager: {
      terminateSession: async () => {},
      cleanupForkWorktree: worktreeCleanup,
    } as never,
    userResolver: {} as never,
    logger: { error: (error: string) => errors.push(error), warn: () => {} } as never,
    workspaceId: scope.workspaceId,
    machineId: scope.machineId,
    forkOperationStore: markerStore,
    isSourceBusy: () => false,
  });
  return {
    repo,
    document,
    close,
    service,
    markerStore,
    opened,
    worktreeCleanup,
    errors,
    workspaceDocument,
  };
}

describe('new-worktree fork account recovery across SQLite reopen', () => {
  it.each(
    ['system-default', managedProfile].flatMap((profile) =>
      (
        [
          'history-before-native-id',
          'history-after-native-id',
          'placeholder-meta',
          'stale-meta',
          'failed-repair-flush',
        ] as const
      ).map((checkpoint) => ({ profile, checkpoint }))
    )
  )(
    'restores the local $profile account mirror after $checkpoint',
    async ({ profile, checkpoint }) => {
      const initial = await openWorkspace();
      const marker: SessionForkOperationMarker = {
        kind: 'new-worktree',
        version: 1,
        workspaceId: scope.workspaceId,
        machineId: scope.machineId,
        targetSessionId: targetId,
        operationId,
        createdAt: '2026-09-06T00:00:02.000Z',
        title: '(fork) Synthetic source',
        branchName: 'lody/synthetic-fork',
        cleanup: {
          project: { kind: 'local', localProjectId: 'synthetic-project' },
          requesterUserId: 'synthetic-user',
          agentConfigId: 'synthetic-config',
          cliType: 'builtin',
          agentType: 'codex',
          branch: 'main',
        },
      };
      const nativeId = checkpoint === 'history-before-native-id' ? undefined : 'local-fork-native';
      const binding = {
        accountProfileId: profile,
        ...(nativeId ? { acpSessionId: nativeId } : {}),
      };
      await initial.markerStore.record(marker);
      await setSessionAccountBinding(scope, binding);
      const target = await initial.document(targetId);
      const cloned = cloneHistoryThroughTurn(
        sourceHistory,
        'assistant-source',
        sourceId,
        'Synthetic source',
        targetId
      );
      if (!cloned) throw new Error('Synthetic source must have a fork point');
      target.setForkOperation({
        id: operationId,
        sourceSessionId: sourceId,
        sourceTurnId: 'assistant-source',
        requestedByUserId: 'synthetic-user',
        targetContext: 'new-worktree',
        capturedHeadSha: 'a'.repeat(40),
        state: 'preparing',
        phase: 'committing',
        createdAt: marker.createdAt,
        updatedAt: marker.createdAt,
      });
      await target.updateHistory(() => cloned.history);
      if (checkpoint !== 'history-before-native-id') {
        target.setForkOperation(undefined);
        target.setForkOperation(undefined);
        expect((await target.getDocState())?.forkOperation).toBeUndefined();
      }
      const wrongProfile = profile === 'system-default' ? managedProfile : 'system-default';
      if (checkpoint === 'stale-meta' || checkpoint === 'placeholder-meta') {
        await initial.repo.upsertDocMeta(getSessionRoomId(targetId), {
          ...sessionMeta(targetId, wrongProfile),
          title: 'Preserve this edited title',
          ...(checkpoint === 'stale-meta'
            ? { acpSessionId: 'untrusted-synced-native', status: SessionStatusFactory.running() }
            : { status: SessionStatusFactory.initializing() }),
          accountRateLimits: { accountProfileId: wrongProfile, limits: {} },
        });
      }
      await initial.repo.flush();
      await initial.close();

      const recovered = await openWorkspace();
      if (checkpoint === 'failed-repair-flush') {
        const retryPersistEntered = Promise.withResolvers<void>();
        const releaseRetryPersist = Promise.withResolvers<void>();
        const persist = recovered.workspaceDocument.persistPendingChanges;
        let firstAttempt = true;
        vi.spyOn(recovered.workspaceDocument, 'persistPendingChanges').mockImplementation(
          async () => {
            if (firstAttempt) {
              firstAttempt = false;
              throw new Error('Synthetic recovered fork metadata persistence failure');
            }
            retryPersistEntered.resolve();
            await releaseRetryPersist.promise;
            await persist();
          }
        );
        await recovered.service.recoverPendingForks();
        expect(await recovered.markerStore.read(targetId)).toEqual(marker);
        expect((await recovered.document(targetId)).getForkOperation()).toBeUndefined();
        await expect((await recovered.document(targetId)).getMetaState()).resolves.toMatchObject({
          accountProfileId: profile,
          acpSessionId: nativeId,
        });
        const retry = recovered.service.recoverPendingForks();
        try {
          expect(
            await Promise.race([
              retryPersistEntered.promise.then(() => 'persist-entered'),
              retry.then(() => 'recovery-returned'),
            ])
          ).toBe('persist-entered');
          expect(await recovered.markerStore.read(targetId)).toEqual(marker);
        } finally {
          releaseRetryPersist.resolve();
          await retry;
        }
      } else {
        await recovered.service.recoverPendingForks();
      }
      expect(recovered.errors).toEqual([]);
      expect(recovered.worktreeCleanup).not.toHaveBeenCalled();
      expect(recovered.opened).toEqual([targetId]);
      expect(await recovered.markerStore.list()).toEqual([]);
      expect(await getSessionAccountBinding(scope)).toEqual(binding);
      expect((await recovered.document(targetId)).getForkOperation()).toBeUndefined();
      await recovered.close();

      const durable = await openWorkspace();
      const durableDoc = await durable.document(targetId);
      expect((await durableDoc.getDocState())?.forkOperation).toBeUndefined();
      // This exact profile discriminator gates account-scoped quota updates and
      // drives the account selector; the native id comes from the same local pair.
      const durableMeta = await durableDoc.getMetaState();
      expect(durableMeta?.accountProfileId).toBe(profile);
      expect(durableMeta?.acpSessionId).toBe(nativeId);
      expect(durableMeta?.title).toBe(
        checkpoint === 'stale-meta' || checkpoint === 'placeholder-meta'
          ? 'Preserve this edited title'
          : marker.title
      );
      expect(durableMeta?.status).toEqual(
        checkpoint === 'stale-meta' ? SessionStatusFactory.running() : SessionStatusFactory.idle()
      );
      expect(durableMeta?.accountRateLimits ?? null).toBeNull();
      expect(hashSessionAccountEditHistory(await durableDoc.getHistory())).toBe(
        hashSessionAccountEditHistory(cloned.history)
      );
      expect(await getSessionAccountBinding(scope)).toEqual(binding);
    }
  );
});

describe('same-workspace fork preparation recovery across SQLite reopen', () => {
  it.each(
    ['system-default', managedProfile].flatMap((profile) =>
      (['committed-without-origin', 'pending-unmatched-history'] as const).map((checkpoint) => ({
        profile,
        checkpoint,
      }))
    )
  )('preserves $profile history after $checkpoint', async ({ profile, checkpoint }) => {
    const initial = await openWorkspace();
    const marker: SessionForkOperationMarker = {
      kind: 'same-worktree',
      version: 1,
      workspaceId: scope.workspaceId,
      machineId: scope.machineId,
      targetSessionId: targetId,
      operationId,
      createdAt: '2026-09-06T00:00:02.000Z',
      title: '(fork) Synthetic source',
      accountProfileId: profile,
    };
    const placeholder = {
      ...sessionMeta(targetId, profile),
      status: SessionStatusFactory.initializing(),
    };
    const forkMeta = {
      ...placeholder,
      acpSessionId: 'fork-native',
      status: SessionStatusFactory.idle(),
    };
    const cloned = cloneHistoryThroughTurn(
      sourceHistory,
      'assistant-source',
      sourceId,
      'Synthetic source',
      targetId
    );
    if (!cloned) throw new Error('Synthetic source must have a fork point');
    await initial.markerStore.record(marker);
    await createSessionAccountForkBinding(scope, operationId, profile);
    await initial.repo.upsertDocMeta(getSessionRoomId(targetId), placeholder);
    const document = await initial.document(targetId);
    await initial.repo.flush();
    await beginSessionAccountEdit(scope, {
      operationId,
      sourceMeta: placeholder,
      targetMeta: forkMeta,
      sourceHistory: [],
      targetHistory: cloned.history,
    });
    if (checkpoint === 'committed-without-origin') {
      await document.updateHistory(() => cloned.history);
      await initial.repo.upsertDocMeta(getSessionRoomId(targetId), forkMeta);
      await initial.repo.flush();
      await commitSessionAccountEdit(scope, operationId);
    } else {
      abandonSessionAccountEdit(scope, operationId);
    }
    // Persist history that has no fork-origin notice, without touching local account ownership.
    const retainedHistory = sourceHistory.map((entry) => ({
      ...entry,
      id: `retained-${entry.id}`,
      items: [{ type: 'text' as const, text: `Retained ${entry.role} content` }],
    }));
    await document.updateHistory(() => retainedHistory);
    await initial.repo.flush();
    const expectedMeta = checkpoint === 'committed-without-origin' ? forkMeta : placeholder;
    const bindingDirectory = path.join(directory, 'session-account-bindings');
    const bindingFiles = await readdir(bindingDirectory);
    expect(bindingFiles).toHaveLength(1);
    const bindingFile = path.join(bindingDirectory, bindingFiles[0]!);
    const originalBinding = await readFile(bindingFile, 'utf8');
    await initial.close();

    const recovered = await openWorkspace();
    await recovered.service.recoverPendingForks();
    expect((await recovered.repo.getDocMeta(getSessionRoomId(targetId)))?.meta).toEqual(
      expectedMeta
    );
    expect(await readFile(bindingFile, 'utf8')).toBe(originalBinding);
    expect(recovered.worktreeCleanup).not.toHaveBeenCalled();
    if (checkpoint === 'committed-without-origin') {
      expect(recovered.errors).toEqual([]);
      expect(await recovered.markerStore.read(targetId, 'same-worktree')).toBeNull();
      expect(await getSessionAccountBinding(scope)).toEqual({
        accountProfileId: profile,
        acpSessionId: 'fork-native',
      });
    } else {
      expect(recovered.errors).toHaveLength(1);
      expect(await recovered.markerStore.read(targetId, 'same-worktree')).toEqual(marker);
      await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery');
    }
    await recovered.close();
    const durable = await openWorkspace();
    expect((await durable.repo.getDocMeta(getSessionRoomId(targetId)))?.meta).toEqual(expectedMeta);
    expect(
      hashSessionAccountEditHistory(await (await durable.document(targetId)).getHistory())
    ).toBe(hashSessionAccountEditHistory(retainedHistory));
    expect(await readFile(bindingFile, 'utf8')).toBe(originalBinding);
  });

  it.each(['system-default', managedProfile])(
    'preserves a later %s edit when a completed fork marker remains',
    async (profile) => {
      const initial = await openWorkspace();
      const marker: SessionForkOperationMarker = {
        kind: 'same-worktree',
        version: 1,
        workspaceId: scope.workspaceId,
        machineId: scope.machineId,
        targetSessionId: targetId,
        operationId,
        createdAt: '2026-09-06T00:00:02.000Z',
        title: '(fork) Synthetic source',
        accountProfileId: profile,
      };
      const placeholder = {
        ...sessionMeta(targetId, profile),
        status: SessionStatusFactory.initializing(),
      };
      const forkMeta = {
        ...placeholder,
        acpSessionId: 'fork-native',
        status: SessionStatusFactory.idle(),
      };
      const cloned = cloneHistoryThroughTurn(
        sourceHistory,
        'assistant-source',
        sourceId,
        'Synthetic source',
        targetId
      );
      if (!cloned) throw new Error('Synthetic source must have a fork point');
      await initial.markerStore.record(marker);
      await createSessionAccountForkBinding(scope, operationId, profile);
      await initial.repo.upsertDocMeta(getSessionRoomId(targetId), placeholder);
      const document = await initial.document(targetId);
      await initial.repo.flush();
      await beginSessionAccountEdit(scope, {
        operationId,
        sourceMeta: placeholder,
        targetMeta: forkMeta,
        sourceHistory: [],
        targetHistory: cloned.history,
      });
      await document.updateHistory(() => cloned.history);
      await initial.repo.upsertDocMeta(getSessionRoomId(targetId), forkMeta);
      await initial.repo.flush();
      await commitSessionAccountEdit(scope, operationId);

      // An ordinary edit rewrites the conversation and removes the old fork-origin notice.
      const editedHistory = sourceHistory.map((entry) => ({
        ...entry,
        id: `edited-${entry.id}`,
        items: [{ type: 'text' as const, text: `Edited ${entry.role} content` }],
      }));
      const editedMeta = { ...forkMeta, acpSessionId: 'edited-native' };
      await beginSessionAccountEdit(scope, {
        operationId: 'later-ordinary-edit',
        sourceMeta: forkMeta,
        targetMeta: editedMeta,
        sourceHistory: await document.getHistory(),
        targetHistory: editedHistory,
      });
      await document.updateHistory(() => editedHistory);
      await initial.repo.upsertDocMeta(getSessionRoomId(targetId), editedMeta);
      await initial.repo.flush();
      await commitSessionAccountEdit(scope, 'later-ordinary-edit');
      await initial.close();

      const recovered = await openWorkspace();
      await recovered.service.recoverPendingForks();
      expect((await recovered.repo.getDocMeta(getSessionRoomId(targetId)))?.meta).toEqual(
        editedMeta
      );
      expect(await getSessionAccountBinding(scope)).toEqual({
        accountProfileId: profile,
        acpSessionId: 'edited-native',
      });
      expect(recovered.errors).toEqual([expect.stringContaining('does not own')]);
      expect(recovered.opened).toEqual([]);
      expect(recovered.worktreeCleanup).not.toHaveBeenCalled();
      expect(await recovered.markerStore.read(targetId, 'same-worktree')).toEqual(marker);
      await recovered.close();

      const durable = await openWorkspace();
      expect((await durable.repo.getDocMeta(getSessionRoomId(targetId)))?.meta).toEqual(editedMeta);
      expect(
        hashSessionAccountEditHistory(await (await durable.document(targetId)).getHistory())
      ).toBe(hashSessionAccountEditHistory(editedHistory));
      expect(await getSessionAccountBinding(scope)).toEqual({
        accountProfileId: profile,
        acpSessionId: 'edited-native',
      });
    }
  );

  it.each(['system-default', managedProfile])(
    'persists a retried deletion before releasing %s ownership after a failed flush',
    async (profile) => {
      const initial = await openWorkspace();
      const marker: SessionForkOperationMarker = {
        kind: 'same-worktree',
        version: 1,
        workspaceId: scope.workspaceId,
        machineId: scope.machineId,
        targetSessionId: targetId,
        operationId,
        createdAt: '2026-09-06T00:00:02.000Z',
        title: '(fork) Synthetic source',
        accountProfileId: profile,
      };
      await initial.markerStore.record(marker);
      await createSessionAccountForkBinding(scope, operationId, profile);
      await initial.repo.upsertDocMeta(getSessionRoomId(targetId), {
        ...sessionMeta(targetId, profile),
        status: SessionStatusFactory.initializing(),
      });
      await initial.document(targetId);
      await initial.repo.flush();
      await initial.close();

      const recovered = await openWorkspace();
      const retryPersistEntered = Promise.withResolvers<void>();
      const releaseRetryPersist = Promise.withResolvers<void>();
      const persist = recovered.workspaceDocument.persistPendingChanges;
      let firstAttempt = true;
      vi.spyOn(recovered.workspaceDocument, 'persistPendingChanges').mockImplementation(
        async () => {
          if (firstAttempt) {
            firstAttempt = false;
            throw new Error('Synthetic rollback persistence failure');
          }
          retryPersistEntered.resolve();
          await releaseRetryPersist.promise;
          await persist();
        }
      );
      await recovered.service.recoverPendingForks();
      expect(recovered.errors).toEqual([
        expect.stringContaining('Synthetic rollback persistence failure'),
      ]);
      expect(
        isLoroRepoDocDeleted(await recovered.repo.getDocMeta(getSessionRoomId(targetId)))
      ).toBe(true);
      expect(await recovered.markerStore.read(targetId, 'same-worktree')).toEqual(marker);
      await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery');

      const retry = recovered.service.recoverPendingForks();
      try {
        expect(
          await Promise.race([
            retryPersistEntered.promise.then(() => 'persist-entered'),
            retry.then(() => 'recovery-returned'),
          ])
        ).toBe('persist-entered');
        expect(await recovered.markerStore.read(targetId, 'same-worktree')).toEqual(marker);
        await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery');
      } finally {
        releaseRetryPersist.resolve();
        await retry;
      }
      expect(await recovered.markerStore.read(targetId, 'same-worktree')).toBeNull();
      expect(await getSessionAccountBinding(scope)).toBeNull();
      await recovered.close();

      const durable = await openWorkspace();
      const record = await durable.repo.getDocMeta(getSessionRoomId(targetId));
      expect(!record || isLoroRepoDocDeleted(record)).toBe(true);
      expect(await durable.markerStore.list()).toEqual([]);
      expect(await getSessionAccountBinding(scope)).toBeNull();
    }
  );

  it.each(
    ['system-default', managedProfile].flatMap((profile) =>
      (
        [
          'marker-only',
          'binding-only',
          'placeholder',
          'journal-source',
          'durable-clone',
          'durable-final',
        ] as const
      ).map((checkpoint) => ({
        profile,
        checkpoint,
      }))
    )
  )('recovers $profile after $checkpoint', async ({ profile, checkpoint }) => {
    const completed = checkpoint === 'durable-clone' || checkpoint === 'durable-final';
    const first = await openWorkspace();
    const sourceMeta = { ...sessionMeta(sourceId, profile), acpSessionId: 'source-native' };
    await first.repo.upsertDocMeta(getSessionRoomId(sourceId), sourceMeta);
    await (await first.document(sourceId)).updateHistory(() => sourceHistory);
    await first.repo.flush();
    const marker: SessionForkOperationMarker = {
      kind: 'same-worktree',
      version: 1,
      workspaceId: scope.workspaceId,
      machineId: scope.machineId,
      targetSessionId: targetId,
      operationId,
      createdAt: '2026-09-06T00:00:02.000Z',
      title: '(fork) Synthetic source',
      accountProfileId: profile,
    };
    await first.markerStore.record(marker);
    const placeholder: SessionMeta = {
      ...sessionMeta(targetId, profile),
      parentSessionId: sourceId,
      status: SessionStatusFactory.initializing(),
    };
    const targetMeta = {
      ...placeholder,
      acpSessionId: 'fork-native',
      status: SessionStatusFactory.idle(),
    };
    const cloned = cloneHistoryThroughTurn(
      sourceHistory,
      'assistant-source',
      sourceId,
      sourceMeta.title,
      targetId
    );
    if (!cloned) throw new Error('Synthetic source must have a valid fork point');
    if (checkpoint !== 'marker-only') {
      await createSessionAccountForkBinding(scope, operationId, profile);
    }
    if (checkpoint !== 'marker-only' && checkpoint !== 'binding-only') {
      await first.repo.upsertDocMeta(getSessionRoomId(targetId), placeholder);
      await first.document(targetId);
      await first.repo.flush();
    }
    if (completed || checkpoint === 'journal-source') {
      await beginSessionAccountEdit(scope, {
        operationId,
        sourceMeta: placeholder,
        targetMeta,
        sourceHistory: [],
        targetHistory: cloned.history,
      });
      if (completed) {
        await (await first.document(targetId)).updateHistory(() => cloned.history);
        await first.repo.upsertDocMeta(getSessionRoomId(targetId), targetMeta);
        await first.repo.flush();
      }
      if (checkpoint === 'durable-final') {
        await commitSessionAccountEdit(scope, operationId);
      } else {
        abandonSessionAccountEdit(scope, operationId);
      }
    }
    await first.close();

    const recovered = await openWorkspace();
    expect(await recovered.markerStore.read(targetId, 'same-worktree')).toEqual(marker);
    if (checkpoint === 'journal-source') {
      await expect(
        resolveSessionAccountMeta(
          scope,
          placeholder,
          createSessionAccountEditRecovery(recovered.workspaceDocument, targetId)
        )
      ).rejects.toThrow();
    }
    await recovered.service.recoverPendingForks();
    expect(recovered.errors).toEqual([]);
    expect(recovered.worktreeCleanup).not.toHaveBeenCalled();
    expect(recovered.opened).not.toContain(sourceId);
    if (checkpoint === 'marker-only' || checkpoint === 'binding-only') {
      expect(recovered.opened).toEqual([]);
    }
    expect(await recovered.markerStore.read(targetId, 'same-worktree')).toBeNull();
    if (completed) {
      expect(await getSessionAccountBinding(scope)).toEqual({
        accountProfileId: profile,
        acpSessionId: 'fork-native',
      });
    } else {
      expect(await getSessionAccountBinding(scope)).toBeNull();
    }
    await recovered.close();

    const durable = await openWorkspace();
    const targetRecord = await durable.repo.getDocMeta(getSessionRoomId(targetId));
    if (completed) {
      expect(targetRecord?.meta).toMatchObject({
        accountProfileId: profile,
        acpSessionId: 'fork-native',
        status: SessionStatusFactory.idle(),
      });
      expect(
        hashSessionAccountEditHistory(await (await durable.document(targetId)).getHistory())
      ).toBe(hashSessionAccountEditHistory(cloned.history));
    } else {
      expect(!targetRecord || isLoroRepoDocDeleted(targetRecord)).toBe(true);
    }
    expect((await durable.repo.getDocMeta(getSessionRoomId(sourceId)))?.meta).toEqual(sourceMeta);
    expect(
      hashSessionAccountEditHistory(await (await durable.document(sourceId)).getHistory())
    ).toBe(hashSessionAccountEditHistory(sourceHistory));
    expect(await durable.markerStore.list()).toEqual([]);
  });
});
