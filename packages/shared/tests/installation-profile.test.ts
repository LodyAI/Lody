import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInstallationProfile, getLodyDataDir } from '../src/node/installation-profile';
import { getE2eHostPipe, getLocalCliHostEndpoint } from '../src/node/local-cli-host-lease';
import {
  getLocalControlSocketPath,
  getLocalDaemonRunDir,
  getLocalLoroDataPlaneSocketPath,
} from '../src/node/local-ipc';
import { getLocalTerminalSocketPath } from '../src/node/local-terminal';
import { getLocalWorkspaceCatalogPath } from '../src/node/local-workspace-catalog';

const require = createRequire(import.meta.url);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('installation profile', () => {
  it('keeps cloud defaults backward compatible and gives local a disjoint namespace', () => {
    expect(getInstallationProfile('cloud')).toMatchObject({
      namespace: 'lody',
      dataDirectoryName: '.lody',
      desktopProtocol: 'lody',
      localCliHostPort: 17_788,
    });
    expect(getInstallationProfile('local')).toMatchObject({
      namespace: 'lody-oss',
      dataDirectoryName: '.lody-oss',
      desktopProtocol: 'lody-oss',
      localCliHostPort: 17_789,
    });
    expect(getLodyDataDir('cloud', '/home/alice')).toBe(path.join('/home/alice', '.lody'));
    expect(getLodyDataDir('local', '/home/alice')).toBe(path.join('/home/alice', '.lody-oss'));
  });

  it('uses disjoint local host lease endpoints', () => {
    const cloud = getLocalCliHostEndpoint('cloud');
    const local = getLocalCliHostEndpoint('local');
    expect(local).not.toEqual(cloud);
    if (process.platform === 'win32') {
      expect(cloud).toMatchObject({ kind: 'pipe' });
      expect(local).toMatchObject({ kind: 'pipe' });
    } else {
      expect(cloud).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 17_788 });
      expect(local).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 17_789 });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'uses an isolated host port only for an explicit E2E process',
    () => {
      vi.stubEnv('LODY_E2E', '1');
      vi.stubEnv('LODY_E2E_LOCAL_CLI_HOST_PORT', '29471');

      expect(getLocalCliHostEndpoint('local')).toEqual({
        kind: 'tcp',
        host: '127.0.0.1',
        port: 29_471,
      });

      vi.stubEnv('LODY_E2E', '0');
      expect(getLocalCliHostEndpoint('local')).toEqual({
        kind: 'tcp',
        host: '127.0.0.1',
        port: 17_789,
      });
    }
  );

  it('accepts only an explicit E2E-scoped Windows pipe', () => {
    vi.stubEnv('LODY_E2E', '1');
    vi.stubEnv('LODY_E2E_LOCAL_CLI_HOST_PIPE', '\\\\.\\pipe\\lody-e2e-round-123');
    expect(getE2eHostPipe('win32')).toBe('\\\\.\\pipe\\lody-e2e-round-123');
    expect(getE2eHostPipe('darwin')).toBeNull();

    vi.stubEnv('LODY_E2E_LOCAL_CLI_HOST_PIPE', '\\\\.\\pipe\\lody-agent-host-user');
    expect(() => getE2eHostPipe('win32')).toThrow(
      'LODY_E2E_LOCAL_CLI_HOST_PIPE must use the \\\\.\\pipe\\lody-e2e-<id> namespace'
    );
  });

  it('keeps Electron main-process paths isolated without ambient LODY_PLATFORM', () => {
    const previousPlatform = process.env.LODY_PLATFORM;
    const previousDataDir = process.env.LODY_DATA_DIR;
    delete process.env.LODY_PLATFORM;
    delete process.env.LODY_DATA_DIR;
    try {
      const cloudRunDir = getLocalDaemonRunDir('cloud');
      const localRunDir = getLocalDaemonRunDir('local');
      expect(localRunDir).not.toBe(cloudRunDir);
      expect(localRunDir).toContain('.lody-oss');
      expect(getLocalWorkspaceCatalogPath('local')).toContain('.lody-oss');
      expect(getLocalControlSocketPath('local')).toContain('lody-oss-control');
      expect(getLocalLoroDataPlaneSocketPath('local')).toContain('lody-oss-loro-data-plane');
      expect(getLocalTerminalSocketPath('local')).toContain('lody-oss-terminal');
    } finally {
      if (previousPlatform === undefined) delete process.env.LODY_PLATFORM;
      else process.env.LODY_PLATFORM = previousPlatform;
      if (previousDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = previousDataDir;
    }
  });
});
