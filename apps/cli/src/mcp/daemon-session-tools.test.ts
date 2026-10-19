import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionRoomId, type MachineId, type SessionId, type WorkspaceId } from '@lody/shared';
import { bindTestPresenceApplication } from '../../tests/presence-application-fixture';
import { withWorkspaceManager } from '@/lib/command-runtime';
import { LocalControlHandler } from '@/lib/local-control-handler';
import { LoroDocumentManager } from '@/lib/loro/doc';
import { runWithDaemonWorkspace, type DaemonWorkspace } from '@/lib/session-command-environment';
import type { Logger } from '@/utils/logger';
import { executeDaemonSessionTool } from './daemon-session-tools';
import { buildLodyMcpServer, runWithMcpSessionContext } from './lody-mcp-server';

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

const workspaceId = 'synthetic-cloud-workspace' as WorkspaceId;
const machineId = 'synthetic-daemon-machine' as MachineId;
const ownerUserId = 'synthetic-owner';

describe('daemon-hosted Session tools in the cloud composition', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let presenceApplication: ReturnType<typeof bindTestPresenceApplication>;
  let manager: LoroDocumentManager;
  let sessionId: SessionId;
  let daemon: DaemonWorkspace;

  beforeEach(async () => {
    presenceApplication = bindTestPresenceApplication(createSilentLogger());
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-daemon-tools-'));
    process.env.LODY_DATA_DIR = path.join(tempDir, '.lody');
    delete process.env.LODY_PLATFORM;
    manager = await LoroDocumentManager.create(workspaceId, ownerUserId, createSilentLogger());
    await manager.registerMachine(machineId, {
      id: machineId,
      name: 'Daemon',
      ownerUserId,
    });
    sessionId = await manager.createSession(machineId, 'custom', 'claude');
    await manager.repo.flush();
    daemon = {
      workspaceId,
      userId: ownerUserId,
      machineId,
      manager,
      // A collaborator drives this Session on the owner's shared machine.
      readInvocation: (id) => ({
        type: 'session/active-invocation-context',
        active: true,
        sessionId: id,
        requesterUserId: 'synthetic-collaborator',
        sourceTurnId: 'synthetic-turn',
        inputConfig: { cliType: 'custom', agentType: 'claude' },
      }),
    };
  });

  afterEach(async () => {
    await manager.cleanUp({ fast: true });
    await presenceApplication.closeLegacy();
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const context = () => ({
    machineId,
    workspaceId,
    sessionId,
    localControlSocketPath: undefined,
    workdir: tempDir,
  });

  it('executes a Session tool for another requester against the daemon replica', async () => {
    const result = await runWithDaemonWorkspace(daemon, () =>
      executeDaemonSessionTool(context(), 'lody_operation_list', {})
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ items: [] });
  });

  it('routes an MCP process Session tool to the daemon instead of executing it locally', async () => {
    const handled: string[] = [];
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
        handled.push(request.params.name);
        return {
          ok: true,
          result: await runWithDaemonWorkspace(daemon, () =>
            executeDaemonSessionTool(
              { ...context(), sessionId: request.params.sessionId },
              request.params.name,
              request.params.arguments
            )
          ),
        };
      },
    });
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\lody-daemon-tools-${process.pid}`
        : path.join(tempDir, 'control.sock');
    const socketServer = http.createServer((request, response) => {
      void (async () => {
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
      })();
    });
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(socketPath, resolve);
    });
    const mcpServer = buildLodyMcpServer();
    const client = new Client({ name: 'daemon-tools-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await runWithMcpSessionContext(
        { ...context(), localControlSocketPath: socketPath },
        () => client.callTool({ name: 'lody_operation_list', arguments: {} })
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(handled).toEqual(['lody_operation_list']);
    } finally {
      await client.close();
      await mcpServer.close();
      await new Promise<void>((resolve, reject) =>
        socketServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('lends the daemon replica to nested commands and refuses another workspace', async () => {
    const auth = {
      token: 'synthetic-token',
      userId: ownerUserId,
      userName: 'Owner',
      userEmail: 'owner@example.test',
      machineId,
      machineName: 'Daemon',
    };
    const workspace = { id: workspaceId, name: 'Synthetic', slug: 'synthetic', role: 'owner' };
    await runWithDaemonWorkspace(daemon, async () => {
      expect(await withWorkspaceManager(auth, workspace, 'test', async (owner) => owner)).toBe(
        manager
      );
      await expect(
        withWorkspaceManager(auth, { ...workspace, id: 'other-workspace' }, 'test', async () => 1)
      ).rejects.toThrow('Daemon command workspace mismatch');
      await expect(
        withWorkspaceManager({ ...auth, userId: 'other-user' }, workspace, 'test', async () => 1)
      ).rejects.toThrow('restart the daemon');
    });
    // The borrowing command never cleans up the daemon's replica.
    expect((await manager.repo.getDocMeta(getSessionRoomId(sessionId)))?.meta).toMatchObject({
      machineId,
    });
  });

  it('rejects calls outside the daemon workspace scope', async () => {
    await expect(executeDaemonSessionTool(context(), 'lody_operation_list', {})).rejects.toThrow(
      'Session tool scope mismatch'
    );
    await expect(
      runWithDaemonWorkspace(daemon, () =>
        executeDaemonSessionTool(
          { ...context(), workspaceId: 'other-workspace' },
          'lody_operation_list',
          {}
        )
      )
    ).rejects.toThrow('Session tool scope mismatch');
    await expect(
      runWithDaemonWorkspace(daemon, () =>
        executeDaemonSessionTool(
          { ...context(), sessionId: 'missing-session' },
          'lody_operation_list',
          {}
        )
      )
    ).rejects.toThrow('Requester Session does not belong to this machine');
    // A process outliving its Turn cannot keep using the Session's tools.
    await expect(
      runWithDaemonWorkspace(
        {
          ...daemon,
          readInvocation: (id) => ({
            type: 'session/active-invocation-context',
            sessionId: id,
            active: false,
          }),
        },
        () => executeDaemonSessionTool(context(), 'lody_operation_list', {})
      )
    ).rejects.toThrow('Session tool requires an active Turn');
  });
});
