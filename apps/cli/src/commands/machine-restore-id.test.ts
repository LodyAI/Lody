import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInstallationProfile, getLodyDataDir } from '@lody/shared/node/installation-profile';
import { acquireLocalCliHostLease } from '@lody/shared/node/local-cli-host-lease';
import { readAnchorMachineId } from '@/lib/machine-identity';
import { restoreLocalMachineId } from '@/lib/machine-identity-restore';
import { machineRestoreIdCommand } from './machine-restore-id';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function reserveUnusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate loopback port')));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function useIsolatedDefaultHome(): Promise<{
  homeDir: string;
  dataDir: string;
  stateDir: string;
  anchorPath: string;
}> {
  const homeDir = makeTempDir('lody-restore-home-');
  const stateDir = path.join(homeDir, 'state');
  vi.stubEnv('LODY_DATA_DIR', '');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('XDG_STATE_HOME', stateDir);
  vi.stubEnv('LOCALAPPDATA', stateDir);
  vi.stubEnv('LODY_E2E', '1');
  if (process.platform === 'win32') {
    vi.stubEnv(
      'LODY_E2E_LOCAL_CLI_HOST_PIPE',
      `\\\\.\\pipe\\lody-e2e-${crypto.randomBytes(6).toString('hex')}`
    );
  } else {
    vi.stubEnv('LODY_E2E_LOCAL_CLI_HOST_PORT', String(await reserveUnusedPort()));
  }
  const dataDir = getLodyDataDir();
  const anchorPath = path.join(
    stateDir,
    getInstallationProfile().namespace,
    'machine-identity.json'
  );
  return { homeDir, dataDir, stateDir, anchorPath };
}

function writeCredentials(dataDir: string, machineId: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'credentials.json'),
    JSON.stringify(
      {
        version: 3,
        token: 'lody_cli_secret_token',
        user: { id: 'user-1', email: 'user@example.com', name: 'Alice' },
        machine: { machineId, machineName: 'Alice MacBook', extraField: 'keep-me' },
        createdAt: '2026-01-01T00:00:00.000Z',
        extraTopLevel: true,
      },
      null,
      2
    )
  );
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('machine restore-id', () => {
  it('refuses while a real local CLI host lease is active without modifying files', async () => {
    const { dataDir } = await useIsolatedDefaultHome();
    writeCredentials(dataDir, 'current-machine-id');
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'current-machine-id');

    const leased = await acquireLocalCliHostLease({
      instanceId: 'restore-id-test',
      mode: 'daemon',
    });
    expect(leased.status).toBe('acquired');
    if (leased.status !== 'acquired') return;

    try {
      await expect(restoreLocalMachineId('old-machine-id')).rejects.toThrow(/lody daemon stop/);
      expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('current-machine-id');
      expect(
        JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8')).machine
          .machineId
      ).toBe('current-machine-id');
    } finally {
      await leased.lease.close();
    }
  });

  it('backs up existing state, atomically updates machine-id, credentials.json, and anchor, and is idempotent', async () => {
    const { dataDir, anchorPath } = await useIsolatedDefaultHome();
    writeCredentials(dataDir, 'new-machine-id');
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'new-machine-id');

    const result = await restoreLocalMachineId('old-machine-id');
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      targetMachineId: 'old-machine-id',
      previousMachineId: 'new-machine-id',
      previousCredentialMachineId: 'new-machine-id',
      credentialsUpdated: true,
    });
    expect(result.backupDir).toBeTruthy();
    expect(path.basename(result.backupDir ?? '')).toMatch(/^manual-\d{8}-\d{6}-[0-9a-f]{4}$/);

    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('old-machine-id');
    const updatedCreds = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8')
    );
    expect(updatedCreds).toMatchObject({
      version: 3,
      token: 'lody_cli_secret_token',
      user: { id: 'user-1', email: 'user@example.com', name: 'Alice' },
      machine: {
        machineId: 'old-machine-id',
        machineName: 'Alice MacBook',
        extraField: 'keep-me',
      },
      extraTopLevel: true,
    });

    const backupDir = result.backupDir ?? '';
    expect(fs.readFileSync(path.join(backupDir, 'machine-id'), 'utf8')).toBe('new-machine-id');
    expect(
      JSON.parse(fs.readFileSync(path.join(backupDir, 'credentials.json'), 'utf8')).machine
        .machineId
    ).toBe('new-machine-id');

    if (result.anchorUpdated) {
      expect(readAnchorMachineId()).toBe('old-machine-id');
      if (process.platform !== 'win32') {
        expect(fs.statSync(anchorPath).mode & 0o777).toBe(0o600);
      }
    }

    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dataDir, 'machine-id')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dataDir, 'credentials.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(backupDir, 'credentials.json')).mode & 0o777).toBe(0o600);
    }

    const repeat = await restoreLocalMachineId('old-machine-id');
    expect(repeat).toEqual({
      ok: true,
      changed: false,
      targetMachineId: 'old-machine-id',
      previousMachineId: 'old-machine-id',
      previousCredentialMachineId: 'old-machine-id',
      credentialsUpdated: false,
      anchorUpdated: false,
      backupDir: null,
    });
  });

  it('rejects invalid machine IDs and corrupt credentials.json without mutating disk', async () => {
    const dataDir = makeTempDir('lody-restore-corrupt-');
    vi.stubEnv('LODY_DATA_DIR', dataDir);
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'current-id');
    fs.writeFileSync(path.join(dataDir, 'credentials.json'), '{not-valid-json');

    await expect(restoreLocalMachineId('../escape')).rejects.toThrow(/Invalid machine ID/);
    await expect(restoreLocalMachineId('target-id')).rejects.toThrow(/not valid JSON/);
    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('current-id');
  });

  it('runs end-to-end via Commander before login and emits structured --json output', async () => {
    const dataDir = makeTempDir('lody-restore-cli-');
    vi.stubEnv('LODY_DATA_DIR', dataDir);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    await machineRestoreIdCommand.parseAsync(['target-cli-id', '--json'], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(logs.join('\n'))).toEqual({
      ok: true,
      changed: true,
      targetMachineId: 'target-cli-id',
      previousMachineId: null,
      previousCredentialMachineId: null,
      credentialsUpdated: false,
      anchorUpdated: false,
      backupDir: null,
    });
    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('target-cli-id');
    expect(fs.existsSync(path.join(dataDir, 'credentials.json'))).toBe(false);
  });
});
