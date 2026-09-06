import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpTimeoutError } from './agent-client';
import {
  COLD_NPX_INIT_TIMEOUT_MS,
  runNpxStartupWithRecovery,
  type NpxStartupAttemptInput,
} from './acp-npx-startup-policy';
import {
  extractNpxCacheDirsFromText,
  findNpxCacheDirsForPackage,
  getConfiguredNpmCacheDir,
  getConfiguredNpxCacheRoot,
  getNpxCacheRoots,
  getLodyNpmCacheDir,
  inspectNpxInstallState,
  isLodyNpmCacheDir,
  isNpxCommand,
  isLikelyBrokenNpxInstall,
  isLikelyNpmCacheCorruption,
  type NpxCacheIo,
  parseNpxPackageSpec,
  parseNpxPackageSpecFromArgs,
  purgeBrokenNpxCache,
  purgeBrokenNpxInstall,
  purgeLodyNpmCache,
  withLodyNpmCacheForNpx,
} from './npx-cache';

const originalPlatform = process.env.LODY_PLATFORM;
const originalDataDir = process.env.LODY_DATA_DIR;

beforeEach(() => {
  process.env.LODY_PLATFORM = 'local';
  delete process.env.LODY_DATA_DIR;
});

afterEach(() => {
  if (originalPlatform === undefined) delete process.env.LODY_PLATFORM;
  else process.env.LODY_PLATFORM = originalPlatform;
  if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
  else process.env.LODY_DATA_DIR = originalDataDir;
});

function makeIo(setup: {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  rmThrows?: string[];
}): NpxCacheIo & { removed: string[] } {
  const files = new Map(Object.entries(setup.files ?? {}));
  const dirs = new Map(
    Object.entries(setup.dirs ?? {}).map(([key, value]) => [key, new Set(value)])
  );
  const rmThrows = new Set(setup.rmThrows ?? []);
  const removed: string[] = [];
  return {
    removed,
    existsSync: (path) => files.has(path) || dirs.has(path),
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    readdirSync: (path) => {
      const entries = dirs.get(path);
      if (!entries) {
        throw new Error(`ENOTDIR: ${path}`);
      }
      return [...entries];
    },
    rmSync: (path) => {
      if (rmThrows.has(path)) {
        throw new Error(`EPERM: ${path}`);
      }
      removed.push(path);
      for (const file of [...files.keys()]) {
        if (file === path || file.startsWith(`${path}/`)) {
          files.delete(file);
        }
      }
      for (const dir of [...dirs.keys()]) {
        if (dir === path || dir.startsWith(`${path}/`)) {
          dirs.delete(dir);
        }
      }
      dirs.get(dirname(path))?.delete(basename(path));
    },
  };
}

const logger = {
  debug: () => {},
  warn: () => {},
};

function npxArgs(spec = 'acp-extension-claude@0.50.0'): string[] {
  return ['--prefer-offline', '-y', spec];
}

function healthyInstall(root: string, hash: string, pkg: string, version: string) {
  const hashDir = join(root, hash);
  const packageDir = join(hashDir, 'node_modules', pkg);
  const binPath = join(packageDir, 'dist/index.js');
  return {
    dirs: { [root]: [hash], [hashDir]: [] },
    files: {
      [join(hashDir, 'package.json')]: JSON.stringify({
        dependencies: { [pkg]: `^${version}` },
        _npx: { packages: [`${pkg}@${version}`] },
      }),
      [join(packageDir, 'package.json')]: JSON.stringify({
        name: pkg,
        version,
        bin: { [pkg]: 'dist/index.js' },
      }),
      [binPath]: '',
    },
  };
}

describe('parseNpxPackageSpec', () => {
  it('parses a plain name@version', () => {
    expect(parseNpxPackageSpec('acp-extension-codex-darwin-arm64@0.15.0')).toEqual({
      name: 'acp-extension-codex-darwin-arm64',
      version: '0.15.0',
    });
  });

  it('parses a scoped @scope/pkg@version', () => {
    expect(parseNpxPackageSpec('@scope/pkg@1.2.3')).toEqual({
      name: '@scope/pkg',
      version: '1.2.3',
    });
  });

  it('returns undefined when there is no version separator', () => {
    expect(parseNpxPackageSpec('acp-extension-codex')).toBeUndefined();
    expect(parseNpxPackageSpec('@scope/pkg')).toBeUndefined();
    expect(parseNpxPackageSpec('')).toBeUndefined();
    expect(parseNpxPackageSpec(undefined)).toBeUndefined();
  });
});

describe('parseNpxPackageSpecFromArgs', () => {
  it('reads the spec immediately after -y, ignoring trailing agent args', () => {
    const args = [
      '--registry=https://registry.npmjs.org/',
      '--prefer-online',
      '-y',
      'acp-extension-codex-darwin-arm64@0.15.0',
      '-c',
      'features.goals=true',
    ];
    expect(parseNpxPackageSpecFromArgs(args)).toEqual({
      name: 'acp-extension-codex-darwin-arm64',
      version: '0.15.0',
    });
  });

  it('supports --yes and returns undefined when absent', () => {
    expect(parseNpxPackageSpecFromArgs(['--yes', 'acp-extension-claude@0.39.0'])).toEqual({
      name: 'acp-extension-claude',
      version: '0.39.0',
    });
    expect(parseNpxPackageSpecFromArgs(['--prefer-online', 'pkg@1.0.0'])).toBeUndefined();
  });

  it('reads the first package selector from a composed npx launch', () => {
    expect(
      parseNpxPackageSpecFromArgs([
        '--prefer-offline',
        '-y',
        '--package',
        '@deepseek-ai/dsh-acp-demo@0.1.0-rc.6',
        '--package=@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.6',
        'dsh-acp-demo',
      ])
    ).toEqual({
      name: '@deepseek-ai/dsh-acp-demo',
      version: '0.1.0-rc.6',
    });
  });
});

describe('isLikelyBrokenNpxInstall', () => {
  it('matches module-resolution / missing-binary signatures', () => {
    expect(
      isLikelyBrokenNpxInstall(
        "Cannot find package 'acp-extension-codex-darwin-arm64' imported from /x/_npx/abc/y.js"
      )
    ).toBe(true);
    expect(isLikelyBrokenNpxInstall('Error [ERR_MODULE_NOT_FOUND]: ...')).toBe(true);
    expect(
      isLikelyBrokenNpxInstall('Failed to locate acp-extension-codex-darwin-arm64 binary.')
    ).toBe(true);
    expect(
      isLikelyBrokenNpxInstall(
        'reasonix: no prebuilt binary for linux-x64. Install the matching optional package (@reasonix/cli-linux-x64).'
      )
    ).toBe(true);
    expect(isLikelyBrokenNpxInstall('npm error could not determine executable to run')).toBe(true);
  });

  it('matches ESM subpath/dir resolution failures (e.g. the claude zod/v4 case)', () => {
    expect(
      isLikelyBrokenNpxInstall(
        "Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import '/Users/f/.npm/_npx/495e3ff36615a20b/node_modules/zod/v4' " +
          'is not supported resolving ES modules imported from ' +
          '/Users/f/.npm/_npx/495e3ff36615a20b/node_modules/@agentclientprotocol/sdk/dist/acp.js'
      )
    ).toBe(true);
    expect(isLikelyBrokenNpxInstall('ERR_PACKAGE_PATH_NOT_EXPORTED')).toBe(true);
    expect(isLikelyBrokenNpxInstall('ERR_INVALID_PACKAGE_TARGET')).toBe(true);
  });

  it('matches npm exec ENOENT for a missing _npx root package.json', () => {
    expect(
      isLikelyBrokenNpxInstall(
        "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/Users/u/.lody/npm-cache/_npx/9b260da1c9d6d698/package.json'"
      )
    ).toBe(true);
  });

  it('does not match legitimate agent runtime errors', () => {
    expect(isLikelyBrokenNpxInstall('401 Unauthorized: please log in to Codex')).toBe(false);
    expect(isLikelyBrokenNpxInstall('model overloaded, try again')).toBe(false);
    expect(isLikelyBrokenNpxInstall(null)).toBe(false);
    expect(isLikelyBrokenNpxInstall(undefined)).toBe(false);
  });
});

describe('inspectNpxInstallState', () => {
  const root = '/home/u/.npm/_npx';
  const hashDir = join(root, 'aa11');
  const pkg = 'acp-extension-claude';
  const version = '0.50.0';
  const rootPackageJson = join(hashDir, 'package.json');
  const packageDir = join(hashDir, 'node_modules', pkg);
  const packageJson = join(packageDir, 'package.json');
  const binPath = join(packageDir, 'dist/index.js');

  const healthyFiles = {
    [rootPackageJson]: JSON.stringify({
      dependencies: { [pkg]: '^0.50.0' },
      _npx: { packages: [`${pkg}@${version}`] },
    }),
    [packageJson]: JSON.stringify({
      name: pkg,
      version,
      bin: { [pkg]: 'dist/index.js' },
    }),
    [binPath]: '',
  };

  it('returns ready only when root package, package metadata, and bin target are present', () => {
    const io = makeIo({
      dirs: { [root]: ['aa11'], [hashDir]: [] },
      files: healthyFiles,
    });

    const state = inspectNpxInstallState(pkg, version, { io, roots: [root] });

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.dirs).toEqual([hashDir]);
    }
  });

  it('returns missing when no candidate install exists', () => {
    const io = makeIo({ dirs: { [root]: ['other'] } });

    expect(inspectNpxInstallState(pkg, version, { io, roots: [root] }).kind).toBe('missing');
  });

  it('skips same-package installs for other versions', () => {
    const io = makeIo({
      dirs: { [root]: ['aa11'], [hashDir]: [] },
      files: {
        [rootPackageJson]: JSON.stringify({
          dependencies: { [pkg]: '^0.49.0' },
          _npx: { packages: [`${pkg}@0.49.0`] },
        }),
        [packageJson]: JSON.stringify({
          name: pkg,
          version: '0.49.0',
          bin: { [pkg]: 'dist/index.js' },
        }),
        [binPath]: '',
      },
    });

    expect(inspectNpxInstallState(pkg, version, { io, roots: [root] }).kind).toBe('missing');
  });

  it('skips older same-package installs even when their root package is missing', () => {
    const io = makeIo({
      dirs: { [root]: ['aa11'], [hashDir]: [] },
      files: {
        [packageJson]: JSON.stringify({
          name: pkg,
          version: '0.49.0',
          bin: { [pkg]: 'dist/index.js' },
        }),
        [binPath]: '',
      },
    });

    expect(inspectNpxInstallState(pkg, version, { io, roots: [root] }).kind).toBe('missing');
  });

  it('returns branded broken when npm left node_modules without the root package.json', () => {
    const io = makeIo({
      dirs: { [root]: ['aa11'], [hashDir]: [] },
      files: {
        [packageJson]: JSON.stringify({
          name: pkg,
          version,
          bin: { [pkg]: 'dist/index.js' },
        }),
        [binPath]: '',
      },
    });

    const state = inspectNpxInstallState(pkg, version, { io, roots: [root] });

    expect(state.kind).toBe('broken');
    if (state.kind === 'broken') {
      expect(state.dirs).toEqual([hashDir]);
      expect(state.problems.map((problem) => problem.reason)).toContain(
        'root-package-json-missing'
      );
      expect(purgeBrokenNpxInstall(state, { io, allowedRoots: [root] })).toEqual([hashDir]);
    }
  });

  it('returns broken when the package bin target is missing', () => {
    const io = makeIo({
      dirs: { [root]: ['aa11'], [hashDir]: [] },
      files: {
        [rootPackageJson]: healthyFiles[rootPackageJson],
        [packageJson]: healthyFiles[packageJson],
      },
    });

    const state = inspectNpxInstallState(pkg, version, { io, roots: [root] });

    expect(state.kind).toBe('broken');
    if (state.kind === 'broken') {
      expect(state.problems.map((problem) => problem.reason)).toContain(
        'package-bin-target-missing'
      );
    }
  });
});

describe('runNpxStartupWithRecovery', () => {
  it.each(['cleanup failed', 'cancelled'])(
    'preserves nonretryable %s without reading stale stderr or retrying',
    async (message) => {
      const failure = new Error(message);
      const attempt = vi.fn(async () => {
        throw failure;
      });
      const stderr = vi.fn(() => 'Cannot find module');
      const cleanup = vi.fn();
      await expect(
        runNpxStartupWithRecovery({
          command: 'npx',
          args: npxArgs(),
          env: { npm_config_cache: '/cache' },
          logger,
          logPrefix: '[test]',
          npxCacheIo: makeIo({}),
          npxCacheRoots: ['/cache/_npx'],
          attempt,
          getStderrTail: stderr,
          cleanupFailedAttempt: cleanup,
          shouldRetryError: () => false,
        })
      ).rejects.toBe(failure);
      expect(attempt).toHaveBeenCalledOnce();
      expect(stderr).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    }
  );

  it('uses the cold npx init timeout when the install is missing', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const io = makeIo({});

    await runNpxStartupWithRecovery({
      command: 'npx',
      args: npxArgs(),
      env: { npm_config_cache: '/cache' },
      logger,
      logPrefix: '[test]',
      npxCacheIo: io,
      npxCacheRoots: ['/cache/_npx'],
      getStderrTail: () => '',
      attempt: async (input) => {
        attempts.push(input);
        return 'ok';
      },
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.startupTimeouts?.initTimeoutMs).toBe(COLD_NPX_INIT_TIMEOUT_MS);
  });

  it('does not override init timeout when the install is ready', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const root = '/cache/_npx';
    const io = makeIo(healthyInstall(root, 'aa11', 'acp-extension-claude', '0.50.0'));

    await runNpxStartupWithRecovery({
      command: 'npx',
      args: npxArgs(),
      env: { npm_config_cache: '/cache' },
      logger,
      logPrefix: '[test]',
      npxCacheIo: io,
      npxCacheRoots: [root],
      getStderrTail: () => '',
      attempt: async (input) => {
        attempts.push(input);
        return 'ok';
      },
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.startupTimeouts).toBeUndefined();
  });

  it('purges a preflight broken install before starting with cold timeout', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const root = '/cache/_npx';
    const hashDir = join(root, 'aa11');
    const pkg = 'acp-extension-claude';
    const packageDir = join(hashDir, 'node_modules', pkg);
    const io = makeIo({
      dirs: { [root]: ['aa11'], [hashDir]: [] },
      files: {
        [join(packageDir, 'package.json')]: JSON.stringify({
          name: pkg,
          version: '0.50.0',
          bin: { [pkg]: 'dist/index.js' },
        }),
        [join(packageDir, 'dist/index.js')]: '',
      },
    });

    await runNpxStartupWithRecovery({
      command: 'npx',
      args: npxArgs(),
      env: { npm_config_cache: '/cache' },
      logger,
      logPrefix: '[test]',
      npxCacheIo: io,
      npxCacheRoots: [root],
      getStderrTail: () => '',
      attempt: async (input) => {
        attempts.push(input);
        return 'ok';
      },
    });

    expect(io.removed).toEqual([hashDir]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.startupTimeouts?.initTimeoutMs).toBe(COLD_NPX_INIT_TIMEOUT_MS);
  });

  it('does not purge the default user npx cache without a configured cache root', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const root = join(homedir(), '.npm', '_npx');
    const hashDir = join(root, 'aa11');
    const pkg = 'acp-extension-claude';
    const packageDir = join(hashDir, 'node_modules', pkg);
    const io = makeIo({
      dirs: { [root]: ['aa11'], [hashDir]: [] },
      files: {
        [join(packageDir, 'package.json')]: JSON.stringify({
          name: pkg,
          version: '0.50.0',
          bin: { [pkg]: 'dist/index.js' },
        }),
        [join(packageDir, 'dist/index.js')]: '',
      },
    });

    await runNpxStartupWithRecovery({
      command: 'npx',
      args: npxArgs(),
      env: {},
      logger,
      logPrefix: '[test]',
      npxCacheIo: io,
      getStderrTail: () => '',
      attempt: async (input) => {
        attempts.push(input);
        return 'ok';
      },
    });

    expect(io.removed).toEqual([]);
    expect(attempts[0]?.startupTimeouts?.initTimeoutMs).toBe(COLD_NPX_INIT_TIMEOUT_MS);
  });

  it('purges Lody npm cache and retries after a cold connection.initialize timeout', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const cache = getLodyNpmCacheDir();
    const npxRoot = join(cache, '_npx');
    const cacache = join(cache, '_cacache');
    const io = makeIo({ dirs: { [npxRoot]: [], [cacache]: [] } });

    const result = await runNpxStartupWithRecovery({
      command: 'npx',
      args: npxArgs(),
      env: { npm_config_cache: cache },
      logger,
      logPrefix: '[test]',
      npxCacheIo: io,
      npxCacheRoots: [npxRoot],
      getStderrTail: () => '',
      attempt: async (input) => {
        attempts.push(input);
        if (attempts.length === 1) {
          throw new AcpTimeoutError('connection.initialize', COLD_NPX_INIT_TIMEOUT_MS, 'session-1');
        }
        return 'ok';
      },
    });

    expect(result).toBe('ok');
    expect(attempts).toHaveLength(2);
    expect(new Set(io.removed)).toEqual(new Set([npxRoot, cacache]));
  });

  it('refreshes stale npm metadata online once for a missing exact version', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const io = makeIo({});
    let stderrTail = '';

    const result = await runNpxStartupWithRecovery({
      command: 'npx',
      args: npxArgs('@xai-official/grok@0.2.112'),
      env: { npm_config_cache: '/cache' },
      logger,
      logPrefix: '[test]',
      npxCacheIo: io,
      npxCacheRoots: ['/cache/_npx'],
      getStderrTail: () => stderrTail,
      attempt: async (input) => {
        attempts.push(input);
        if (attempts.length === 1) {
          stderrTail =
            'npm error code ETARGET\n' +
            'npm error notarget No matching version found for @xai-official/grok@0.2.112.';
          throw new Error('ACP connection closed');
        }
        return 'ok';
      },
    });

    expect(result).toBe('ok');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.args).toEqual(['--prefer-offline', '-y', '@xai-official/grok@0.2.112']);
    expect(attempts[1]?.args).toEqual(['--prefer-online', '-y', '@xai-official/grok@0.2.112']);
    expect(io.removed).toEqual([]);
  });

  it('does not refresh npm metadata for a dist-tag', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const io = makeIo({});

    await expect(
      runNpxStartupWithRecovery({
        command: 'npx',
        args: npxArgs('@xai-official/grok@latest'),
        env: { npm_config_cache: '/cache' },
        logger,
        logPrefix: '[test]',
        npxCacheIo: io,
        npxCacheRoots: ['/cache/_npx'],
        getStderrTail: () =>
          'npm error code ETARGET\nnpm error notarget No matching version found.',
        attempt: async (input) => {
          attempts.push(input);
          throw new Error('ACP connection closed');
        },
      })
    ).rejects.toThrow('ACP connection closed');

    expect(attempts).toHaveLength(1);
  });

  it('stops after one online metadata refresh when the exact version is still missing', async () => {
    const attempts: NpxStartupAttemptInput[] = [];
    const io = makeIo({});

    await expect(
      runNpxStartupWithRecovery({
        command: 'npx',
        args: npxArgs('@xai-official/grok@0.2.112'),
        env: { npm_config_cache: '/cache' },
        logger,
        logPrefix: '[test]',
        npxCacheIo: io,
        npxCacheRoots: ['/cache/_npx'],
        getStderrTail: () =>
          'npm error code E404\nnpm error 404 No match found for version 0.2.112',
        attempt: async (input) => {
          attempts.push(input);
          throw new Error('ACP connection closed');
        },
      })
    ).rejects.toThrow('ACP connection closed');

    expect(attempts.map((attempt) => attempt.args[0])).toEqual([
      '--prefer-offline',
      '--prefer-online',
    ]);
  });

  it('does not purge cache for a ready install initialize timeout', async () => {
    const root = '/cache/_npx';
    const io = makeIo(healthyInstall(root, 'aa11', 'acp-extension-claude', '0.50.0'));

    await expect(
      runNpxStartupWithRecovery({
        command: 'npx',
        args: npxArgs(),
        env: { npm_config_cache: '/cache' },
        logger,
        logPrefix: '[test]',
        npxCacheIo: io,
        npxCacheRoots: [root],
        getStderrTail: () => '',
        attempt: async () => {
          throw new AcpTimeoutError('connection.initialize', 120_000, 'session-1');
        },
      })
    ).rejects.toThrow('[ACP_TIMEOUT]');

    expect(io.removed).toEqual([]);
  });

  it('runs non-npx commands once without cache policy', async () => {
    const attempts: NpxStartupAttemptInput[] = [];

    await runNpxStartupWithRecovery({
      command: 'node',
      args: ['agent.js'],
      env: {},
      logger,
      logPrefix: '[test]',
      getStderrTail: () => '',
      attempt: async (input) => {
        attempts.push(input);
        return 'ok';
      },
    });

    expect(attempts).toEqual([{ attempt: 1, args: ['agent.js'], startupTimeouts: undefined }]);
  });
});

describe('isNpxCommand', () => {
  it('matches bare npx, absolute paths, and Windows shims', () => {
    expect(isNpxCommand('npx')).toBe(true);
    expect(isNpxCommand('/opt/homebrew/bin/npx')).toBe(true);
    expect(isNpxCommand('C:\\Program Files\\nodejs\\npx.cmd')).toBe(true);
    expect(isNpxCommand('C:\\Program Files\\nodejs\\npx.exe')).toBe(true);
  });

  it('does not match other launchers', () => {
    expect(isNpxCommand('node')).toBe(false);
    expect(isNpxCommand('/usr/local/bin/pnpm')).toBe(false);
    expect(isNpxCommand('custom-npx-wrapper')).toBe(false);
  });
});

describe('withLodyNpmCacheForNpx', () => {
  it('isolates npx-launched ACP agents onto the Lody npm cache', () => {
    const env = {
      PATH: '/usr/bin',
      npm_config_cache: '/Users/u/.npm',
      NPM_CONFIG_CACHE: '/Users/u/.npm-uppercase',
    };
    const next = withLodyNpmCacheForNpx('npx', env, { home: '/Users/u' });
    const expectedCache = getLodyNpmCacheDir('/Users/u');

    expect(next).toEqual({
      PATH: '/usr/bin',
      npm_config_cache: expectedCache,
      NPM_CONFIG_CACHE: expectedCache,
    });
    expect(env.npm_config_cache).toBe('/Users/u/.npm');
  });

  it('leaves non-npx agents untouched', () => {
    const env = { PATH: '/usr/bin', npm_config_cache: '/Users/u/.npm' };
    expect(withLodyNpmCacheForNpx('node', env, { home: '/Users/u' })).toBe(env);
  });
});

describe('npm cache isolation helpers', () => {
  it('reads npm_config_cache before NPM_CONFIG_CACHE', () => {
    expect(
      getConfiguredNpmCacheDir({
        npm_config_cache: '/lower',
        NPM_CONFIG_CACHE: '/upper',
      })
    ).toBe('/lower');
    expect(getConfiguredNpmCacheDir({ NPM_CONFIG_CACHE: '/upper' })).toBe('/upper');
    expect(getConfiguredNpmCacheDir({ npm_config_cache: '' })).toBeUndefined();
    expect(getConfiguredNpxCacheRoot({ npm_config_cache: '/lower' })).toBe(join('/lower', '_npx'));
  });

  it('recognizes only the Lody npm cache path', () => {
    expect(isLodyNpmCacheDir('/Users/u/.lody-oss/npm-cache', '/Users/u')).toBe(true);
    expect(isLodyNpmCacheDir('/Users/u/.lody-oss/npm-cache/', '/Users/u')).toBe(true);
    expect(isLodyNpmCacheDir('/Users/u/.lody/npm-cache', '/Users/u')).toBe(false);
    expect(isLodyNpmCacheDir('/Users/u/.npm', '/Users/u')).toBe(false);
    expect(isLodyNpmCacheDir(undefined, '/Users/u')).toBe(false);
  });

  it('recognizes the cloud installation cache only in cloud mode', () => {
    process.env.LODY_PLATFORM = 'cloud';
    expect(isLodyNpmCacheDir('/Users/u/.lody/npm-cache', '/Users/u')).toBe(true);
    expect(isLodyNpmCacheDir('/Users/u/.lody-oss/npm-cache', '/Users/u')).toBe(false);
  });
});

describe('isLikelyNpmCacheCorruption', () => {
  it('matches npm _cacache rename/permission failures from npx startup', () => {
    const text =
      'npm error code EEXIST\n' +
      'npm error syscall rename\n' +
      'npm error path /Users/akira/.npm/_cacache/tmp/2440e4b6\n' +
      "npm error EACCES: permission denied, rename '/Users/akira/.npm/_cacache/tmp/2440e4b6' -> " +
      "'/Users/akira/.npm/_cacache/content-v2/sha512/4f/65/hash'\n" +
      'npm error File exists: /Users/akira/.npm/_cacache/content-v2/sha512/4f/65/hash';

    expect(isLikelyNpmCacheCorruption(text)).toBe(true);
  });

  it('matches integrity and tarball corruption errors', () => {
    expect(isLikelyNpmCacheCorruption('npm ERR! code EINTEGRITY')).toBe(true);
    expect(isLikelyNpmCacheCorruption('npm WARN tarball data seems to be corrupted')).toBe(true);
    expect(isLikelyNpmCacheCorruption('zlib: unexpected end of file')).toBe(true);
  });

  it('recognizes the isolated OSS installation cache path', () => {
    expect(
      isLikelyNpmCacheCorruption(
        'npm ERR! EACCES: permission denied, rename /Users/u/.lody-oss/npm-cache/_cacache/tmp'
      )
    ).toBe(true);
  });

  it('does not match ordinary runtime errors', () => {
    expect(isLikelyNpmCacheCorruption('401 Unauthorized: please log in to Claude')).toBe(false);
    expect(isLikelyNpmCacheCorruption('model overloaded, try again')).toBe(false);
    expect(isLikelyNpmCacheCorruption(null)).toBe(false);
  });
});

describe('extractNpxCacheDirsFromText', () => {
  it('extracts the _npx/<hash> dir from a posix module-resolution error', () => {
    const text =
      "Cannot find package 'acp-extension-codex-darwin-arm64' imported from " +
      '/Users/bytedance/.npm/_npx/4ecc573a5eb0b4f6/node_modules/acp-extension-codex/bin/acp-extension-codex.js';
    expect(extractNpxCacheDirsFromText(text)).toEqual([
      '/Users/bytedance/.npm/_npx/4ecc573a5eb0b4f6',
    ]);
  });

  it('extracts a windows-style _npx path', () => {
    const text =
      "Cannot find module 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abcdef12\\node_modules\\x'";
    expect(extractNpxCacheDirsFromText(text)).toEqual([
      'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abcdef12',
    ]);
  });

  it('dedupes the dir from a zod/v4 ERR_UNSUPPORTED_DIR_IMPORT (path appears twice)', () => {
    const text =
      "Directory import '/Users/f/.npm/_npx/495e3ff36615a20b/node_modules/zod/v4' is not supported " +
      'resolving ES modules imported from ' +
      '/Users/f/.npm/_npx/495e3ff36615a20b/node_modules/@agentclientprotocol/sdk/dist/acp.js';
    expect(extractNpxCacheDirsFromText(text)).toEqual(['/Users/f/.npm/_npx/495e3ff36615a20b']);
  });

  it('dedupes and returns empty for unrelated text', () => {
    const text = '/a/_npx/aa11 and again /a/_npx/aa11';
    expect(extractNpxCacheDirsFromText(text)).toEqual(['/a/_npx/aa11']);
    expect(extractNpxCacheDirsFromText('no cache path here')).toEqual([]);
    expect(extractNpxCacheDirsFromText(null)).toEqual([]);
  });
});

describe('getNpxCacheRoots', () => {
  it('prefers an explicit npm_config_cache and adds the posix default', () => {
    const roots = getNpxCacheRoots({
      env: { npm_config_cache: '/custom/cache' },
      platform: 'linux',
      home: '/home/u',
    });
    expect(roots).toEqual([join('/custom/cache', '_npx'), join('/home/u', '.npm', '_npx')]);
  });

  it('uses the windows default cache location', () => {
    const roots = getNpxCacheRoots({
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      platform: 'win32',
      home: 'C:\\Users\\u',
    });
    expect(roots).toContain(join('C:\\Users\\u\\AppData\\Local', 'npm-cache', '_npx'));
  });
});

describe('findNpxCacheDirsForPackage', () => {
  const root = '/home/u/.npm/_npx';
  const pkg = 'acp-extension-codex-darwin-arm64';
  const pkgJson = (hash: string) => join(root, hash, 'node_modules', pkg, 'package.json');

  it('matches dirs holding the package at the requested version', () => {
    const io = makeIo({
      dirs: { [root]: ['match', 'mismatch'] },
      files: {
        [pkgJson('match')]: JSON.stringify({ version: '0.15.0' }),
        [pkgJson('mismatch')]: JSON.stringify({ version: '0.14.0' }),
      },
    });
    expect(findNpxCacheDirsForPackage(pkg, '0.15.0', { io, roots: [root] })).toEqual([
      join(root, 'match'),
    ]);
  });

  it('treats a corrupt package.json as a broken dir worth purging', () => {
    const io = makeIo({
      dirs: { [root]: ['corrupt'] },
      files: { [pkgJson('corrupt')]: 'not-json{' },
    });
    expect(findNpxCacheDirsForPackage(pkg, '0.15.0', { io, roots: [root] })).toEqual([
      join(root, 'corrupt'),
    ]);
  });

  it('skips a missing root without throwing', () => {
    const io = makeIo({});
    expect(findNpxCacheDirsForPackage(pkg, '0.15.0', { io, roots: ['/nope/_npx'] })).toEqual([]);
  });
});

describe('purgeBrokenNpxCache', () => {
  it('purges dirs from both the error text and the cache scan, deduped', () => {
    const root = '/home/u/.npm/_npx';
    const pkg = 'acp-extension-codex-darwin-arm64';
    const fromText = join(root, 'aa11'); // referenced in stderr AND found by scan
    const fromScan = join(root, 'bb22'); // only found by scan
    const pkgJson = (hash: string) => join(root, hash, 'node_modules', pkg, 'package.json');

    const io = makeIo({
      dirs: { [root]: ['aa11', 'bb22'], [fromText]: [], [fromScan]: [] },
      files: {
        [pkgJson('aa11')]: JSON.stringify({ version: '0.15.0' }),
        [pkgJson('bb22')]: JSON.stringify({ version: '0.15.0' }),
      },
    });

    const purged = purgeBrokenNpxCache({
      packageName: pkg,
      version: '0.15.0',
      hintText: `imported from ${fromText}/node_modules/${pkg}/bin/x.js`,
      io,
      roots: [root],
    });

    expect(new Set(purged)).toEqual(new Set([fromText, fromScan]));
    expect(new Set(io.removed)).toEqual(new Set([fromText, fromScan]));
  });

  it('skips non-existent extracted dirs and is best-effort on rm failures', () => {
    // npx hashes are hex, which is what the extraction regex matches.
    const existing = '/home/u/.npm/_npx/aa11';
    const blocked = '/home/u/.npm/_npx/bb22';
    const missing = '/home/u/.npm/_npx/cc33';
    const io = makeIo({
      dirs: { [existing]: [], [blocked]: [] },
      rmThrows: [blocked],
    });

    const purged = purgeBrokenNpxCache({
      hintText: `${existing} ${blocked} ${missing}`,
      io,
    });

    // `missing` never existed → skipped; `blocked` throws on rm → swallowed; only `existing` removed.
    expect(purged).toEqual([existing]);
    expect(io.removed).toEqual([existing]);
  });

  it('does not purge extracted dirs outside allowed roots', () => {
    const allowedRoot = '/Users/u/.lody/npm-cache/_npx';
    const allowed = join(allowedRoot, 'aa11');
    const blocked = '/Users/u/.npm/_npx/bb22';
    const io = makeIo({
      dirs: { [allowed]: [], [blocked]: [] },
    });

    const purged = purgeBrokenNpxCache({
      hintText: `${allowed} ${blocked}`,
      allowedRoots: [allowedRoot],
      io,
    });

    expect(purged).toEqual([allowed]);
    expect(io.removed).toEqual([allowed]);
  });
});

describe('purgeLodyNpmCache', () => {
  it('purges only Lody-owned _npx and _cacache dirs', () => {
    const cache = '/Users/u/.lody-oss/npm-cache';
    const npx = join(cache, '_npx');
    const cacache = join(cache, '_cacache');
    const userNpm = '/Users/u/.npm';
    const io = makeIo({
      dirs: { [npx]: [], [cacache]: [], [join(userNpm, '_cacache')]: [] },
    });

    const purged = purgeLodyNpmCache({
      env: { npm_config_cache: cache },
      home: '/Users/u',
      io,
    });

    expect(new Set(purged)).toEqual(new Set([npx, cacache]));
    expect(new Set(io.removed)).toEqual(new Set([npx, cacache]));
  });

  it('refuses to purge user npm cache even when env points there', () => {
    const userNpm = '/Users/u/.npm';
    const io = makeIo({
      dirs: { [join(userNpm, '_npx')]: [], [join(userNpm, '_cacache')]: [] },
    });

    expect(
      purgeLodyNpmCache({
        env: { npm_config_cache: userNpm },
        home: '/Users/u',
        io,
      })
    ).toEqual([]);
    expect(io.removed).toEqual([]);
  });

  it('is best-effort when cleanup fails', () => {
    const cache = '/Users/u/.lody-oss/npm-cache';
    const npx = join(cache, '_npx');
    const cacache = join(cache, '_cacache');
    const io = makeIo({
      dirs: { [npx]: [], [cacache]: [] },
      rmThrows: [cacache],
    });

    expect(
      purgeLodyNpmCache({
        env: { NPM_CONFIG_CACHE: cache },
        home: '/Users/u',
        io,
      })
    ).toEqual([npx]);
    expect(io.removed).toEqual([npx]);
  });
});
