import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineId, WorkspaceId } from '@lody/shared';
import {
  LoroStreamsMachineRpcClient,
  LoroStreamsMachineRpcServer,
  createLoroStreamsJsonStreamClient,
} from '../src/index';

type LocalLoroDevServer = {
  baseUrl: string;
  stop: () => Promise<void>;
};

const configId = 'config-1' as AgentConfigId;

const createSilentLogger = () => ({
  warn: () => {},
});

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const packageRequire = createRequire(import.meta.url);
const loroCliPackageJsonPath = packageRequire.resolve('@loro-dev/loro-cli/package.json');
const loroCliPackageJson = packageRequire(loroCliPackageJsonPath) as {
  readonly bin?: { readonly loro?: string };
};
const loroCliBinPath = path.join(
  path.dirname(loroCliPackageJsonPath),
  loroCliPackageJson.bin?.loro ?? 'bin/loro.mjs'
);
const runIntegrationTests = process.env.LODY_LORO_STREAMS_RPC_INTEGRATION === '1';

const runCommand = async (command: string, args: string[], cwd: string): Promise<void> => {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command failed: ${command} ${args.join(' ')} (code=${code} signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    });
  });
};

const ensureLoroCliSqliteBinding = async (): Promise<void> => {
  const cliRequire = createRequire(loroCliPackageJsonPath);
  const betterSqlitePackageJsonPath = cliRequire.resolve('better-sqlite3/package.json');
  const betterSqliteDir = path.dirname(betterSqlitePackageJsonPath);
  const bindingPath = path.join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node');

  try {
    await access(bindingPath);
    return;
  } catch {
    await runCommand(pnpmCommand, ['--dir', betterSqliteDir, 'run', 'install'], packageRoot);
  }
};

const startLocalLoroDevServer = async (): Promise<LocalLoroDevServer> => {
  await ensureLoroCliSqliteBinding();

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lody-loro-streams-rpc-'));
  const dbPath = path.join(tempDir, 'dev.sqlite');
  const child = spawn(
    process.execPath,
    [loroCliBinPath, 'dev', '--host', '127.0.0.1', '--port', '0', '--db-path', dbPath, '--json'],
    {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  let settled = false;

  const startup = new Promise<string>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      fn();
    };

    const tryResolve = () => {
      try {
        const parsed = JSON.parse(stdout) as {
          ok?: boolean;
          data?: { baseUrl?: string };
        };
        if (parsed.ok === true && typeof parsed.data?.baseUrl === 'string') {
          finish(() => resolve(parsed.data?.baseUrl as string));
        }
      } catch {
        // Wait for the full JSON envelope.
      }
    };

    const timeoutId = setTimeout(() => {
      finish(() => {
        reject(
          new Error(
            `Timed out waiting for local loro dev server startup.\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
      });
    }, 15_000);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      tryResolve();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('exit', (code, signal) => {
      finish(() => {
        reject(
          new Error(
            `Local loro dev server exited before startup finished (code=${code} signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
      });
    });
  });

  const baseUrl = await startup;

  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => undefined);
      }
      await rm(tempDir, { recursive: true, force: true });
    },
  };
};

describe.runIf(runIntegrationTests)('loro streams rpc integration', () => {
  let localServer: LocalLoroDevServer | null = null;

  beforeAll(async () => {
    localServer = await startLocalLoroDevServer();
  }, 30_000);

  afterAll(async () => {
    await localServer?.stop();
  }, 30_000);

  it('reuses legacy JSON streams created without TTL after retention is enabled', async () => {
    if (!localServer) {
      throw new Error('Local loro dev server was not started');
    }

    const bucketId = `rpc-${randomUUID()}`;
    const streamId = `workspace-${randomUUID()}:rpc:req:machine-${randomUUID()}`;
    const streamClient = createLoroStreamsJsonStreamClient({
      bucketId,
      baseUrl: localServer.baseUrl,
      getToken: async () => 'dev-token',
    });

    await streamClient.ensureJsonStream(streamId);
    await expect(streamClient.ensureJsonStream(streamId, 3600)).resolves.toBeUndefined();
  }, 20_000);

  it('handles machine status requests against a local loro dev server', async () => {
    if (!localServer) {
      throw new Error('Local loro dev server was not started');
    }

    const workspaceId = `workspace-${randomUUID()}` as WorkspaceId;
    const machineId = `machine-${randomUUID()}` as MachineId;
    const bucketId = `rpc-${randomUUID()}`;
    const baseUrl = localServer.baseUrl;
    const createStreamClient = () =>
      createLoroStreamsJsonStreamClient({
        bucketId,
        baseUrl,
        getToken: async () => 'dev-token',
      });

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: createStreamClient(),
      getMachineStatus: async () => ({
        type: 'machine/status_response',
        machineId,
        success: true,
        resources: {
          totalMemoryGB: 16,
          usedMemoryGB: 6,
          freeMemoryGB: 10,
          totalCpus: 10,
          cpuUsagePercent: 20,
        },
      }),
      refreshMachineAcpCapabilities: async () => ({
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId,
        cliType: 'builtin',
        agentType: 'codex',
        success: true,
        modes: [],
        models: [],
        configOptions: [],
      }),
    });
    const client = new LoroStreamsMachineRpcClient({
      workspaceId,
      machineId,
      streamClient: createStreamClient(),
    });

    await server.start();

    await expect(client.requestMachineStatus({ timeoutMs: 10_000 })).resolves.toEqual(
      expect.objectContaining({
        type: 'machine/status_response',
        machineId,
        success: true,
        resources: expect.objectContaining({
          totalMemoryGB: 16,
          freeMemoryGB: 10,
        }),
      })
    );

    client.stop();
    server.stop();
  }, 20_000);

  it('handles ACP capabilities refresh requests against a local loro dev server', async () => {
    if (!localServer) {
      throw new Error('Local loro dev server was not started');
    }

    const workspaceId = `workspace-${randomUUID()}` as WorkspaceId;
    const machineId = `machine-${randomUUID()}` as MachineId;
    const bucketId = `rpc-${randomUUID()}`;
    const baseUrl = localServer.baseUrl;
    const createStreamClient = () =>
      createLoroStreamsJsonStreamClient({
        bucketId,
        baseUrl,
        getToken: async () => 'dev-token',
      });

    const server = new LoroStreamsMachineRpcServer({
      logger: createSilentLogger(),
      workspaceId,
      machineId,
      streamClient: createStreamClient(),
      getMachineStatus: async () => ({
        type: 'machine/status_response',
        machineId,
        success: true,
        resources: {
          totalMemoryGB: 16,
          usedMemoryGB: 6,
          freeMemoryGB: 10,
          totalCpus: 10,
          cpuUsagePercent: 20,
        },
      }),
      refreshMachineAcpCapabilities: async ({ configId: requestedConfigId }) => ({
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId: requestedConfigId,
        cliType: 'builtin',
        agentType: 'codex',
        success: true,
        modes: [{ id: 'agent', name: 'Agent' }],
        models: [{ modelId: 'gpt-5', name: 'GPT-5' }],
        configOptions: [],
      }),
    });
    const client = new LoroStreamsMachineRpcClient({
      workspaceId,
      machineId,
      streamClient: createStreamClient(),
    });

    await server.start();

    await expect(
      client.requestMachineAcpCapabilitiesRefresh({
        configId,
        timeoutMs: 10_000,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId,
        cliType: 'builtin',
        agentType: 'codex',
        success: true,
        modes: [{ id: 'agent', name: 'Agent' }],
      })
    );

    client.stop();
    server.stop();
  }, 20_000);
});
