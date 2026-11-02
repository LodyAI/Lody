import { LoroRepo } from 'loro-repo';
import { Flock } from '@loro-dev/flock-wasm';
import { planPullRequestLifecycle, resolveSessionPullRequests } from '@lody/shared';
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
    trace: vi.fn(),
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

it('publishes lifecycle as local metadata and projects independent remote observations through the real Repo', async () => {
  const repo = await LoroRepo.create({});
  const owner = sid('owner');
  const room = getSessionRoomId(owner);
  const url = 'https://github.com/example/api/pull/7';
  const other = 'https://github.com/example/web/pull/7';
  const prs = [
    { url, status: 'open' },
    { url: other, status: 'draft' },
  ];
  const workspace = createLodyPrPollerWorkspace({
    documentManager: { repo } as unknown as LoroDocumentManager,
    workspaceId: 'workspace-1',
    githubTokens: null,
    prAssociation: null,
    userId: 'user-1',
    machineId: machineId('machine-1'),
    logger: createTestLogger(),
  });
  try {
    await repo.upsertDocMeta(room, { machineId: 'machine-1', pullRequests: prs });
    const observed = planPullRequestLifecycle({
      url,
      status: 'closed',
      updatedAt: '2026-01-02T00:00:00Z',
    })!;
    const localFields = new Set<string>();
    const unsubscribe = repo.getMeta().subscribe((batch) => {
      if (batch.source === 'local')
        for (const event of batch.events) {
          if (typeof event.key[2] === 'string') localFields.add(event.key[2]);
        }
    });
    await workspace.writeOwnerMeta(owner, { lifecycle: [observed] });
    repo.getMeta().commit();
    unsubscribe();
    expect(localFields.has(observed.field)).toBe(true);
    expect((await repo.getDocMeta(room))?.meta.pullRequests).toEqual(prs);
    expect(resolveSessionPullRequests(await workspace.readOwnerMeta(owner))).toEqual([
      { url, status: 'closed' },
      { url: other, status: 'draft' },
    ]);
    const webhook = planPullRequestLifecycle(
      { url: other, status: 'merged', updatedAt: '2026-01-03T00:00:00Z' },
      undefined,
      'webhook'
    )!;
    const delta = new Flock(webhook.peerId);
    delta.set(['m', room, webhook.field], webhook.value, webhook.value.u);
    const hydrated = new Promise<void>((resolve) => {
      const watch = repo.watch((event) => {
        if (event.kind === 'doc-metadata' && event.docId === room && webhook.field in event.patch) {
          watch.unsubscribe();
          resolve();
        }
      });
    });
    repo.getMeta().importJson(delta.exportJson());
    repo.getMeta().commit();
    await hydrated;
    expect(resolveSessionPullRequests(await workspace.readOwnerMeta(owner))).toEqual([
      { url, status: 'closed' },
      { url: other, status: 'merged' },
    ]);
  } finally {
    await workspace.dispose();
    await repo.destroy();
  }
});
