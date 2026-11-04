import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { getSessionRoomId, type SessionId, type SessionMeta, type WorkspaceId } from '@lody/shared';
import { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { getLogger } from '@/utils/logger';
import { FileSystemStorageAdaptor } from 'loro-repo/storage/filesystem';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('Session observation document ownership', () => {
  it('opens and releases the real document without auto-read, model-summary or status writes', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'lody-observe-read-only-'));
    const storage = new FileSystemStorageAdaptor({ baseDir });
    const repo = await LoroRepo.create({ storageAdapter: storage });
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace' as WorkspaceId,
      userId: 'user',
      metaSub: null,
      logger: getLogger('observe-read-only-test'),
    });
    try {
      const id = 'observe-read-only' as SessionId;
      const roomId = getSessionRoomId(id);
      const meta: SessionMeta = {
        id,
        machineId: 'm',
        userId: 'user',
        createdAt: 'synthetic',
        cliType: 'builtin',
        agentType: 'codex',
        historyBackend: 'loro',
        status: { type: 'running' },
      };
      await repo.upsertDocMeta(roomId, meta);
      const handle = await repo.openPersistedDoc(roomId);
      const seed = new SessionDocument(repo, id, async (docId) => {
        await manager.unloadDocRoom(docId);
      });
      seed.handle = handle;
      seed.composeSessionData(handle.doc, {
        session: { id },
        history: [
          {
            id: 'u',
            role: 'user',
            status: 'pending',
            read: false,
            timestamp: '2026-10-08T00:00:00.000Z',
            items: [],
          },
          {
            id: 'a',
            role: 'assistant',
            userTurnId: 'u',
            timestamp: '2026-10-08T00:00:01.000Z',
            finished: false,
            items: [],
            modelInfo: { modelId: 'model', name: 'Model' },
          },
        ],
      });
      handle.doc.commit();
      await repo.persistDocNow(roomId, handle.doc);
      const beforeDoc = handle.doc.toJSON();
      const beforeVersion = handle.doc.oplogVersion().toJSON();
      const beforeMeta = await repo.getDocMeta(roomId);
      await repo.flush();
      const stored = await storage.loadDoc(roomId);
      expect(stored?.toJSON().history).toEqual(beforeDoc.history);
      expect(stored?.oplogVersion().toJSON()).toEqual(beforeVersion);
      await seed.destroy({ preserveStatus: true });

      const observed = await manager.getOrCreateSessionDoc(id, { skipAutoRead: true });
      expect(observed.handle?.doc.toJSON()).toEqual(beforeDoc);
      expect(observed.handle?.doc.oplogVersion().toJSON()).toEqual(beforeVersion);
      expect(await repo.getDocMeta(roomId)).toEqual(beforeMeta);
      await manager.cleanSessionDoc(id, { preserveStatus: true });
      const persisted = await repo.openPersistedDoc(roomId);
      expect(persisted.doc.toJSON().history).toEqual(beforeDoc.history);
      expect(persisted.doc.oplogVersion().toJSON()).toEqual(beforeVersion);
      expect(await repo.getDocMeta(roomId)).toEqual(beforeMeta);
      // Positive counterpart: execution's normal open still acknowledges the User.
      const execution = await manager.getOrCreateSessionDoc(id);
      const user = await execution.sessionData.history.readTurn('u');
      expect(user.state === 'ready' && user.turn.status).toBe('seen');
      expect(user.state === 'ready' && user.turn.read).toBe(true);
    } finally {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
