import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineIdentityAnchorPath,
  readMachineIdentityAnchor,
  type MachineIdentityStoreOptions,
} from '@/utils/machine-identity-store';
import {
  machineRestoreIdCommand,
  restoreLocalMachineId,
  validateMachineId,
} from './machine-restore-id';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('machine restore-id', () => {
  it('validates machine ID format', () => {
    expect(validateMachineId('  abc-123_456:789.0  ')).toBe('abc-123_456:789.0');
    expect(() => validateMachineId('')).toThrow(/Invalid machine ID/);
    expect(() => validateMachineId('   ')).toThrow(/Invalid machine ID/);
    expect(() => validateMachineId('../escape')).toThrow(/Invalid machine ID/);
    expect(() => validateMachineId('id with spaces')).toThrow(/Invalid machine ID/);
    expect(() => validateMachineId('a'.repeat(129))).toThrow(/Invalid machine ID/);
  });

  it('refuses to run while desktop app, daemon, or foreground start is active', async () => {
    const dataDir = makeTempDir('lody-restore-host-');

    await expect(
      restoreLocalMachineId('old-machine-id', {
        dataDir,
        isCustomDataDir: false,
        inspectHost: async () => ({
          mode: 'electron',
          pid: 1234,
          instanceId: 'inst-1',
        }),
      })
    ).rejects.toThrow(/Quit the Lody desktop app completely/);

    await expect(
      restoreLocalMachineId('old-machine-id', {
        dataDir,
        isCustomDataDir: false,
        inspectHost: async () => ({
          mode: 'daemon',
          pid: 5678,
          instanceId: 'inst-2',
        }),
      })
    ).rejects.toThrow(/lody daemon stop/);

    await expect(
      restoreLocalMachineId('old-machine-id', {
        dataDir,
        isCustomDataDir: false,
        inspectHost: async () => ({
          mode: 'foreground',
          pid: 9012,
          instanceId: 'inst-3',
        }),
      })
    ).rejects.toThrow(/lody start/);
  });

  it('backs up existing state, updates machine-id, credentials.json, and anchor atomically', async () => {
    const homeDir = makeTempDir('lody-restore-home-');
    const dataDir = path.join(homeDir, '.lody');
    const anchorOptions: MachineIdentityStoreOptions = {
      platform: 'darwin',
      homeDir,
      env: {},
      namespace: 'lody',
      runCommand: () => '"IOPlatformUUID" = "AAAAAAAA-1111-2222-3333-444444444444"',
    };

    writeCredentials(dataDir, 'new-machine-id');
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'new-machine-id');

    const result = await restoreLocalMachineId('old-machine-id', {
      dataDir,
      isCustomDataDir: false,
      inspectHost: async () => null,
      anchorOptions,
      now: () => new Date('2026-05-01T12:34:56.000Z'),
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      targetMachineId: 'old-machine-id',
      previousMachineId: 'new-machine-id',
      previousCredentialMachineId: 'new-machine-id',
      credentialsUpdated: true,
      anchorUpdated: true,
    });
    expect(result.backupDir).toBeTruthy();
    expect(path.basename(result.backupDir ?? '')).toMatch(/^manual-20260501-123456-[0-9a-f]{4}$/);

    // Verify updated files preserve unrelated credential fields.
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

    // Verify backup contents and permissions.
    const backupDir = result.backupDir ?? '';
    expect(fs.readFileSync(path.join(backupDir, 'machine-id'), 'utf8')).toBe('new-machine-id');
    const backedUpCreds = JSON.parse(
      fs.readFileSync(path.join(backupDir, 'credentials.json'), 'utf8')
    );
    expect(backedUpCreds.machine.machineId).toBe('new-machine-id');

    // Verify anchor updated.
    expect(readMachineIdentityAnchor(anchorOptions)?.machineId).toBe('old-machine-id');

    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dataDir, 'machine-id')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dataDir, 'credentials.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(backupDir, 'credentials.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(getMachineIdentityAnchorPath(anchorOptions)).mode & 0o777).toBe(0o600);
    }

    // Re-running with the same ID is idempotent and does not create another backup.
    const secondResult = await restoreLocalMachineId('old-machine-id', {
      dataDir,
      isCustomDataDir: false,
      inspectHost: async () => null,
      anchorOptions,
    });
    expect(secondResult).toEqual({
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

  it('works cleanly before login when credentials.json does not exist', async () => {
    const homeDir = makeTempDir('lody-restore-nocreds-');
    const dataDir = path.join(homeDir, '.lody');
    const anchorOptions: MachineIdentityStoreOptions = {
      platform: 'darwin',
      homeDir,
      env: {},
      namespace: 'lody',
      runCommand: () => '"IOPlatformUUID" = "AAAAAAAA-1111-2222-3333-444444444444"',
    };

    const result = await restoreLocalMachineId('restored-offline-id', {
      dataDir,
      isCustomDataDir: false,
      inspectHost: async () => null,
      anchorOptions,
    });

    expect(result).toEqual({
      ok: true,
      changed: true,
      targetMachineId: 'restored-offline-id',
      previousMachineId: null,
      previousCredentialMachineId: null,
      credentialsUpdated: false,
      anchorUpdated: true,
      backupDir: null,
    });
    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('restored-offline-id');
    expect(fs.existsSync(path.join(dataDir, 'credentials.json'))).toBe(false);
    expect(readMachineIdentityAnchor(anchorOptions)?.machineId).toBe('restored-offline-id');
  });

  it('refuses to overwrite when existing credentials.json is corrupt', async () => {
    const dataDir = makeTempDir('lody-restore-corrupt-');
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'current-id');
    fs.writeFileSync(path.join(dataDir, 'credentials.json'), '{not-valid-json');

    await expect(
      restoreLocalMachineId('target-id', {
        dataDir,
        isCustomDataDir: true,
        inspectHost: async () => null,
      })
    ).rejects.toThrow(/not valid JSON/);

    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('current-id');
  });

  it('supports --json output on CLI action with custom LODY_DATA_DIR', async () => {
    const dataDir = makeTempDir('lody-restore-cli-');
    vi.stubEnv('LODY_DATA_DIR', dataDir);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    try {
      await machineRestoreIdCommand.parseAsync(['target-cli-id', '--json'], { from: 'user' });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(process.exitCode).toBeUndefined();
    const parsed = JSON.parse(logs.join('\n')) as {
      ok: boolean;
      changed: boolean;
      targetMachineId: string;
    };
    expect(parsed).toMatchObject({
      ok: true,
      changed: true,
      targetMachineId: 'target-cli-id',
    });
    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('target-cli-id');
  });
});
