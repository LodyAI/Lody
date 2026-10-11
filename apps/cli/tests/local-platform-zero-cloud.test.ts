import { resolveSessionMessageAuthor } from '../src/session/message-author';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalCloudPort } from '@lody/platform';
import {
  AGENT_ROLE_VERSION,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  writeWorkspaceAgentRoleToFlock,
  deleteWorkspaceAgentRoleFromFlock,
  type AgentRoleId,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import {
  createLocalSessionCommandEnvironment,
  runWithSessionCommandEnvironment,
} from '../src/lib/session-command-environment';
import { executeDaemonSessionTool } from '../src/mcp/daemon-session-tools';
import { buildLodyMcpServer, runWithMcpSessionContext } from '../src/mcp/lody-mcp-server';
import { LocalControlHandler } from '../src/lib/local-control-handler';
import {
  getLodyOperationStorePath,
  LodyOperationStore,
} from '../src/orchestration/operation-store';

import {
  applyLocalPlatformEnv,
  ensureImplicitLocalWorkspace,
  loadOrCreateLocalIdentity,
} from '../src/lib/cli-platform';
import { LoroDocumentManager } from '../src/lib/loro/doc';
import { makeLocalWorkspaceCatalog } from '../src/lib/local-workspace-catalog';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

describe('local platform zero-cloud integration', () => {
  let tempDir: string;
  let trapServer: http.Server;
  let cloudConnectionAttempts: number;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-zero-cloud-'));
    cloudConnectionAttempts = 0;
    trapServer = http.createServer((_request, response) => {
      cloudConnectionAttempts += 1;
      response.writeHead(503).end();
    });
    trapServer.on('connection', () => {
      cloudConnectionAttempts += 1;
    });
    await new Promise<void>((resolve, reject) => {
      trapServer.once('error', reject);
      trapServer.listen(0, '127.0.0.1', resolve);
    });
    const address = trapServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind the zero-cloud trap server');
    }
    const trapUrl = `http://127.0.0.1:${address.port}`;
    process.env.LODY_PLATFORM = 'local';
    process.env.LODY_DATA_DIR = path.join(tempDir, '.lody-oss');
    process.env.LODY_AUTH_URL = trapUrl;
    process.env.LODY_AUTH_SITE_URL = trapUrl;
    process.env.LODY_SERVER_URL = trapUrl;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await new Promise<void>((resolve, reject) => {
      trapServer.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a Role Session with the daemon repo, freezes its prompt and dispatches without cloud login', async () => {
    applyLocalPlatformEnv();
    const workspaceId = 'lw_role_test' as WorkspaceId;
    const machineId = 'local-role-machine' as MachineId;
    const userId = 'local:role-test';
    const manager = await LoroDocumentManager.create(workspaceId, userId, createSilentLogger());
    const dispatched: SessionId[] = [];
    try {
      await manager.registerMachine(machineId, {
        id: machineId,
        name: 'Local',
        ownerUserId: userId,
      });
      const configId = await manager.createAgentConfig('custom', 'claude', machineId, 'Synthetic');
      const sessionId = await manager.createSession(machineId, 'custom', 'claude');
      await manager.repo.upsertDocMeta(getSessionRoomId(sessionId), { agentConfigId: configId });
      const catalog = await manager.repo.openFlockDoc(getWorkspaceFlockDocId(workspaceId));
      writeWorkspaceAgentRoleToFlock(catalog.flock, {
        v: AGENT_ROLE_VERSION,
        id: 'reviewer' as AgentRoleId,
        ownerUserId: userId,
        visibility: 'private',
        name: 'Reviewer',
        machineId,
        agentConfigId: configId,
        runConfig: {},
        promptPrefix: 'Review carefully.',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await manager.repo.flush();
      const environment = createLocalSessionCommandEnvironment({
        manager,
        workspaceId,
        machineId,
        machineName: 'Local',
        userId,
        host: {
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            active: true,
            sessionId: id,
            requesterUserId: userId,
            sourceTurnId: 'source-turn',
            inputConfig: {
              cliType: 'custom',
              agentType: 'claude',
              modelId: 'source-model',
              agentRoleId: 'planner' as AgentRoleId,
              agentRoleRevision: 1,
              agentRoleSnapshot: { id: 'planner', revision: 1, name: 'Planner', emoji: '🧭' },
            },
          }),
          readLiveStatus: async (id) => ({
            sessionId: id,
            machineOnline: true,
            fresh: true,
            state: 'idle',
          }),
          cancelSession: async () => ({ success: true }),
          dispatchSession: async (id) => {
            dispatched.push(id);
          },
        },
      });
      const context = {
        machineId,
        workspaceId,
        sessionId,
        localControlSocketPath: undefined,
        workdir: tempDir,
      };
      const call = (name: string, args: unknown) =>
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(context, name, args)
        );
      const discovery = await call('lody_agent_role_list', {});
      expect(discovery.isError).not.toBe(true);
      expect(discovery.content[0]?.text).toContain('reviewer');
      const input = {
        operationId: 'role-create',
        agentRoleId: 'reviewer',
        prompt: 'Check the change.',
      };
      const control = new LocalControlHandler({
        machineId,
        logger: createSilentLogger(),
        dispatchSession: async () => {
          throw new Error('Unexpected session control');
        },
        dispatchProject: async () => {
          throw new Error('Unexpected project control');
        },
        dispatchMachineRpc: async (request) => {
          if (request.method !== 'session/call-tool') throw new Error('Unexpected RPC');
          return {
            ok: true,
            result: await runWithSessionCommandEnvironment(environment, () =>
              executeDaemonSessionTool(
                { ...context, sessionId: request.params.sessionId },
                request.params.name,
                request.params.arguments
              )
            ),
          };
        },
      });
      const socketPath =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\lody-role-test-${process.pid}`
          : path.join(tempDir, 'control.sock');
      const socketServer = http.createServer((request, response) => {
        void (async () => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const result = await control.handle({
              path: request.url ?? '',
              rawBody: Buffer.concat(chunks).toString('utf8'),
              requestId: 1,
            });
            response
              .writeHead(result.status, { 'Content-Type': 'application/json' })
              .end(JSON.stringify(result.payload));
          } catch (error) {
            response.writeHead(500).end(String(error));
          }
        })();
      });
      await new Promise<void>((resolve, reject) => {
        socketServer.once('error', reject);
        socketServer.listen(socketPath, resolve);
      });
      const mcpServer = buildLodyMcpServer();
      const client = new Client({ name: 'local-role-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let result;
      try {
        await mcpServer.connect(serverTransport);
        await client.connect(clientTransport);
        result = await runWithMcpSessionContext(
          { ...context, localControlSocketPath: socketPath },
          () => client.callTool({ name: 'lody_session_create', arguments: input })
        );
      } finally {
        await client.close();
        await mcpServer.close();
        await new Promise<void>((resolve, reject) =>
          socketServer.close((error) => (error ? reject(error) : resolve()))
        );
      }
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(dispatched).toHaveLength(1);
      const targetId = dispatched[0];
      if (!targetId) throw new Error('Role Session was not dispatched');
      const target = await manager.repo.getDocMeta(getSessionRoomId(targetId));
      expect(target?.meta).toMatchObject({
        agentRoleId: 'reviewer',
        agentRoleRevision: 1,
        openedBySessionId: sessionId,
      });
      const doc = await manager.getOrCreateSessionDoc(targetId);
      const history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        userId,
        author: {
          kind: 'agent',
          sessionId,
          turnId: 'source-turn',
          name: 'Synthetic',
          model: { id: 'source-model' },
          role: { id: 'planner', name: 'Planner', emoji: '🧭' },
        },
      });
      expect(history[0]?.inputConfig?.modelId).not.toBe('source-model');
      expect(history[0]?.items).toEqual([
        { type: 'text', text: 'Review carefully.\n\nCheck the change.' },
      ]);
      expect(target?.meta.latestUserMsgId).toBe(history[0]?.id);
      await call('lody_session_create', input);
      expect(dispatched).toEqual([targetId]);
      const store = new LodyOperationStore(getLodyOperationStorePath(machineId), undefined, {
        maintenance: false,
      });
      try {
        const operation = store.get(sessionId, 'role-create');
        expect(operation.items[0]).toMatchObject({
          inputDurable: true,
          target: { sessionId: targetId },
        });
        expect(operation.canonicalCommand).toMatchObject({ agentRoleRevision: 1 });
      } finally {
        store.close();
      }
      const targetMeta = target?.meta as import('@lody/shared').SessionMeta;
      const targetInput = history[0];
      if (!targetInput) throw new Error('Missing target input');
      deleteWorkspaceAgentRoleFromFlock(catalog.flock, 'reviewer' as AgentRoleId);
      const targetAuthor = await resolveSessionMessageAuthor(
        manager,
        targetMeta,
        targetInput.id,
        targetInput.inputConfig,
        undefined,
        workspaceId
      );
      await doc.sessionData.commands.appendTurn({
        id: `assistant:${targetInput.id}`,
        role: 'assistant',
        timestamp: targetInput.timestamp,
        userTurnId: targetInput.id,
        author: targetAuthor,
        items: [{ type: 'text', text: 'Synthetic response' }],
        finished: true,
        fileDiff: [],
      });
      const fromTarget = {
        ...environment,
        host: {
          ...environment.host,
          readInvocation: (id: SessionId) => ({
            type: 'session/active-invocation-context' as const,
            active: true as const,
            sessionId: id,
            requesterUserId: userId,
            sourceTurnId: targetInput.id,
            inputConfig: targetInput.inputConfig ?? {},
          }),
        },
      };
      const chat = await runWithSessionCommandEnvironment(fromTarget, () =>
        executeDaemonSessionTool({ ...context, sessionId: targetId }, 'lody_session_chat', {
          operationId: 'reply-to-source',
          sessionId,
          prompt: 'Review completed.',
        })
      );
      expect(chat.isError, JSON.stringify(chat)).not.toBe(true);
      const sourceDoc = await manager.getOrCreateSessionDoc(sessionId);
      const reply = (await sourceDoc.sessionData.history.readAll()).at(-1);
      expect(reply).toMatchObject({
        userId,
        author: {
          sessionId: targetId,
          turnId: targetInput.id,
          role: { id: 'reviewer', name: 'Reviewer' },
        },
      });

      const denied = await environment.checkMachineAccess({
        workspaceId,
        machineId: 'remote' as MachineId,
        requesterUserId: userId,
      });
      expect(denied.allowed).toBe(false);
      const deniedUser = await environment.checkMachineAccess({
        workspaceId,
        machineId,
        requesterUserId: 'another-user',
      });
      expect(deniedUser.allowed).toBe(false);
      await expect(
        runWithSessionCommandEnvironment(environment, () =>
          executeDaemonSessionTool(
            { ...context, workspaceId: 'wrong-workspace' },
            'lody_agent_role_list',
            {}
          )
        )
      ).rejects.toThrow('scope mismatch');
      await expect(
        runWithSessionCommandEnvironment(
          {
            ...environment,
            host: {
              ...environment.host,
              readInvocation: (id) => ({
                type: 'session/active-invocation-context',
                sessionId: id,
                active: false,
              }),
            },
          },
          () => executeDaemonSessionTool(context, 'lody_session_create', input)
        )
      ).rejects.toThrow('active local user Turn');
      await expect(call('lody_feedback', { feedback: 'not allowed' })).rejects.toThrow(
        'Unsupported daemon Session tool'
      );
      expect(cloudConnectionAttempts).toBe(0);
    } finally {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
    }
  });

  it('bootstraps identity, workspace, and the local data plane without touching cloud endpoints', async () => {
    applyLocalPlatformEnv();
    const logger = createSilentLogger();
    const identity = await loadOrCreateLocalIdentity(logger);
    const catalog = makeLocalWorkspaceCatalog({
      filePath: path.join(tempDir, '.lody-oss', 'workspace-catalog.json'),
      lockName: `zero-cloud-${process.pid}`,
      cacheTtlMs: Number.POSITIVE_INFINITY,
    });
    const workspace = await ensureImplicitLocalWorkspace({
      catalog,
      identity,
      machineId: 'local-machine',
      machineName: 'local-host',
      logger,
    });
    const cloudPort = createLocalCloudPort({
      identity: { userId: identity.userId },
      workspaces: [workspace],
    });

    const snapshot = await Effect.runPromise(catalog.read());
    expect(snapshot.identity?.userId).toBe(identity.userId);
    expect(snapshot.workspaces).toHaveLength(1);
    expect(cloudPort.streamsTokens).toBeNull();
    expect(cloudPort.attachmentUpload).toBeNull();
    expect(cloudPort.remotePreview).toBeNull();

    const documentManager = await LoroDocumentManager.create(
      workspace.id as WorkspaceId,
      identity.userId,
      logger,
      {
        streamsTokens: cloudPort.streamsTokens,
        cloudBilling: cloudPort.billing,
      }
    );
    try {
      expect(documentManager.isTransportConnected()).toBe(true);
      await expect(
        cloudPort.access.verifyMachineAccess({
          workspaceId: workspace.id as WorkspaceId,
          requesterUserId: identity.userId,
          machineId: 'local-machine',
        })
      ).resolves.toEqual({ allowed: true });
    } finally {
      await documentManager.cleanUp({ fast: true, preserveSessionStatus: true });
      await cloudPort.dispose();
    }

    expect(process.env.LODY_AUTH_URL).toBeUndefined();
    expect(process.env.LODY_AUTH_SITE_URL).toBeUndefined();
    expect(process.env.LODY_SERVER_URL).toBeUndefined();
    expect(cloudConnectionAttempts).toBe(0);
  });
});
