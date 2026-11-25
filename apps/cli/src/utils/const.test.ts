import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import {
  getOrCreateStableMachineIdAsync,
  getSystemMachineId,
  getSystemMachineIdAsync,
  persistMachineId,
} from './const';
import * as machineIdentityStore from './machine-identity-store';

const temporaryDataDirs: string[] = [];

function useTemporaryDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-machine-id-'));
  temporaryDataDirs.push(dataDir);
  vi.stubEnv('LODY_DATA_DIR', dataDir);
  return dataDir;
}

function useTemporaryHomeDir(): { homeDir: string; stateDir: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-home-'));
  const stateDir = path.join(homeDir, 'state');
  temporaryDataDirs.push(homeDir);
  vi.stubEnv('LODY_DATA_DIR', '');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('XDG_STATE_HOME', stateDir);
  vi.stubEnv('LOCALAPPDATA', stateDir);
  return { homeDir, stateDir };
}

function writeCredentials(dataDir: string, machineId: string): void {
  const credentialsPath = path.join(dataDir, 'credentials.json');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(
    credentialsPath,
    JSON.stringify({
      version: 3,
      token: 'token',
      user: { id: 'user-1', email: 'user@example.com' },
      machine: { machineName: 'Test Machine', machineId },
    })
  );
}

afterEach(() => {
  machineIdentityStore.resetHostHardwareIdCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dataDir of temporaryDataDirs.splice(0)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('machine ID', () => {
  it('migrates the existing credential machine ID on first use', () => {
    const dataDir = useTemporaryDataDir();
    const credentialMachineId = 'legacy-machine-id';
    writeCredentials(dataDir, credentialMachineId);

    expect(getSystemMachineId()).toBe(credentialMachineId);
    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf-8')).toBe(credentialMachineId);
  });

  it('repairs a generated machine ID that conflicts with valid cached auth', () => {
    const dataDir = useTemporaryDataDir();
    const machineIdPath = path.join(dataDir, 'machine-id');
    const credentialMachineId = 'legacy-machine-id';
    writeCredentials(dataDir, credentialMachineId);
    fs.writeFileSync(machineIdPath, '4fd0b184-b27e-4df2-b631-90abac018c87');

    expect(getSystemMachineId()).toBe(credentialMachineId);
    expect(fs.readFileSync(machineIdPath, 'utf-8')).toBe(credentialMachineId);
  });

  it('keeps the persisted machine ID aligned after cached auth changes', () => {
    const dataDir = useTemporaryDataDir();
    const machineIdPath = path.join(dataDir, 'machine-id');
    fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
    fs.writeFileSync(machineIdPath, 'previous-machine-id');
    writeCredentials(dataDir, 'current-auth-machine-id');

    expect(getSystemMachineId()).toBe('current-auth-machine-id');
    expect(fs.readFileSync(machineIdPath, 'utf-8')).toBe('current-auth-machine-id');
  });

  it('falls back to valid credentials when the machine ID file cannot be read', () => {
    const dataDir = useTemporaryDataDir();
    const machineIdPath = path.join(dataDir, 'machine-id');
    const credentialMachineId = 'legacy-machine-id';
    writeCredentials(dataDir, credentialMachineId);
    fs.mkdirSync(machineIdPath);

    expect(getSystemMachineId()).toBe(credentialMachineId);
  });

  it('keeps the persisted machine ID when a credential repair cannot be written', () => {
    const dataDir = useTemporaryDataDir();
    const machineIdPath = path.join(dataDir, 'machine-id');
    const persistedMachineId = 'persisted-machine-id';
    writeCredentials(dataDir, 'legacy-machine-id');
    fs.writeFileSync(machineIdPath, persistedMachineId);
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('write failed');
    });

    expect(getSystemMachineId()).toBe(persistedMachineId);
    expect(fs.readFileSync(machineIdPath, 'utf-8')).toBe(persistedMachineId);
  });

  it('ignores invalid credentials even when they contain a machine ID', () => {
    const dataDir = useTemporaryDataDir();
    const credentialsPath = path.join(dataDir, 'credentials.json');
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ machine: { machineName: 'Test Machine', machineId: 'copied-machine-id' } })
    );

    expect(getSystemMachineId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('reuses the persisted UUID across all machine ID entry points', async () => {
    useTemporaryDataDir();

    const first = getSystemMachineId();

    await expect(getSystemMachineIdAsync()).resolves.toBe(first);
    await expect(getOrCreateStableMachineIdAsync()).resolves.toBe(first);
  });

  it('never touches the host anchor or hardware recovery when LODY_DATA_DIR is set', () => {
    useTemporaryDataDir();
    const syncSpy = vi.spyOn(machineIdentityStore, 'syncMachineIdentityAnchor');
    const recoverSpy = vi.spyOn(machineIdentityStore, 'recoverMachineIdFromAnchorOrHardware');

    const first = getSystemMachineId();
    expect(first).toBeTruthy();
    persistMachineId('explicit-isolated-id' as MachineId);

    expect(syncSpy).not.toHaveBeenCalled();
    expect(recoverSpy).not.toHaveBeenCalled();
  });

  it('syncs existing identity to the backup anchor and recovers when the data dir is wiped', () => {
    const { homeDir } = useTemporaryHomeDir();
    const syncSpy = vi
      .spyOn(machineIdentityStore, 'syncMachineIdentityAnchor')
      .mockReturnValue(true);
    const recoverSpy = vi
      .spyOn(machineIdentityStore, 'recoverMachineIdFromAnchorOrHardware')
      .mockReturnValue({
        machineId: 'recovered-legacy-id' as MachineId,
        source: 'anchor',
      });

    const dataDir = path.join(homeDir, '.lody');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'recovered-legacy-id');

    expect(getSystemMachineId()).toBe('recovered-legacy-id');
    expect(syncSpy).toHaveBeenCalledWith('recovered-legacy-id');

    fs.rmSync(dataDir, { recursive: true, force: true });
    expect(getSystemMachineId()).toBe('recovered-legacy-id');
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf-8')).toBe('recovered-legacy-id');
  });

  it('preserves a legacy ID across ~/.lody deletion and derives a stable ID across full wipe when host hardware ID is available', () => {
    if (!machineIdentityStore.readHostHardwareId()) {
      return;
    }

    const { homeDir, stateDir } = useTemporaryHomeDir();
    const dataDir = path.join(homeDir, '.lody');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'legacy-pre-upgrade-uuid');

    // First run populates the backup anchor outside ~/.lody.
    expect(getSystemMachineId()).toBe('legacy-pre-upgrade-uuid');

    // Deleting ~/.lody alone restores the exact legacy UUID from the anchor.
    fs.rmSync(dataDir, { recursive: true, force: true });
    expect(getSystemMachineId()).toBe('legacy-pre-upgrade-uuid');

    // Deleting both ~/.lody and the anchor falls back to a deterministic UUIDv5.
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    const deterministicFirst = getSystemMachineId();
    expect(deterministicFirst).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(getSystemMachineId()).toBe(deterministicFirst);
  });
});
