import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import {
  getSessionRoomId,
  LOCAL_SESSION_INBOX_DELIVER_PATH,
  readMessageAuthor,
  RYUGI_UNSUBSCRIBE_EXIT_CODE,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  buildRyugiDedupeKey,
  executeSessionInboxDeliver,
  parseRyugiDeliveryPayload,
} from '@/commands/session-inbox';
import { LocalDaemonAvailabilityError } from '@/lib/command-runtime';
import { LocalControlHandler } from '@/lib/local-control-handler';
import { createLocalSessionControlRequestHandler } from '@/lib/local-session-control';
import { SessionDocument, type LoroDocumentManager } from '@/lib/loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import { createLogger } from '@/utils/logger';
import {
  deliverSessionInboxMessage,
  type SessionInboxDeliverDeps,
  type SessionInboxDeliverWorkspace,
} from './session-inbox-deliver';

const MACHINE_ID = 'machine-owner-1' as MachineId;
const OWNER_USER_ID = 'user-owner-1';

async function createSessionFixture(
  options: {
    sessionId?: SessionId;
    meta?: Partial<SessionMeta>;
    deleted?: boolean;
    revoked?: boolean;
    canEdit?: 'yes' | 'no' | 'unknown';
    encrypted?: boolean;
    signedIntent?: string | undefined;
    initialHistory?: SessionHistoryInput[];
    startupSyncPending?: boolean;
  } = {}
) {
  const sessionId = options.sessionId ?? ('session-ryugi-1' as SessionId);
  const roomId = getSessionRoomId(sessionId);
  const repo = await LoroRepo.create({});
  const sessionDoc = new SessionDocument(repo, sessionId, async () => undefined);
  await sessionDoc.initOffline(undefined, { historyBackend: 'loro' });

  const baseMeta: SessionMeta = {
    id: sessionId,
    machineId: MACHINE_ID,
    userId: OWNER_USER_ID,
    cliType: 'builtin',
    agentType: 'pi',
    historyBackend: 'loro',
    createdAt: 1_700_000_000_000,
    ...options.meta,
  } as SessionMeta;

  if (!options.deleted) {
    await repo.upsertDocMeta(roomId, baseMeta);
  } else {
    await repo.upsertDocMeta(roomId, baseMeta);
    await repo.deleteDoc(roomId);
  }

  for (const turn of options.initialHistory ?? []) {
    await sessionDoc.sessionData.commands.appendTurn(turn);
  }

  const signMachineInput = vi.fn(async () => options.signedIntent);
  const manager = {
    repo,
    getOrCreateSessionDoc: async (id: SessionId) => {
      if (id !== sessionId) throw new Error(`unexpected session ${id}`);
      return sessionDoc;
    },
    isEncryptedWorkspace: () => Boolean(options.encrypted),
    signMachineInput,
  } as unknown as LoroDocumentManager;

  const workspace: SessionInboxDeliverWorkspace = {
    workspaceId: 'workspace-1',
    manager,
    revoked: options.revoked,
    canEdit: vi.fn(async () => options.canEdit ?? 'yes'),
  };

  const deps: SessionInboxDeliverDeps = {
    machineId: MACHINE_ID,
    ownerUserId: OWNER_USER_ID,
    getWorkspaces: () => [workspace],
    isStartupSyncPending: () => Boolean(options.startupSyncPending),
  };

  return { repo, sessionDoc, sessionId, roomId, manager, workspace, deps, signMachineInput };
}

describe('deliverSessionInboxMessage', () => {
  it('enqueues Ryugi wakeMessage unchanged with external origin, preserves session defaults, and deduplicates retries', async () => {
    const fixture = await createSessionFixture({
      initialHistory: [
        {
          id: 'turn-initial',
          role: 'user',
          timestamp: '2026-11-25T00:00:00.000Z',
          userId: OWNER_USER_ID,
          status: 'handled',
          items: [{ type: 'text', text: 'Design the layout' }],
          inputConfig: {
            prompt: 'Design the layout',
            cliType: 'builtin',
            agentType: 'pi',
            modelId: 'claude-sonnet-4-6',
            modeId: 'code',
            mcpServerIds: ['mcp-1'],
          },
        },
      ],
    });

    const wakeMessage = 'Ryugi feedback on document/spec:\n- Tighten spacing\n- Keep header fixed';
    const first = await deliverSessionInboxMessage(
      {
        source: 'ryugi',
        sessionId: fixture.sessionId,
        message: wakeMessage,
        dedupeKey: 'event-hash-1',
        metadata: {
          host: 'lody',
          label: 'Ryugi',
          artifact: 'document/spec',
          eventType: 'ryugi-comments',
        },
      },
      fixture.deps
    );

    expect(first.status).toBe('queued');
    if (first.status !== 'queued') throw new Error('expected queued');
    expect(first.deduplicated).toBeUndefined();

    const queue = await fixture.sessionDoc.getMessageQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.task).toBe(wakeMessage);
    expect(queue[0]?.userId).toBe(OWNER_USER_ID);
    expect(queue[0]?.userTurnId).toBe(first.userTurnId);
    expect(queue[0]?.acpSessionConfig?.prompt).toBe(wakeMessage);
    expect(queue[0]?.acpSessionConfig?.modelId).toBe('claude-sonnet-4-6');
    expect(queue[0]?.acpSessionConfig?.modeId).toBe('code');
    expect(queue[0]?.acpSessionConfig?.mcpServerIds).toEqual(['mcp-1']);
    expect(readMessageAuthor(queue[0]?.author)).toEqual({
      v: 1,
      kind: 'external',
      source: 'ryugi',
      label: 'Ryugi',
      artifact: 'document/spec',
      eventType: 'ryugi-comments',
    });

    const meta = (await fixture.repo.getDocMeta(fixture.roomId))?.meta as SessionMeta | undefined;
    expect(meta?.messageQueueUpdatedAt).toBeGreaterThan(0);
    expect(meta?.messageQueueUpdateVersion?.updatedAt).toBe(meta?.messageQueueUpdatedAt);

    // Retry while still queued deduplicates cleanly without creating a second queue row.
    const retryQueued = await deliverSessionInboxMessage(
      {
        source: 'ryugi',
        sessionId: fixture.sessionId,
        message: wakeMessage,
        dedupeKey: 'event-hash-1',
        metadata: { label: 'Ryugi', artifact: 'document/spec', eventType: 'ryugi-comments' },
      },
      fixture.deps
    );
    expect(retryQueued).toEqual({
      status: 'queued',
      sessionId: fixture.sessionId,
      userTurnId: first.userTurnId,
      deduplicated: true,
    });
    expect(await fixture.sessionDoc.getMessageQueue()).toHaveLength(1);

    // Simulate promotion into history and verify retry after promotion also deduplicates.
    const backend = await createSessionBackend(fixture.sessionDoc);
    await fixture.sessionDoc.sessionData.commands.appendTurn({
      id: first.userTurnId,
      role: 'user',
      timestamp: '2026-11-25T00:01:00.000Z',
      userId: OWNER_USER_ID,
      author: readMessageAuthor(queue[0]?.author),
      status: 'pending',
      items: [{ type: 'text', text: wakeMessage }],
    });
    await backend.removeMessageQueueItem(queue[0]!.$cid);

    const retryPromoted = await deliverSessionInboxMessage(
      {
        source: 'ryugi',
        sessionId: fixture.sessionId,
        message: wakeMessage,
        dedupeKey: 'event-hash-1',
      },
      fixture.deps
    );
    expect(retryPromoted).toEqual({
      status: 'queued',
      sessionId: fixture.sessionId,
      userTurnId: first.userTurnId,
      deduplicated: true,
    });
    expect(await fixture.sessionDoc.getMessageQueue()).toHaveLength(0);
  });

  it('unsubscribes archived, deleted, missing, unowned, stopped, or denied sessions', async () => {
    const archived = await createSessionFixture({ meta: { isArchived: true } });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: archived.sessionId, message: 'hi' },
        archived.deps
      )
    ).toEqual({ status: 'unsubscribe', reason: 'session_archived' });

    const deleted = await createSessionFixture({ deleted: true });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: deleted.sessionId, message: 'hi' },
        deleted.deps
      )
    ).toEqual({ status: 'unsubscribe', reason: 'session_deleted' });

    const missing = await createSessionFixture();
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: 'does-not-exist', message: 'hi' },
        missing.deps
      )
    ).toEqual({ status: 'unsubscribe', reason: 'session_not_found' });

    const unowned = await createSessionFixture({
      meta: { machineId: 'other-machine' as MachineId },
    });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: unowned.sessionId, message: 'hi' },
        unowned.deps
      )
    ).toEqual({ status: 'unsubscribe', reason: 'session_not_owned' });

    const stopped = await createSessionFixture({ meta: { collaborationStopped: true } });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: stopped.sessionId, message: 'hi' },
        stopped.deps
      )
    ).toEqual({ status: 'unsubscribe', reason: 'session_stopped' });

    const denied = await createSessionFixture({ canEdit: 'no' });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: denied.sessionId, message: 'hi' },
        denied.deps
      )
    ).toEqual({ status: 'unsubscribe', reason: 'permission_denied' });

    const revoked = await createSessionFixture({ revoked: true });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: revoked.sessionId, message: 'hi' },
        revoked.deps
      )
    ).toEqual({ status: 'unsubscribe', reason: 'workspace_unavailable' });
  });

  it('retries transiently during startup sync or when access is unconfirmed', async () => {
    const syncing = await createSessionFixture({ startupSyncPending: true });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: 'not-loaded-yet', message: 'hi' },
        syncing.deps
      )
    ).toEqual({ status: 'retry', reason: 'workspace_syncing' });

    const unknownAccess = await createSessionFixture({ canEdit: 'unknown' });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: unknownAccess.sessionId, message: 'hi' },
        unknownAccess.deps
      )
    ).toEqual({ status: 'retry', reason: 'permission_unconfirmed' });
  });

  it('signs queued input in encrypted workspaces and retries if signing is unavailable', async () => {
    const signedIntent = 'A'.repeat(131);
    const encrypted = await createSessionFixture({ encrypted: true, signedIntent });
    const queued = await deliverSessionInboxMessage(
      { source: 'ryugi', sessionId: encrypted.sessionId, message: 'Signed Ryugi comment' },
      encrypted.deps
    );
    expect(queued.status).toBe('queued');
    expect(encrypted.signMachineInput).toHaveBeenCalledTimes(1);
    const items = await encrypted.sessionDoc.getMessageQueue();
    expect(items[0]?.e2eeIntent).toBe(signedIntent);

    const unavailable = await createSessionFixture({ encrypted: true, signedIntent: undefined });
    expect(
      await deliverSessionInboxMessage(
        { source: 'ryugi', sessionId: unavailable.sessionId, message: 'Unsigned attempt' },
        unavailable.deps
      )
    ).toEqual({ status: 'retry', reason: 'encrypted_signing_unavailable' });
    expect(await unavailable.sessionDoc.getMessageQueue()).toHaveLength(0);
  });
});

describe('session inbox deliver CLI and local control boundary', () => {
  it('parses Ryugi protocol 1 stdin payloads and builds canonical dedupe keys', () => {
    const parsed = parseRyugiDeliveryPayload(
      JSON.stringify({
        protocol: 1,
        host: 'lody',
        session: 'session-1',
        project: '/repo',
        artifact: 'artboard/hero',
        type: 'ryugi-picks',
        wakeMessage: 'User picked Option B on artboard/hero.',
        event: { b: 2, a: 1 },
      }),
      { env: {} }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.sessionId).toBe('session-1');
    expect(parsed.request.message).toBe('User picked Option B on artboard/hero.');
    expect(parsed.request.metadata).toEqual({
      host: 'lody',
      label: 'Ryugi',
      artifact: 'artboard/hero',
      eventType: 'ryugi-picks',
      project: '/repo',
    });
    expect(parsed.request.dedupeKey).toBe(
      buildRyugiDedupeKey({
        sessionId: 'session-1',
        artifact: 'artboard/hero',
        eventType: 'ryugi-picks',
        wakeMessage: 'User picked Option B on artboard/hero.',
        event: { a: 1, b: 2 },
      })
    );
  });

  it('maps daemon responses and IPC errors to Ryugi receipt exit codes', async () => {
    const stdin = JSON.stringify({
      protocol: 1,
      host: 'lody',
      session: 'session-1',
      wakeMessage: 'Ryugi verdict: approved',
      event: { id: 'evt-1' },
    });

    const queued = await executeSessionInboxDeliver(
      { source: 'ryugi' },
      {
        readStdin: async () => stdin,
        deliver: async () => ({ status: 'queued', sessionId: 'session-1', userTurnId: 'turn-1' }),
      }
    );
    expect(queued.exitCode).toBe(0);
    expect(JSON.parse(queued.stdout ?? '')).toEqual({
      status: 'queued',
      sessionId: 'session-1',
      userTurnId: 'turn-1',
    });

    const unsubscribed = await executeSessionInboxDeliver(
      { source: 'ryugi' },
      {
        readStdin: async () => stdin,
        deliver: async () => ({ status: 'unsubscribe', reason: 'session_archived' }),
      }
    );
    expect(unsubscribed.exitCode).toBe(RYUGI_UNSUBSCRIBE_EXIT_CODE);
    expect(JSON.parse(unsubscribed.stdout ?? '')).toEqual({
      status: 'unsubscribe',
      reason: 'session_archived',
    });

    const daemonDown = await executeSessionInboxDeliver(
      { source: 'ryugi' },
      {
        readStdin: async () => stdin,
        deliver: async () => {
          throw new LocalDaemonAvailabilityError({
            code: 'DAEMON_NOT_RUNNING',
            message: 'not running',
            retryable: false,
          });
        },
      }
    );
    expect(daemonDown.exitCode).toBe(1);
    expect(JSON.parse(daemonDown.stdout ?? '')).toEqual({
      status: 'retry',
      reason: 'daemon_unavailable',
    });
  });

  it('routes /session-inbox-deliver through LocalControlHandler with strict schema validation', async () => {
    const handler = new LocalControlHandler({
      machineId: MACHINE_ID,
      logger: createLogger('test'),
      dispatchSession: async () => [],
      dispatchProject: async () => {
        throw new Error('unused');
      },
      dispatchSessionInboxDeliver: async (req) => ({
        status: 'queued',
        sessionId: req.sessionId,
        userTurnId: 'turn-42',
      }),
    });

    const badJson = await handler.handle({
      path: LOCAL_SESSION_INBOX_DELIVER_PATH,
      rawBody: '{not json',
      requestId: 1,
    });
    expect(badJson.status).toBe(400);

    const blankMsg = await handler.handle({
      path: LOCAL_SESSION_INBOX_DELIVER_PATH,
      rawBody: JSON.stringify({ source: 'ryugi', sessionId: 's1', message: '   ' }),
      requestId: 2,
    });
    expect(blankMsg.status).toBe(400);

    const ok = await handler.handle({
      path: LOCAL_SESSION_INBOX_DELIVER_PATH,
      rawBody: JSON.stringify({
        source: 'ryugi',
        sessionId: 's1',
        message: 'Check contrast on card 2',
      }),
      requestId: 3,
    });
    expect(ok).toEqual({
      status: 200,
      payload: { status: 'queued', sessionId: 's1', userTurnId: 'turn-42' },
    });
  });

  it('delivers end-to-end over a real Unix control socket into SessionDocument messageQueue', async () => {
    const fixture = await createSessionFixture();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-ryugi-ipc-'));
    const socketPath = path.join(tmpDir, 'control.sock');
    const server = http.createServer(
      createLocalSessionControlRequestHandler({
        machineId: MACHINE_ID,
        logger: createLogger('test'),
        dispatchSession: async () => [],
        dispatchProject: async () => {
          throw new Error('unused');
        },
        dispatchSessionInboxDeliver: (req) => deliverSessionInboxMessage(req, fixture.deps),
      })
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const wakeMessage = 'Ryugi comment on whiteboard/flow: split step 2 into two actions.';
      const result = await executeSessionInboxDeliver(
        { source: 'ryugi', socket: socketPath },
        {
          readStdin: async () =>
            JSON.stringify({
              protocol: 1,
              host: 'lody',
              session: fixture.sessionId,
              artifact: 'whiteboard/flow',
              type: 'ryugi-comments',
              wakeMessage,
              event: { id: 'c-99', text: 'split step 2' },
            }),
          env: {},
        }
      );

      expect(result.exitCode).toBe(0);
      const receipt = JSON.parse(result.stdout ?? '') as {
        status: string;
        sessionId: string;
        userTurnId: string;
      };
      expect(receipt.status).toBe('queued');
      expect(receipt.sessionId).toBe(fixture.sessionId);

      const queue = await fixture.sessionDoc.getMessageQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.task).toBe(wakeMessage);
      expect(readMessageAuthor(queue[0]?.author)).toEqual({
        v: 1,
        kind: 'external',
        source: 'ryugi',
        label: 'Ryugi',
        artifact: 'whiteboard/flow',
        eventType: 'ryugi-comments',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
