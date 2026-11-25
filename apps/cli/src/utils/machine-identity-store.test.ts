import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeHostFingerprintHash,
  deriveDeterministicMachineId,
  getMachineIdentityAnchorPath,
  isCustomLodyDataDir,
  parseMacOsPlatformUuid,
  parseWindowsMachineGuid,
  readHostHardwareId,
  readMachineIdentityAnchor,
  recoverMachineIdFromAnchorOrHardware,
  resetHostHardwareIdCacheForTests,
  syncMachineIdentityAnchor,
} from './machine-identity-store';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetHostHardwareIdCacheForTests();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('machine-identity-store', () => {
  it('detects custom LODY_DATA_DIR overrides', () => {
    expect(isCustomLodyDataDir({})).toBe(false);
    expect(isCustomLodyDataDir({ LODY_DATA_DIR: '   ' })).toBe(false);
    expect(isCustomLodyDataDir({ LODY_DATA_DIR: '/tmp/custom' })).toBe(true);
  });

  it('resolves OS-standard anchor paths outside ~/.lody', () => {
    expect(
      getMachineIdentityAnchorPath({
        platform: 'darwin',
        homeDir: '/Users/alice',
        env: {},
        namespace: 'lody',
      })
    ).toBe(path.join('/Users/alice', '.local', 'state', 'lody', 'machine-identity.json'));

    expect(
      getMachineIdentityAnchorPath({
        platform: 'linux',
        homeDir: '/home/alice',
        env: { XDG_STATE_HOME: '/var/state/alice' },
        namespace: 'lody-oss',
      })
    ).toBe(path.join('/var/state/alice', 'lody-oss', 'machine-identity.json'));

    expect(
      getMachineIdentityAnchorPath({
        platform: 'win32',
        homeDir: 'C:\\Users\\alice',
        env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
        namespace: 'lody',
      })
    ).toBe(path.join('C:\\Users\\alice\\AppData\\Local', 'lody', 'machine-identity.json'));
  });

  it('parses macOS IOPlatformUUID and rejects all-zero values', () => {
    const sample = `
      +-o Root  <class IORegistryEntry>
        | "IOPlatformUUID" = "B1E5F584-0936-508C-BBF3-C919C20BD0C8"
    `;
    expect(parseMacOsPlatformUuid(sample)).toBe('b1e5f584-0936-508c-bbf3-c919c20bd0c8');
    expect(
      parseMacOsPlatformUuid('"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"')
    ).toBeNull();
    expect(parseMacOsPlatformUuid('no uuid here')).toBeNull();
  });

  it('parses Windows MachineGuid and rejects all-zero values', () => {
    const sample = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809
`;
    expect(parseWindowsMachineGuid(sample)).toBe('1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809');
    expect(
      parseWindowsMachineGuid('    MachineGuid    REG_SZ    00000000-0000-0000-0000-000000000000')
    ).toBeNull();
  });

  it('reads Linux /etc/machine-id, falls back to dbus, and skips containers', () => {
    expect(
      readHostHardwareId({
        platform: 'linux',
        exists: () => false,
        readFile: (filePath) =>
          filePath === '/etc/machine-id' ? '0123456789abcdef0123456789abcdef\n' : null,
      })
    ).toBe('0123456789abcdef0123456789abcdef');

    expect(
      readHostHardwareId({
        platform: 'linux',
        exists: () => false,
        readFile: (filePath) =>
          filePath === '/var/lib/dbus/machine-id' ? 'fedcba9876543210fedcba9876543210\n' : null,
      })
    ).toBe('fedcba9876543210fedcba9876543210');

    expect(
      readHostHardwareId({
        platform: 'linux',
        exists: (filePath) => filePath === '/.dockerenv',
        readFile: () => '0123456789abcdef0123456789abcdef\n',
      })
    ).toBeNull();

    expect(
      readHostHardwareId({
        platform: 'linux',
        exists: (filePath) => filePath === '/run/.containerenv',
        readFile: () => '0123456789abcdef0123456789abcdef\n',
      })
    ).toBeNull();
  });

  it('derives stable RFC 4122 UUIDv5 isolated by namespace and OS user', () => {
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

  it('writes owner-only anchor and skips OS probe on warm-path sync', () => {
    const homeDir = makeTempDir('lody-anchor-home-');
    const runCommand = vi.fn(() => '"IOPlatformUUID" = "B1E5F584-0936-508C-BBF3-C919C20BD0C8"');
    const storeOptions = {
      platform: 'darwin' as const,
      homeDir,
      env: {},
      namespace: 'lody' as const,
      runCommand,
    };

    expect(syncMachineIdentityAnchor('legacy-uuid-1', storeOptions)).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);

    const anchorPath = getMachineIdentityAnchorPath(storeOptions);
    const anchor = readMachineIdentityAnchor(storeOptions);
    expect(anchor).toEqual({
      version: 1,
      machineId: 'legacy-uuid-1',
      hostFingerprintHash: computeHostFingerprintHash(
        'darwin',
        'b1e5f584-0936-508c-bbf3-c919c20bd0c8'
      ),
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(anchorPath).mode & 0o777).toBe(0o600);
    }

    // Warm hit: matching machineId avoids spawning ioreg again.
    expect(syncMachineIdentityAnchor('legacy-uuid-1', storeOptions)).toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('recovers legacy ID from matching anchor, rejects migrated anchor, and falls back to hardware UUIDv5', () => {
    const homeDir = makeTempDir('lody-anchor-recover-');
    const hostAOptions = {
      platform: 'darwin' as const,
      homeDir,
      env: {},
      namespace: 'lody' as const,
      userIdentity: 'alice',
      runCommand: () => '"IOPlatformUUID" = "AAAAAAAA-1111-2222-3333-444444444444"',
    };

    expect(syncMachineIdentityAnchor('legacy-random-v4-id', hostAOptions)).toBe(true);
    expect(recoverMachineIdFromAnchorOrHardware(hostAOptions)).toEqual({
      machineId: 'legacy-random-v4-id',
      source: 'anchor',
    });

    // Simulate cloning/migrating home directory to a different host B.
    const hostBOptions = {
      ...hostAOptions,
      runCommand: () => '"IOPlatformUUID" = "BBBBBBBB-1111-2222-3333-444444444444"',
    };
    const hostBRecovered = recoverMachineIdFromAnchorOrHardware(hostBOptions);
    expect(hostBRecovered?.source).toBe('hardware');
    expect(hostBRecovered?.machineId).not.toBe('legacy-random-v4-id');
    expect(hostBRecovered?.machineId).toBe(
      deriveDeterministicMachineId({
        namespace: 'lody',
        userIdentity: 'alice',
        rawHardwareId: 'bbbbbbbb-1111-2222-3333-444444444444',
      })
    );

    // Full wipe (anchor deleted) on host A still derives deterministic UUIDv5.
    fs.rmSync(getMachineIdentityAnchorPath(hostAOptions), { force: true });
    const wipedHostA = recoverMachineIdFromAnchorOrHardware(hostAOptions);
    expect(wipedHostA).toEqual({
      machineId: deriveDeterministicMachineId({
        namespace: 'lody',
        userIdentity: 'alice',
        rawHardwareId: 'aaaaaaaa-1111-2222-3333-444444444444',
      }),
      source: 'hardware',
    });
  });

  it('degrades silently when hardware ID is unavailable or anchor path is unwritable', () => {
    const tempDir = makeTempDir('lody-anchor-ro-');
    const blockingFile = path.join(tempDir, 'not-a-dir');
    fs.writeFileSync(blockingFile, 'x');

    expect(
      syncMachineIdentityAnchor('machine-1', {
        platform: 'darwin',
        homeDir: tempDir,
        env: { XDG_STATE_HOME: blockingFile },
        namespace: 'lody',
        runCommand: () => '"IOPlatformUUID" = "AAAAAAAA-1111-2222-3333-444444444444"',
      })
    ).toBe(false);

    expect(
      recoverMachineIdFromAnchorOrHardware({
        platform: 'darwin',
        homeDir: tempDir,
        env: {},
        namespace: 'lody',
        runCommand: () => null,
      })
    ).toBeNull();
  });
});
