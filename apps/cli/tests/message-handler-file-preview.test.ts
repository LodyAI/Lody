import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionMeta, type WorkspaceId } from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { ISession, SessionManager } from '../src/session/session-manager';
import { getDefaultSessionWorkdir } from '../src/session/session';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const sessionId = 'preview-chat' as SessionId;
const parentId = 'preview-parent' as SessionId;
const workspaceId = 'preview-workspace' as WorkspaceId;
const machineId = 'preview-machine';
const content = 'A synthetic artifact survives runtime eviction.\n';
const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  trace() {},
  setLevel() {},
  child: () => logger,
  close: async () => {},
};

describe('MessageHandler file preview workspace lifecycle', () => {
  let dataDir: string;
  let handler: MessageHandler;
  let resident: ISession | null;
  let records: Map<string, { meta: Partial<SessionMeta>; deleted?: boolean }>;
  let restoreCodeCollab: () => void;

  beforeEach(() => {
    dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-chat-preview-')));
    vi.stubEnv('LODY_DATA_DIR', dataDir);
    resident = null;
    records = new Map([
      [getSessionRoomId(sessionId), { meta: { machineId, userId: 'user-1' } }],
      [getSessionRoomId(parentId), { meta: { machineId, userId: 'user-1' } }],
    ]);
    const unexpected = () => {
      throw new Error('Preview must not start an agent or mutate documents');
    };
    const manager = {
      getSession: () => resident,
      getPendingSession: () => undefined,
      createSession: unexpected,
      on() {},
      setRequestPermissionHandler() {},
      cleanUp: async () => {},
    } as unknown as SessionManager;
    const document = {
      isTransportConnected: () => true,
      markMachineFlockDocDirty: unexpected,
      repo: {
        getDocMeta: async (id: string) => records.get(id),
        watch: () => ({ unsubscribe() {} }),
      },
      getOrCreateSessionDoc: unexpected,
      sendMachineHeartbeat: unexpected,
    } as unknown as LoroDocumentManager;
    handler = new MessageHandler(manager, document, logger, {
      token: 'synthetic-token',
      workspaceId,
      userId: 'user-1',
      machineId,
      machineName: 'synthetic-machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    });
    // A successful preview must remain possible with all Code Collab access
    // forbidden, including watcher activation and Flock publication.
    const internals = handler as unknown as { codeCollabV2Service: object };
    const service = internals.codeCollabV2Service;
    internals.codeCollabV2Service = new Proxy({}, { get: unexpected });
    restoreCodeCollab = () => {
      internals.codeCollabV2Service = service;
    };
  });

  afterEach(async () => {
    restoreCodeCollab();
    await handler.cleanup();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function writeArtifact(id = sessionId, text = content) {
    const root = getDefaultSessionWorkdir(id);
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'artifact.txt');
    fs.writeFileSync(file, text);
    return { root, file };
  }

  function request(
    method: 'file/preview' | 'file/resolve-local',
    file = 'artifact.txt',
    ownerSessionId?: SessionId
  ) {
    return handler.handleLocalMachineRpc({
      method,
      machineId,
      workspaceId,
      ownerSessionId,
      params: { v: 3, sessionId, path: file },
    });
  }

  it.each(['relative', 'absolute'] as const)(
    'keeps %s previews readable after runtime eviction',
    async (kind) => {
      const { root, file } = writeArtifact();
      resident = {
        getHostWorkdir: () => root,
        getWorkdir: () => root,
        getParentSessionId: () => undefined,
      } as ISession;
      const requestedPath = kind === 'absolute' ? file : 'artifact.txt';
      const warm = await request('file/preview', requestedPath);
      expect(warm).toMatchObject({
        ok: true,
        result: { status: 'ok', content: { text: content } },
      });
      resident = null;
      expect(await request('file/preview', requestedPath)).toEqual(warm);
      expect(await request('file/resolve-local', requestedPath)).toMatchObject({
        ok: true,
        result: { status: 'local-file', absolutePath: file, external: false },
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  );

  it('resolves a cold child to its parent directory and preserves the owner check', async () => {
    records.set(getSessionRoomId(sessionId), { meta: { machineId, parentSessionId: parentId } });
    writeArtifact(sessionId, 'Wrong child directory');
    const { file } = writeArtifact(parentId);
    expect(await request('file/preview', 'artifact.txt', parentId)).toMatchObject({
      ok: true,
      result: { status: 'ok', content: { text: content } },
    });
    expect(await request('file/resolve-local', 'artifact.txt', parentId)).toMatchObject({
      ok: true,
      result: { status: 'local-file', absolutePath: file },
    });
    expect(await request('file/preview', 'artifact.txt', sessionId)).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'permission_denied' },
    });
  });

  it.each(['file/preview', 'file/resolve-local'] as const)(
    'does not create a missing chat directory for %s',
    async (method) => {
      expect(await request(method)).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
      expect(fs.existsSync(path.join(dataDir, 'chats'))).toBe(false);
    }
  );

  it.each(['root', 'child'] as const)(
    'resolves an absolute local artifact without the %s workspace directory',
    async (kind) => {
      if (kind === 'child') {
        records.set(getSessionRoomId(sessionId), {
          meta: { machineId, parentSessionId: parentId },
        });
      }
      const file = path.join(dataDir, 'external.txt');
      fs.writeFileSync(file, content);
      expect(
        await request('file/resolve-local', file, kind === 'child' ? parentId : sessionId)
      ).toMatchObject({
        ok: true,
        result: { status: 'local-file', absolutePath: file, path: file, external: true },
      });
      expect(await request('file/preview', file)).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
      expect(await request('file/resolve-local', 'external.txt')).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
      expect(fs.existsSync(path.join(dataDir, 'chats'))).toBe(false);
    }
  );

  it('checks local owner identity before resolving an absolute artifact without a workspace', async () => {
    const file = path.join(dataDir, 'external.txt');
    fs.writeFileSync(file, content);
    records.set(getSessionRoomId(sessionId), { meta: { machineId, parentSessionId: parentId } });
    expect(await request('file/resolve-local', file, sessionId)).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'permission_denied' },
    });
    for (const meta of [
      { machineId: 'another-machine' },
      { machineId, isArchived: true },
      { machineId, parentSessionId: 'nested-parent' as SessionId },
    ]) {
      records.set(getSessionRoomId(parentId), { meta });
      expect(await request('file/resolve-local', file, parentId)).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'permission_denied' },
      });
    }
    records.delete(getSessionRoomId(parentId));
    expect(await request('file/resolve-local', file, parentId)).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'session_not_found' },
    });
  });

  it('reports a missing file in an existing chat as file_not_found', async () => {
    writeArtifact();
    expect(await request('file/preview', 'missing.txt')).toMatchObject({
      ok: true,
      result: { status: 'error', code: 'file_not_found' },
    });
  });

  it.each(['session', 'parent'] as const)(
    'rejects invalid %s metadata even when its files exist',
    async (target) => {
      writeArtifact();
      writeArtifact(parentId);
      if (target === 'parent') {
        records.set(getSessionRoomId(sessionId), {
          meta: { machineId, parentSessionId: parentId },
        });
      }
      const id = getSessionRoomId(target === 'parent' ? parentId : sessionId);
      const cases = [
        { record: undefined, code: 'session_not_found' },
        { record: { meta: { machineId }, deleted: true }, code: 'session_not_found' },
        { record: { meta: { machineId, isArchived: true } }, code: 'permission_denied' },
        { record: { meta: { machineId: 'another-machine' } }, code: 'permission_denied' },
        { record: { meta: { machineId, isWorktree: true } }, code: 'workspace_root_unavailable' },
      ];
      for (const { record, code } of cases) {
        if (record) records.set(id, record);
        else records.delete(id);
        for (const method of ['file/preview', 'file/resolve-local'] as const) {
          expect(await request(method)).toMatchObject({
            ok: true,
            result: { status: 'error', code },
          });
        }
      }
    }
  );

  it('does not substitute a chat directory for an unresolved parent project or nested parent', async () => {
    writeArtifact();
    writeArtifact(parentId);
    records.set(getSessionRoomId(sessionId), { meta: { machineId, parentSessionId: parentId } });
    for (const extra of [
      { repoFullName: 'synthetic/project' },
      { parentSessionId: 'nested-parent' as SessionId },
    ]) {
      records.set(getSessionRoomId(parentId), { meta: { machineId, ...extra } });
      expect(await request('file/preview')).toMatchObject({
        ok: true,
        result: { status: 'error', code: 'workspace_root_unavailable' },
      });
    }
  });
});
