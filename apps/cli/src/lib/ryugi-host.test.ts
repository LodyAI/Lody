import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getLodyRyugiHostsConfigPath,
  LODY_DISABLE_RYUGI_HOST_ENV,
  prepareRyugiHostsConfigSync,
  resolveRyugiDeliveryCommand,
  RYUGI_DEFAULT_TIMEOUT_MS,
  RYUGI_HOSTS_CONFIG_ENV,
} from './ryugi-host';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ryugi-host', () => {
  it('writes a Lody-owned hosts.json and carries over non-conflicting user hosts read-only', () => {
    const root = makeTempDir('lody-ryugi-host-');
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    const userConfigPath = path.join(homeDir, '.config', 'ryugi', 'config.json');
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    const originalUserConfig = `${JSON.stringify(
      {
        theme: 'dark',
        hosts: {
          other: {
            env: 'OTHER_TOOL_SESSION',
            agent: 'OtherTool',
            command: ['/usr/local/bin/other-deliver'],
            timeoutMs: 8000,
          },
        },
      },
      null,
      2
    )}\n`;
    fs.writeFileSync(userConfigPath, originalUserConfig, 'utf8');

    const resultPath = prepareRyugiHostsConfigSync(
      { LODY_SESSION_ID: 'session-abc-123' },
      {
        platform: 'darwin',
        dataDir,
        homeDir,
        command: ['/opt/lody/bin/lody', 'session', 'inbox', 'deliver', '--source', 'ryugi'],
        hostProcessEnv: {},
      }
    );

    expect(resultPath).toBe(getLodyRyugiHostsConfigPath(dataDir));
    expect(fs.readFileSync(userConfigPath, 'utf8')).toBe(originalUserConfig);

    const written = JSON.parse(fs.readFileSync(resultPath!, 'utf8')) as {
      theme: string;
      hosts: Record<string, unknown>;
    };
    expect(written.theme).toBe('dark');
    expect(written.hosts.other).toEqual({
      env: 'OTHER_TOOL_SESSION',
      agent: 'OtherTool',
      command: ['/usr/local/bin/other-deliver'],
      timeoutMs: 8000,
    });
    expect(written.hosts.lody).toEqual({
      env: 'LODY_SESSION_ID',
      agent: 'Lody',
      command: ['/opt/lody/bin/lody', 'session', 'inbox', 'deliver', '--source', 'ryugi'],
      timeoutMs: RYUGI_DEFAULT_TIMEOUT_MS,
    });
  });

  it('skips injection when a user host already matches a variable set in the session env', () => {
    const root = makeTempDir('lody-ryugi-conflict-');
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    const userConfigPath = path.join(homeDir, '.config', 'ryugi', 'config.json');
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        hosts: {
          custom: {
            env: 'LODY_SESSION_ID',
            command: ['/usr/local/bin/my-custom-deliver'],
          },
        },
      }),
      'utf8'
    );

    const resultPath = prepareRyugiHostsConfigSync(
      { LODY_SESSION_ID: 'session-123' },
      {
        platform: 'linux',
        dataDir,
        homeDir,
        command: ['/opt/lody/bin/lody', 'session', 'inbox', 'deliver', '--source', 'ryugi'],
        hostProcessEnv: {},
      }
    );

    expect(resultPath).toBeUndefined();
    expect(fs.existsSync(getLodyRyugiHostsConfigPath(dataDir))).toBe(false);
  });

  it('skips injection when a user host matches another env var already present in the session env', () => {
    const root = makeTempDir('lody-ryugi-other-conflict-');
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    const userConfigPath = path.join(homeDir, '.config', 'ryugi', 'config.json');
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        hosts: {
          mux: {
            env: 'MUX_SESSION_ID',
            command: ['/usr/local/bin/mux-deliver'],
          },
        },
      }),
      'utf8'
    );

    const resultPath = prepareRyugiHostsConfigSync(
      { LODY_SESSION_ID: 'session-123', MUX_SESSION_ID: 'mux-42' },
      {
        platform: 'darwin',
        dataDir,
        homeDir,
        command: ['/opt/lody/bin/lody', 'session', 'inbox', 'deliver', '--source', 'ryugi'],
        hostProcessEnv: {},
      }
    );

    expect(resultPath).toBeUndefined();
  });

  it('skips injection when user already defines a lody custom host', () => {
    const root = makeTempDir('lody-ryugi-own-lody-');
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    const userConfigPath = path.join(homeDir, '.config', 'ryugi', 'config.json');
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(
      userConfigPath,
      JSON.stringify({
        hosts: {
          lody: {
            env: 'USER_LODY_SESSION',
            command: ['/usr/local/bin/user-lody'],
          },
        },
      }),
      'utf8'
    );

    const resultPath = prepareRyugiHostsConfigSync(
      { LODY_SESSION_ID: 'session-123' },
      {
        platform: 'darwin',
        dataDir,
        homeDir,
        command: ['/opt/lody/bin/lody', 'session', 'inbox', 'deliver', '--source', 'ryugi'],
        hostProcessEnv: {},
      }
    );

    expect(resultPath).toBeUndefined();
  });

  it('does not mistake Lody managed hosts.json in RYUGI_HOSTS_CONFIG for a user conflict', () => {
    const root = makeTempDir('lody-ryugi-nested-');
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    const managedPath = getLodyRyugiHostsConfigPath(dataDir);
    const opts = {
      platform: 'darwin' as const,
      dataDir,
      homeDir,
      command: ['/opt/lody/bin/lody', 'session', 'inbox', 'deliver', '--source', 'ryugi'],
      hostProcessEnv: {},
    };

    const first = prepareRyugiHostsConfigSync({ LODY_SESSION_ID: 'session-1' }, opts);
    expect(first).toBe(managedPath);

    const second = prepareRyugiHostsConfigSync(
      { LODY_SESSION_ID: 'session-2', [RYUGI_HOSTS_CONFIG_ENV]: managedPath },
      opts
    );
    expect(second).toBe(managedPath);
  });

  it('skips injection on Windows and when disabled via LODY_DISABLE_RYUGI_HOST', () => {
    const root = makeTempDir('lody-ryugi-disabled-');
    const dataDir = path.join(root, 'data');
    const homeDir = path.join(root, 'home');
    const command = ['/opt/lody/bin/lody', 'session', 'inbox', 'deliver', '--source', 'ryugi'];

    expect(
      prepareRyugiHostsConfigSync(
        { LODY_SESSION_ID: 'session-1' },
        { platform: 'win32', dataDir, homeDir, command, hostProcessEnv: {} }
      )
    ).toBeUndefined();

    expect(
      prepareRyugiHostsConfigSync(
        { LODY_SESSION_ID: 'session-1', [LODY_DISABLE_RYUGI_HOST_ENV]: '1' },
        { platform: 'darwin', dataDir, homeDir, command, hostProcessEnv: {} }
      )
    ).toBeUndefined();
  });

  it('resolves delivery commands for Node, Electron-embedded, and SEA runtimes', () => {
    const socketPath = '/tmp/lody-test/run/control.sock';
    expect(
      resolveRyugiDeliveryCommand({
        execPath: '/usr/local/bin/node',
        cliEntry: '/opt/lody/dist/index.js',
        socketPath,
        electronRunAsNode: false,
        seaContext: null,
      })
    ).toEqual([
      '/usr/local/bin/node',
      '/opt/lody/dist/index.js',
      'session',
      'inbox',
      'deliver',
      '--source',
      'ryugi',
      '--socket',
      socketPath,
    ]);

    expect(
      resolveRyugiDeliveryCommand({
        execPath:
          '/Applications/Lody.app/Contents/Frameworks/Lody Helper.app/Contents/MacOS/Lody Helper',
        cliEntry: '/Applications/Lody.app/Contents/Resources/cli/index.js',
        socketPath,
        electronRunAsNode: true,
        seaContext: null,
      })
    ).toEqual([
      '/usr/bin/env',
      'ELECTRON_RUN_AS_NODE=1',
      '/Applications/Lody.app/Contents/Frameworks/Lody Helper.app/Contents/MacOS/Lody Helper',
      '/Applications/Lody.app/Contents/Resources/cli/index.js',
      'session',
      'inbox',
      'deliver',
      '--source',
      'ryugi',
      '--socket',
      socketPath,
    ]);

    const seaRoot = makeTempDir('lody-ryugi-sea-');
    const capsulePath = path.join(seaRoot, 'lody');
    fs.writeFileSync(capsulePath, '', 'utf8');
    expect(
      resolveRyugiDeliveryCommand({
        socketPath,
        publishedManagedService: null,
        seaContext: {
          capsulePath,
          nodePath: path.join(seaRoot, 'node'),
          releaseDir: path.join(seaRoot, 'release'),
          metadata: {
            format: 1,
            product: 'lody-oss',
            distribution: 'lody-oss',
            version: '1.0.0',
            channel: 'stable',
            platform: 'darwin-arm64',
            serviceProtocol: 1,
            payloadSha256: 'a'.repeat(64),
            node: { sha256: 'b'.repeat(64), size: 1, version: '26.13.0' },
          },
        },
      })
    ).toEqual([
      capsulePath,
      'session',
      'inbox',
      'deliver',
      '--source',
      'ryugi',
      '--socket',
      socketPath,
    ]);
  });
});
