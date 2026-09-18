import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalCloudPort } from '@lody/platform';
import type { WorkspaceId } from '@lody/shared';

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
      },
    );
    try {
      expect(documentManager.isTransportConnected()).toBe(true);
      await expect(
        cloudPort.access.verifyMachineAccess({
          workspaceId: workspace.id as WorkspaceId,
          requesterUserId: identity.userId,
          machineId: 'local-machine',
        }),
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
