import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, type MachineId, type SessionId, type SessionMeta } from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import type { Logger } from '@/utils/logger';
import { createLodyPrPollerWorkspace } from './pr-poller-workspace';

vi.mock('@/lib/command-runtime', () => ({
  listAliveSessionMetas: vi.fn(),
}));

const sid = (value: string): SessionId => value as SessionId;
const machineId = (value: string): MachineId => value as MachineId;

function createTestLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

describe('createLodyPrPollerWorkspace', () => {
  beforeEach(() => {
    vi.mocked(listAliveSessionMetas).mockReset();
  });

  it('enumerates only sessions owned by this machine', async () => {
    vi.mocked(listAliveSessionMetas).mockResolvedValue([
      {
        roomId: getSessionRoomId(sid('owned')),
        meta: { userId: 'user-1', machineId: machineId('machine-1') } as SessionMeta,
      },
      {
        roomId: getSessionRoomId(sid('remote')),
        meta: { userId: 'user-2', machineId: machineId('machine-2') } as SessionMeta,
      },
      {
        roomId: getSessionRoomId(sid('legacy')),
        meta: { userId: 'user-1' } as SessionMeta,
      },
    ]);
    const workspace = createLodyPrPollerWorkspace({
      documentManager: {} as LoroDocumentManager,
      workspaceId: 'workspace-1',
      githubTokens: null,
      prAssociation: null,
      userId: 'user-1',
      machineId: machineId('machine-1'),
      logger: createTestLogger(),
    });

    await expect(workspace.listAliveSessionMetas()).resolves.toEqual([
      {
        sessionId: sid('owned'),
        meta: { userId: 'user-1', machineId: machineId('machine-1') },
      },
    ]);
    await workspace.dispose();
  });

  it('forwards the changed session id from metadata events', async () => {
    let emit: ((event: { kind: string; docId: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    const documentManager = {
      repo: {
        watch: vi.fn((listener: (event: { kind: string; docId: string }) => void) => {
          emit = listener;
          return { unsubscribe };
        }),
      },
    } as unknown as LoroDocumentManager;
    const workspace = createLodyPrPollerWorkspace({
      documentManager,
      workspaceId: 'workspace-1',
      githubTokens: null,
      prAssociation: null,
      userId: 'user-1',
      machineId: machineId('machine-1'),
      logger: createTestLogger(),
    });
    const listener = vi.fn();

    const stop = workspace.watchSessionMetadata(listener);
    emit?.({ kind: 'doc-metadata', docId: getSessionRoomId(sid('changed')) });
    emit?.({ kind: 'doc-existence-changed', docId: getSessionRoomId(sid('deleted')) });
    emit?.({ kind: 'doc-metadata', docId: 'machine:ignored' });

    expect(listener.mock.calls).toEqual([[sid('changed')], [sid('deleted')]]);
    stop?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await workspace.dispose();
  });
});
