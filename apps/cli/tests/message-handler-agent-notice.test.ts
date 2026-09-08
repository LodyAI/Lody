import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import {
  MessageContentSchema,
  type ACPSessionId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { AgentClient, type AgentSessionWarning } from '../src/agent/agent-client';
import { MessageHandler } from '../src/lib/message-handler';
import { SessionDocument } from '../src/lib/loro/doc';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

type MessageHandlerHost = {
  flushThreadGoalHistoryPersists(sessionId: SessionId): Promise<void>;
};

const sessionInfoNotification = (meta: Record<string, unknown>): SessionNotification =>
  ({
    sessionId: 'acp-test',
    update: { sessionUpdate: 'session_info_update', _meta: meta },
  }) as unknown as SessionNotification;

describe('MessageHandler agent notices', () => {
  let repo: LoroRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await repo.destroy();
      repo = undefined;
    }
  });

  it('persists every info occurrence while preserving warning deduplication', async () => {
    const sessionId = 'notice-session' as SessionId;
    repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    let onAgentWarning:
      | ((eventSessionId: SessionId, warning: AgentSessionWarning) => void)
      | undefined;
    const sessionManager = {
      on: vi.fn((event: string, listener: unknown) => {
        if (event === 'onAgentWarning') {
          onAgentWarning = listener as (
            eventSessionId: SessionId,
            warning: AgentSessionWarning
          ) => void;
        }
      }),
      setRequestPermissionHandler: vi.fn(),
      getSession: vi.fn(() => null),
    };
    const workspaceDocument = {
      isTransportConnected: vi.fn(() => true),
      markMachineFlockDocDirty: vi.fn(),
      registerMachine: vi.fn(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({
          meta: { needToArchiveSessions: {}, needToDeleteSessions: {} },
        })),
      },
      getOrCreateSessionDoc: vi.fn(async () => doc),
    };
    const logger = createSilentLogger();
    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId: 'ws-1' as WorkspaceId,
        userId: 'u-1',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort(),
      }
    ) as unknown as MessageHandlerHost;

    const client = new AgentClient({
      sessionId,
      logger,
      terminalManager: {} as never,
      agentConfig: { cliType: 'builtin', agentType: 'codex' },
      onUpdateMessage: vi.fn(),
      onRequestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
      onAgentWarning: (warning) => onAgentWarning?.(sessionId, warning),
    });
    // @ts-expect-error - accessing private field for test setup
    client.acpSessionId = 'acp-test' as ACPSessionId;

    const message = 'Pi processed this input without starting a model turn.';
    const info = sessionInfoNotification({
      lody: { notice: { level: 'info', message, source: 'pi' } },
    });
    await client.sessionUpdate(info);
    await client.sessionUpdate(info);
    await client.sessionUpdate(
      sessionInfoNotification({
        lody: { notice: { level: 'warning', message, source: 'pi' } },
      })
    );
    const legacyWarning = sessionInfoNotification({
      codex: { warning: { message: 'Legacy warning', source: 'warning' } },
    });
    await client.sessionUpdate(legacyWarning);
    await client.sessionUpdate(legacyWarning);
    await handler.flushThreadGoalHistoryPersists(sessionId);

    const notices = (await doc.getHistory()).flatMap((entry) =>
      (entry.items ?? [])
        .filter((item) => item.type === 'system_notice' && item.name === 'agent_warning')
        .map((item) => MessageContentSchema.parse(item).meta)
    );
    expect(notices).toEqual([
      { level: 'info', message, source: 'pi' },
      { level: 'info', message, source: 'pi' },
      { level: 'warning', message, source: 'pi' },
      { message: 'Legacy warning', source: 'warning' },
    ]);
  });
});
