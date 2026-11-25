import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import { getInstallationProfile, getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  createMachineIdentityStore,
  deriveDeterministicMachineId,
  getOrCreateMachineId,
  getSystemMachineId,
  parseMacOsPlatformUuid,
  parseWindowsMachineGuid,
  persistMachineId,
  readExistingMachineId,
  resolveLinuxMachineId,
  type HardwareProbeResult,
} from './machine-identity';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function useIsolatedDataDir(): string {
  const dataDir = makeTempDir('lody-machine-id-');
  vi.stubEnv('LODY_DATA_DIR', dataDir);
  return dataDir;
}

function useTemporaryHome(): {
  homeDir: string;
  dataDir: string;
  stateDir: string;
  namespace: string;
  anchorPath: string;
} {
  const homeDir = makeTempDir('lody-home-');
  const stateDir = path.join(homeDir, 'state');
  vi.stubEnv('LODY_DATA_DIR', '');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('XDG_STATE_HOME', stateDir);
  vi.stubEnv('LOCALAPPDATA', stateDir);
  const { namespace } = getInstallationProfile();
  const dataDir = getLodyDataDir();
  const anchorPath = path.join(stateDir, namespace, 'machine-identity.json');
  return { homeDir, dataDir, stateDir, namespace, anchorPath };
}

function writeCredentials(dataDir: string, machineId: string): void {
  const credentialsPath = path.join(dataDir, 'credentials.json');
  fs.mkdirSync(dataDir, { recursive: true });
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('machine identity pure helpers', () => {
  it('parses macOS IOPlatformUUID and Windows MachineGuid while rejecting all-zero values', () => {
    expect(
      parseMacOsPlatformUuid('  | "IOPlatformUUID" = "B1E5F584-0936-508C-BBF3-C919C20BD0C8"\n')
    ).toBe('b1e5f584-0936-508c-bbf3-c919c20bd0c8');
    expect(
      parseMacOsPlatformUuid('"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"')
    ).toBeNull();

    expect(
      parseWindowsMachineGuid(
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n' +
          '    MachineGuid    REG_SZ    A1B2C3D4-E5F6-7890-ABCD-EF0123456789\r\n'
      )
    ).toBe('a1b2c3d4-e5f6-7890-abcd-ef0123456789');
    expect(
      parseWindowsMachineGuid('    MachineGuid    REG_SZ    00000000-0000-0000-0000-000000000000')
    ).toBeNull();
  });

  it('resolves Linux machine-id with systemd preference and skips containers', () => {
    expect(
      resolveLinuxMachineId(
        (filePath) =>
          filePath === '/etc/machine-id' ? '0123456789abcdef0123456789abcdef\n' : null,
        () => false
      )
    ).toBe('0123456789abcdef0123456789abcdef');

    expect(
      resolveLinuxMachineId(
        (filePath) =>
          filePath === '/var/lib/dbus/machine-id' ? 'fedcba9876543210fedcba9876543210\n' : null,
        () => false
      )
    ).toBe('fedcba9876543210fedcba9876543210');

    expect(
      resolveLinuxMachineId(
        (filePath) =>
          filePath === '/etc/machine-id' ? '00000000000000000000000000000000\n' : 'uninitialized\n',
        () => false
      )
    ).toBeNull();

    expect(
      resolveLinuxMachineId(
        () => '0123456789abcdef0123456789abcdef\n',
        (filePath) => filePath === '/.dockerenv'
      )
    ).toBeNull();

    expect(
      resolveLinuxMachineId(
        () => '0123456789abcdef0123456789abcdef\n',
        (filePath) => filePath === '/run/.containerenv'
      )
    ).toBeNull();
  });

  it('derives deterministic RFC 4122 UUIDv5 scoped by namespace and OS user', () => {
    const uuidV5Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const first = deriveDeterministicMachineId({
      namespace: 'lody',
      userIdentity: 'alice',
      rawHardwareId: 'b1e5f584-0936-508c-bbf3-c919c20bd0c8',
    });
    const second = deriveDeterministicMachineId({
      namespace: 'lody',
      userIdentity: 'alice',
      rawHardwareId: 'b1e5f584-0936-508c-bbf3-c919c20bd0c8',
    });
    const otherNamespace = deriveDeterministicMachineId({
      namespace: 'lody-oss',
      userIdentity: 'alice',
      rawHardwareId: 'b1e5f584-0936-508c-bbf3-c919c20bd0c8',
    });
    const otherUser = deriveDeterministicMachineId({
      namespace: 'lody',
      userIdentity: 'bob',
      rawHardwareId: 'b1e5f584-0936-508c-bbf3-c919c20bd0c8',
    });

    expect(first).toMatch(uuidV5Pattern);
    expect(first).toBe(second);
    expect(first).not.toBe(otherNamespace);
    expect(first).not.toBe(otherUser);
  });
});

describe('machine identity persistence and recovery', () => {
  it('migrates credential machine ID, repairs conflicting or 0-byte machine-id, and ignores invalid credentials', () => {
    const dataDir = useIsolatedDataDir();
    const machineIdPath = path.join(dataDir, 'machine-id');

    expect(readExistingMachineId(dataDir)).toBeNull();
    expect(fs.existsSync(machineIdPath)).toBe(false);

    fs.writeFileSync(
      path.join(dataDir, 'credentials.json'),
      JSON.stringify({ machine: { machineName: 'Test', machineId: 'invalid-shape-id' } })
    );
    const created = getSystemMachineId();
    expect(created).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(getOrCreateMachineId()).toBe(created);

    writeCredentials(dataDir, 'legacy-machine-id');
    expect(getSystemMachineId()).toBe('legacy-machine-id');
    expect(fs.readFileSync(machineIdPath, 'utf8')).toBe('legacy-machine-id');

    fs.rmSync(path.join(dataDir, 'credentials.json'), { force: true });
    fs.writeFileSync(machineIdPath, '   ');
    const repaired = getSystemMachineId();
    expect(repaired).toBeTruthy();
    expect(fs.readFileSync(machineIdPath, 'utf8')).toBe(repaired);
    expect(getSystemMachineId()).toBe(repaired);
  });

  it('keeps the persisted machine ID when a credential repair cannot be written and falls back when unreadable', () => {
    const dataDir = useIsolatedDataDir();
    const machineIdPath = path.join(dataDir, 'machine-id');
    writeCredentials(dataDir, 'legacy-machine-id');
    fs.writeFileSync(machineIdPath, 'persisted-machine-id');
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('write failed');
    });

    expect(getSystemMachineId()).toBe('persisted-machine-id');
    expect(fs.readFileSync(machineIdPath, 'utf8')).toBe('persisted-machine-id');

    fs.rmSync(machineIdPath, { force: true });
    fs.mkdirSync(machineIdPath);
    expect(getSystemMachineId()).toBe('legacy-machine-id');
  });

  it('keeps LODY_DATA_DIR completely isolated from the host anchor', () => {
    const { anchorPath } = useTemporaryHome();
    fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
    fs.writeFileSync(
      anchorPath,
      JSON.stringify({
        version: 1,
        machineId: 'host-anchor-id',
        hostFingerprintHash: 'a'.repeat(64),
      })
    );
    const beforeAnchor = fs.readFileSync(anchorPath, 'utf8');

    const isolatedDir = useIsolatedDataDir();
    const isolatedId = getSystemMachineId();
    expect(isolatedId).not.toBe('host-anchor-id');
    persistMachineId('explicit-isolated-id' as MachineId, { dataDir: isolatedDir });
    expect(fs.readFileSync(anchorPath, 'utf8')).toBe(beforeAnchor);
  });

  it('preserves legacy ID across data-dir deletion, rejects migrated anchors, skips warm probes, and never caches transient failures', () => {
    const { dataDir, stateDir, namespace, anchorPath } = useTemporaryHome();

    let attempt = 0;
    const probeHostA = vi.fn((): HardwareProbeResult => {
      attempt += 1;
      if (attempt === 1) return { kind: 'transient_error' };
      return { kind: 'ok', id: 'AAAAAAAA-1111-2222-3333-444444444444' };
    });
    const hostAStore = createMachineIdentityStore({
      platform: 'darwin',
      userIdentity: 'alice',
      probeHardware: probeHostA,
    });

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'legacy-random-v4-id');

    expect(hostAStore.getSystemMachineId()).toBe('legacy-random-v4-id');
    expect(fs.existsSync(anchorPath)).toBe(false);
    expect(probeHostA).toHaveBeenCalledTimes(1);

    expect(hostAStore.getSystemMachineId()).toBe('legacy-random-v4-id');
    expect(probeHostA).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(anchorPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(anchorPath).mode & 0o777).toBe(0o600);
    }

    const warmProbe = vi.fn((): HardwareProbeResult => ({
      kind: 'ok',
      id: 'AAAAAAAA-1111-2222-3333-444444444444',
    }));
    const warmStore = createMachineIdentityStore({
      platform: 'darwin',
      userIdentity: 'alice',
      probeHardware: warmProbe,
    });
    expect(warmStore.getSystemMachineId()).toBe('legacy-random-v4-id');
    expect(warmProbe).not.toHaveBeenCalled();

    fs.rmSync(dataDir, { recursive: true, force: true });
    expect(hostAStore.getSystemMachineId()).toBe('legacy-random-v4-id');
    expect(fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8')).toBe('legacy-random-v4-id');

    fs.rmSync(dataDir, { recursive: true, force: true });
    const hostBStore = createMachineIdentityStore({
      platform: 'darwin',
      userIdentity: 'alice',
      probeHardware: () => ({ kind: 'ok', id: 'BBBBBBBB-1111-2222-3333-444444444444' }),
    });
    const hostBId = hostBStore.getSystemMachineId();
    expect(hostBId).not.toBe('legacy-random-v4-id');
    expect(hostBId).toBe(
      deriveDeterministicMachineId({
        namespace,
        userIdentity: 'alice',
        rawHardwareId: 'bbbbbbbb-1111-2222-3333-444444444444',
      })
    );

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(hostBStore.getSystemMachineId()).toBe(hostBId);
  });

  it('degrades silently when the anchor path is unwritable', () => {
    const { homeDir, dataDir } = useTemporaryHome();
    const blockingFile = path.join(homeDir, 'not-a-dir');
    fs.writeFileSync(blockingFile, 'x');
    vi.stubEnv('XDG_STATE_HOME', blockingFile);
    vi.stubEnv('LOCALAPPDATA', blockingFile);

    const store = createMachineIdentityStore({
      platform: 'darwin',
      userIdentity: 'alice',
      probeHardware: () => ({ kind: 'ok', id: 'AAAAAAAA-1111-2222-3333-444444444444' }),
    });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'existing-id');

    expect(store.getSystemMachineId()).toBe('existing-id');
  });

  it('round-trips on the real host OS across data-dir wipe and full wipe', () => {
    const { dataDir, stateDir, anchorPath } = useTemporaryHome();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'machine-id'), 'legacy-pre-upgrade-uuid');

    expect(getSystemMachineId()).toBe('legacy-pre-upgrade-uuid');

    if (!fs.existsSync(anchorPath)) {
      return;
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
    expect(getSystemMachineId()).toBe('legacy-pre-upgrade-uuid');

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
