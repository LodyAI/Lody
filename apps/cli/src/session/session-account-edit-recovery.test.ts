import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  getSessionRoomId,
  SessionStatusFactory,
  type ACPSessionId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { SessionDocument } from '@/lib/loro/doc';
import {
  abandonSessionAccountEdit,
  beginSessionAccountEdit,
  getSessionAccountBinding,
  hashSessionAccountEditHistory,
  resolveSessionAccountMeta,
  setSessionAccountBinding,
} from './session-account-binding-store';
import { createSessionAccountEditRecovery } from './session-account-edit-recovery';

const sessionId = 'edit-recovery' as SessionId;
const scope = { workspaceId: 'workspace', machineId: 'machine', sessionId };
const roomId = getSessionRoomId(sessionId);
const accountProfileId = '00000000-0000-4000-8000-00000000000b';
const history = (id: string): SessionHistoryInput[] => [
  {
    id,
    timestamp: '2026-09-06T00:00:00.000Z',
    role: 'user',
    items: [{ type: 'text', text: id }],
    fileDiff: [],
    finished: true,
    read: true,
    status: 'pending',
    inputConfig: { prompt: '  ' + id + '  ', modelId: '  model  ' },
  },
];
const meta = (id: string): SessionMeta =>
  ({
    id: sessionId,
    machineId: 'machine',
    accountProfileId,
    acpSessionId: id as ACPSessionId,
    status: SessionStatusFactory.idle(),
    latestUserMsgId: id,
  }) as SessionMeta;
let directory: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lody-edit-recovery-'));
  vi.stubEnv('LODY_DATA_DIR', directory);
  vi.stubEnv('LODY_PLATFORM', 'local');
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function openWorkspace() {
  const store = new SqliteRepoStore({ path: path.join(directory, 'repo.sqlite3') });
  const repo = await LoroRepo.create({ storageAdapter: store.storage });
  const document = new SessionDocument(repo, sessionId, async () => undefined);
  await document.init({ skipAutoRead: true });
  const close = async () => {
    await document.destroy();
    await repo.destroy();
  };
  cleanups.push(close);
  return {
    repo,
    document,
    close,
    recovery: createSessionAccountEditRecovery(
      {
        repo,
        getSessionHistorySnapshot: async () => await document.getHistory(),
        persistPendingChanges: async () => {
          await repo.flush();
        },
      },
      sessionId
    ),
  };
}

describe('account edit recovery across SQLite reopen', () => {
  it.each([
    ['system-default', 'placeholder'],
    ['system-default', 'clone'],
    [accountProfileId, 'placeholder'],
    [accountProfileId, 'clone'],
  ] as const)('recovers a fork on %s from durable %s history', async (profile, checkpoint) => {
    const first = await openWorkspace();
    const placeholder: SessionMeta = {
      ...meta('placeholder'),
      accountProfileId: profile,
      acpSessionId: undefined,
      latestUserMsgId: undefined,
      status: SessionStatusFactory.initializing(),
    };
    const cloned: SessionMeta = {
      ...placeholder,
      acpSessionId: 'fork-native' as ACPSessionId,
      status: SessionStatusFactory.idle(),
    };
    await first.repo.upsertDocMeta(roomId, placeholder);
    await first.repo.flush();
    await setSessionAccountBinding(scope, { accountProfileId: profile });
    const clonedHistory = history('cloned-source-turn');
    await beginSessionAccountEdit(scope, {
      operationId: 'interrupted-fork',
      sourceMeta: placeholder,
      targetMeta: cloned,
      sourceHistory: [],
      targetHistory: clonedHistory,
    });
    await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery');
    // Metadata and document persistence can land separately in either order.
    if (checkpoint === 'clone') await first.document.updateHistory(() => clonedHistory);
    await first.repo.upsertDocMeta(roomId, checkpoint === 'clone' ? placeholder : cloned);
    await first.repo.flush();
    abandonSessionAccountEdit(scope, 'interrupted-fork');
    await first.close();
    cleanups.splice(cleanups.indexOf(first.close), 1);

    const reopened = await openWorkspace();
    const expectedNative = checkpoint === 'clone' ? 'fork-native' : undefined;
    const resolved = await resolveSessionAccountMeta(scope, meta('untrusted'), reopened.recovery);
    expect(resolved.accountProfileId).toBe(profile);
    expect(resolved.acpSessionId).toBe(expectedNative);
    expect(resolved.status).toEqual(
      checkpoint === 'clone' ? SessionStatusFactory.idle() : SessionStatusFactory.initializing()
    );
    expect(hashSessionAccountEditHistory(await reopened.document.getHistory())).toBe(
      hashSessionAccountEditHistory(checkpoint === 'clone' ? clonedHistory : [])
    );
    await reopened.close();
    cleanups.splice(cleanups.indexOf(reopened.close), 1);

    const durable = await openWorkspace();
    expect((await durable.repo.getDocMeta(roomId))?.meta?.acpSessionId).toBe(expectedNative);
    expect(await getSessionAccountBinding(scope)).toMatchObject({ accountProfileId: profile });
    expect((await getSessionAccountBinding(scope))?.acpSessionId).toBe(expectedNative);
  });

  it.each(['source', 'target'] as const)(
    'recovers %s history with the opposite metadata checkpoint',
    async (checkpoint) => {
      const first = await openWorkspace();
      await first.repo.upsertDocMeta(roomId, meta('source'));
      await first.document.updateHistory(() => history('source'));
      await first.repo.flush();
      const sourceHistory = await first.document.getHistory();
      const targetHistory = history('target');
      await setSessionAccountBinding(scope, {
        accountProfileId,
        acpSessionId: 'source' as ACPSessionId,
      });
      await beginSessionAccountEdit(scope, {
        operationId: 'interrupted-edit',
        sourceMeta: meta('source'),
        targetMeta: meta('target'),
        sourceHistory,
        targetHistory,
      });
      if (checkpoint === 'target') await first.document.updateHistory(() => targetHistory);
      await first.repo.upsertDocMeta(roomId, meta(checkpoint === 'source' ? 'target' : 'source'));
      await first.repo.flush();
      abandonSessionAccountEdit(scope, 'interrupted-edit');
      await first.close();
      cleanups.splice(cleanups.indexOf(first.close), 1);

      const reopened = await openWorkspace();
      expect(hashSessionAccountEditHistory(await reopened.document.getHistory())).toBe(
        hashSessionAccountEditHistory(checkpoint === 'source' ? sourceHistory : targetHistory)
      );
      const resolved = await resolveSessionAccountMeta(scope, meta('untrusted'), reopened.recovery);
      expect(resolved.acpSessionId).toBe(checkpoint);
      expect(resolved.accountProfileId).toBe(accountProfileId);
      expect((await getSessionAccountBinding(scope))?.acpSessionId).toBe(checkpoint);
      expect((await reopened.repo.getDocMeta(roomId))?.meta?.acpSessionId).toBe(checkpoint);
      await reopened.close();
      cleanups.splice(cleanups.indexOf(reopened.close), 1);
      const durable = await openWorkspace();
      expect((await durable.repo.getDocMeta(roomId))?.meta?.acpSessionId).toBe(checkpoint);
      expect((await getSessionAccountBinding(scope))?.acpSessionId).toBe(checkpoint);
    }
  );
});

describe('recovery adapter boundaries', () => {
  it('does not inspect history or metadata when no local edit is pending', async () => {
    const current = await openWorkspace();
    const readHistory = vi.fn(async () => history('source'));
    const getMeta = vi.spyOn(current.repo, 'getDocMeta');
    const recovery = createSessionAccountEditRecovery(
      {
        repo: current.repo,
        getSessionHistorySnapshot: readHistory,
        persistPendingChanges: async () => {
          await current.repo.flush();
        },
      },
      sessionId
    );
    await setSessionAccountBinding(scope, {
      accountProfileId,
      acpSessionId: 'source' as ACPSessionId,
    });
    await resolveSessionAccountMeta(scope, meta('untrusted'), recovery);
    expect(readHistory).not.toHaveBeenCalled();
    expect(getMeta).not.toHaveBeenCalled();
  });

  it.each(['missing', 'deleted'] as const)(
    'refuses %s session metadata before reading history or repairing metadata',
    async (state) => {
      const current = await openWorkspace();
      if (state === 'deleted') {
        await current.repo.upsertDocMeta(roomId, meta('source'));
        await current.repo.deleteDoc(roomId);
      }
      const readHistory = vi.fn(async () => history('source'));
      const writeMeta = vi.spyOn(current.repo, 'upsertDocMeta');
      const recovery = createSessionAccountEditRecovery(
        {
          repo: current.repo,
          getSessionHistorySnapshot: readHistory,
          persistPendingChanges: async () => {
            await current.repo.flush();
          },
        },
        sessionId
      );
      await expect(recovery.readHistory()).rejects.toThrow('existing session');
      await expect(recovery.writeMeta(meta('target'))).rejects.toThrow('existing session');
      expect(readHistory).not.toHaveBeenCalled();
      expect(writeMeta).not.toHaveBeenCalled();
    }
  );

  it('keeps an ambiguous durable history blocked without choosing mirrored metadata', async () => {
    const first = await openWorkspace();
    await first.repo.upsertDocMeta(roomId, meta('source'));
    await first.document.updateHistory(() => history('source'));
    await first.repo.flush();
    await setSessionAccountBinding(scope, {
      accountProfileId,
      acpSessionId: 'source' as ACPSessionId,
    });
    await beginSessionAccountEdit(scope, {
      operationId: 'ambiguous-edit',
      sourceMeta: meta('source'),
      targetMeta: meta('target'),
      sourceHistory: await first.document.getHistory(),
      targetHistory: history('target'),
    });
    await first.document.updateHistory(() => history('different'));
    await first.repo.upsertDocMeta(roomId, meta('target'));
    await first.repo.flush();
    abandonSessionAccountEdit(scope, 'ambiguous-edit');
    await first.close();
    cleanups.splice(cleanups.indexOf(first.close), 1);
    const reopened = await openWorkspace();
    await expect(
      resolveSessionAccountMeta(scope, meta('target'), reopened.recovery)
    ).rejects.toThrow();
    await expect(getSessionAccountBinding(scope)).rejects.toThrow('recovery');
  });
});
