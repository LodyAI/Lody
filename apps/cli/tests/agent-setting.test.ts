import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
  ACP_EXTENSION_DSH_QUERY_PATH_ENV,
  ACP_EXTENSION_DSH_SESSION_ROOT_ENV,
} from 'acp-extension-dsh/profile';
import { REGISTRY_ACP_AGENTS } from '@lody/shared';

import {
  getAcpCapabilitySourceVersion,
  mergeLoginShellEnv,
  resolveACPSetting,
  resolveBuiltinAuthenticationProcessLaunch,
  resolveBuiltinACPSetting,
  resolveACPProcessLaunchAsync,
  resolveRegistryAgentACPSetting,
  resolveRegistryNpxPackage,
  withDefaultAcpPathEntries,
} from '../src/agent/setting';
import {
  BUILTIN_CLAUDE_CAPABILITY_SOURCE_VERSION,
  BUILTIN_CODEX_CAPABILITY_SOURCE_VERSION,
  BUILTIN_GROK_CAPABILITY_SOURCE_VERSION,
  BUILTIN_KIMI_CAPABILITY_SOURCE_VERSION,
} from '../src/agent/managed-agent-runtime';
import * as managedRuntime from '../src/agent/managed-agent-runtime';
import { parseNpxPackageSpecFromArgs } from '../src/agent/npx-cache';
import {
  DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION,
  DEEPSEEK_HARNESS_HOME_ENV,
  DEEPSEEK_HARNESS_VERSION,
} from '../src/agent/deepseek-harness-runtime';

function getRegistryAgent(agentType: string) {
  const agent = REGISTRY_ACP_AGENTS.find((candidate) => candidate.id === agentType);
  if (!agent) {
    throw new Error(`Missing registry agent fixture: ${agentType}`);
  }
  return agent;
}

describe('resolveBuiltinACPSetting', () => {
  it('requires the async launcher for managed builtin runtimes', () => {
    expect(() => resolveBuiltinACPSetting('claude')).toThrow(/resolveACPProcessLaunchAsync/);
    expect(() => resolveBuiltinACPSetting('codex')).toThrow(/resolveACPProcessLaunchAsync/);
    expect(() => resolveBuiltinACPSetting('kimi')).toThrow(/resolveACPProcessLaunchAsync/);
    expect(() => resolveBuiltinACPSetting('grok')).toThrow(/resolveACPProcessLaunchAsync/);
  });

  it('keys builtin capability versions on the bundled adapter and managed runtime', () => {
    expect(getAcpCapabilitySourceVersion({ cliType: 'builtin', agentType: 'codex' })).toBe(
      BUILTIN_CODEX_CAPABILITY_SOURCE_VERSION
    );
    expect(getAcpCapabilitySourceVersion({ cliType: 'builtin', agentType: 'claude' })).toBe(
      BUILTIN_CLAUDE_CAPABILITY_SOURCE_VERSION
    );
    expect(getAcpCapabilitySourceVersion({ cliType: 'builtin', agentType: 'kimi' })).toBe(
      BUILTIN_KIMI_CAPABILITY_SOURCE_VERSION
    );
    expect(getAcpCapabilitySourceVersion({ cliType: 'builtin', agentType: 'grok' })).toBe(
      BUILTIN_GROK_CAPABILITY_SOURCE_VERSION
    );
    expect(
      getAcpCapabilitySourceVersion({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/opt/codex' },
      })
    ).toBe(`${BUILTIN_CODEX_CAPABILITY_SOURCE_VERSION}+override:{"codexPath":"/opt/codex"}`);
    expect(getAcpCapabilitySourceVersion({ cliType: 'builtin', agentType: 'deepseek' })).toBe(
      DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION
    );
    const customDeepSeekEndpointVersion = getAcpCapabilitySourceVersion({
      cliType: 'builtin',
      agentType: 'deepseek',
      env: { DEEPSEEK_BASE_URL: 'https://gateway.example/v1' },
    });
    expect(customDeepSeekEndpointVersion).toMatch(
      new RegExp(
        `^${DEEPSEEK_HARNESS_CAPABILITY_SOURCE_VERSION.replaceAll('.', '\\.')}\\+endpoint:[a-f0-9]{12}$`
      )
    );
    expect(customDeepSeekEndpointVersion).not.toBe(
      getAcpCapabilitySourceVersion({
        cliType: 'builtin',
        agentType: 'deepseek',
        env: { DEEPSEEK_BASE_URL: 'https://other.example/v1' },
      })
    );
    expect(customDeepSeekEndpointVersion).not.toBe(
      getAcpCapabilitySourceVersion({
        cliType: 'builtin',
        agentType: 'deepseek',
        env: { DEEPSEEK_BASE_URL: ' https://gateway.example/v1' },
      })
    );
    expect(getAcpCapabilitySourceVersion({ cliType: 'builtin', agentType: 'kimi' }, '0.36.0')).toBe(
      'builtin-kimi:0.36.0'
    );
  });

  it('launches DeepSeek Harness through the pinned ACP npm composition', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'lody-deepseek-harness-test-'));
    vi.stubEnv(DEEPSEEK_HARNESS_HOME_ENV, dshHome);
    try {
      const launch = await resolveACPProcessLaunchAsync({
        cliType: 'builtin',
        agentType: 'deepseek',
      });

      expect(launch.command).toBe('npx');
      expect(launch.args).not.toContain('--force');
      expect(launch.args).not.toContain('--legacy-peer-deps');
      expect(launch.args).toEqual(
        expect.arrayContaining([
          '--prefer-offline',
          '-y',
          '--package',
          `@deepseek-ai/dsh-acp-demo@${DEEPSEEK_HARNESS_VERSION}`,
          '--package',
          `@deepseek-ai/dsh-agent-spine-demo@${DEEPSEEK_HARNESS_VERSION}`,
          '--package',
          `@deepseek-ai/dsh-session-persistence-jsonl@${DEEPSEEK_HARNESS_VERSION}`,
          '--package',
          `@deepseek-ai/dsh-llm-deepseek@${DEEPSEEK_HARNESS_VERSION}`,
          '--package',
          `@deepseek-ai/dsh-permission-presets@${DEEPSEEK_HARNESS_VERSION}`,
          'dsh-acp-demo',
          '--config',
        ])
      );
      expect(parseNpxPackageSpecFromArgs(launch.args)).toEqual({
        name: '@deepseek-ai/dsh-acp-demo',
        version: DEEPSEEK_HARNESS_VERSION,
      });
      expect(launch.args).not.toContain(`@deepseek-ai/dsh@${DEEPSEEK_HARNESS_VERSION}`);
      expect(launch.env?.[ACP_EXTENSION_DSH_SESSION_ROOT_ENV]).toBe(join(dshHome, 'sessions'));
      expect(launch.env?.[ACP_EXTENSION_DSH_QUERY_PATH_ENV]).toBe(
        join(dshHome, 'sessions', 'session-query.db')
      );
      expect(launch.env?.[DEEPSEEK_HARNESS_HOME_ENV]).toBe(dshHome);

      const configFlag = launch.args.indexOf('--config');
      const configPath = launch.args[configFlag + 1];
      expect(configPath).toBeTruthy();
      const config = await readFile(configPath!, 'utf8');
      expect(config).toContain('deepseek-acp.js');
      expect(config).not.toContain("name: '@deepseek-ai/dsh-acp-demo'");
      expect(config).toContain("name: '@deepseek-ai/dsh-agent-spine-demo'");
      expect(config).toContain("name: '@deepseek-ai/dsh-session-persistence-jsonl'");
      expect(config).toContain("name: '@deepseek-ai/dsh-session-checkpoint-policy'");
      expect(config).toContain("name: '@deepseek-ai/dsh-session-query-sqlite'");
      expect(config).toContain('compression: zstd');
      expect(config).toContain('mode: workspace-write');
      expect(config).toContain("name: '@deepseek-ai/dsh-permission-presets'");
      expect(config).toContain('reasoningEffort: max');
    } finally {
      vi.unstubAllEnvs();
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it('launches an overridden Kimi executable in ACP login mode', async () => {
    await expect(
      resolveACPProcessLaunchAsync({
        cliType: 'builtin',
        agentType: 'kimi',
        runtimeOverrides: { kimiPath: '/opt/kimi' },
        extraArgs: ['--login'],
      })
    ).resolves.toEqual({
      command: '/opt/kimi',
      args: ['acp', '--login'],
      env: {
        KIMI_CODE_NO_AUTO_UPDATE: '1',
      },
      capabilitySourceVersion: `${BUILTIN_KIMI_CAPABILITY_SOURCE_VERSION}+override:{"kimiPath":"/opt/kimi"}`,
    });
  });

  it.each([
    {
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/opt/claude' },
      loginArgs: ['auth', 'login', '--claudeai'],
      statusArgs: ['auth', 'status', '--json'],
    },
    {
      agentType: 'codex',
      runtimeOverrides: { codexPath: '/opt/codex' },
      loginArgs: ['login', '--device-auth'],
      statusArgs: ['login', 'status'],
    },
  ])(
    'launches the official $agentType CLI for builtin login and status checks',
    async ({ agentType, runtimeOverrides, loginArgs, statusArgs }) => {
      await expect(
        resolveBuiltinAuthenticationProcessLaunch({
          cliType: 'builtin',
          agentType,
          runtimeOverrides,
          action: 'login',
        })
      ).resolves.toEqual({
        command: agentType === 'claude' ? '/opt/claude' : '/opt/codex',
        args: loginArgs,
      });
      await expect(
        resolveBuiltinAuthenticationProcessLaunch({
          cliType: 'builtin',
          agentType,
          runtimeOverrides,
          action: 'status',
        })
      ).resolves.toEqual({
        command: agentType === 'claude' ? '/opt/claude' : '/opt/codex',
        args: statusArgs,
      });
    }
  );

  it('uses Kimi ACP login and skips unsupported status probing', async () => {
    await expect(
      resolveBuiltinAuthenticationProcessLaunch({
        cliType: 'builtin',
        agentType: 'kimi',
        runtimeOverrides: { kimiPath: '/opt/kimi' },
        action: 'login',
      })
    ).resolves.toEqual({
      command: '/opt/kimi',
      args: ['acp', '--login'],
      env: { KIMI_CODE_NO_AUTO_UPDATE: '1' },
    });
    await expect(
      resolveBuiltinAuthenticationProcessLaunch({
        cliType: 'builtin',
        agentType: 'kimi',
        runtimeOverrides: { kimiPath: '/opt/kimi' },
        action: 'status',
      })
    ).resolves.toBeNull();
  });

  it('launches Grok ACP and device login through an overridden runtime', async () => {
    await expect(
      resolveACPProcessLaunchAsync({
        cliType: 'builtin',
        agentType: 'grok',
        runtimeOverrides: { grokPath: '/opt/grok' },
      })
    ).resolves.toEqual({
      command: process.execPath,
      args: [expect.stringMatching(/grok-acp\.js$/u)],
      env: { GROK_PATH: '/opt/grok', GROK_DISABLE_AUTOUPDATER: '1' },
      capabilitySourceVersion: `${BUILTIN_GROK_CAPABILITY_SOURCE_VERSION}+override:{"grokPath":"/opt/grok"}`,
    });
    await expect(
      resolveBuiltinAuthenticationProcessLaunch({
        cliType: 'builtin',
        agentType: 'grok',
        runtimeOverrides: { grokPath: '/opt/grok' },
        action: 'login',
      })
    ).resolves.toEqual({
      command: '/opt/grok',
      args: ['login', '--device-auth'],
      env: { GROK_DISABLE_AUTOUPDATER: '1' },
    });
    await expect(
      resolveBuiltinAuthenticationProcessLaunch({
        cliType: 'builtin',
        agentType: 'grok',
        runtimeOverrides: { grokPath: '/opt/grok' },
        action: 'status',
      })
    ).resolves.toBeNull();
  });

  it('launches the managed Kimi module with the current Node executable', async () => {
    const resolveRuntimeForLaunch = vi.fn().mockResolvedValue({
      runtimeName: 'kimi-code',
      version: '0.36.0',
      targetVersion: '0.37.0',
      platformArch: 'node',
      command: '/managed/kimi/package/dist/main.mjs',
      updateAvailable: false,
    });
    const managerSpy = vi
      .spyOn(managedRuntime, 'getManagedAgentRuntimeManager')
      .mockReturnValue({ resolveRuntimeForLaunch } as ReturnType<
        typeof managedRuntime.getManagedAgentRuntimeManager
      >);
    try {
      await expect(
        resolveACPProcessLaunchAsync({ cliType: 'builtin', agentType: 'kimi' })
      ).resolves.toEqual({
        command: process.execPath,
        args: ['/managed/kimi/package/dist/main.mjs', 'acp'],
        env: {
          KIMI_CODE_NO_AUTO_UPDATE: '1',
        },
        capabilitySourceVersion: 'builtin-kimi:0.36.0',
      });
      expect(resolveRuntimeForLaunch).toHaveBeenCalledWith('kimi-code', {
        onProgress: undefined,
        signal: undefined,
      });
    } finally {
      managerSpy.mockRestore();
    }
  });

  it('ignores legacy local Codex ACP env overrides in the sync resolver', () => {
    const previousPath = process.env.LODY_LOCAL_CODEX_ACP_PATH;
    const previousEnabled = process.env.LODY_LOCAL_CODEX_ACP;
    process.env.LODY_LOCAL_CODEX_ACP_PATH = '/tmp/local-acp-extension-codex';
    process.env.LODY_LOCAL_CODEX_ACP = '1';

    try {
      expect(() => resolveBuiltinACPSetting('codex')).toThrow(/resolveACPProcessLaunchAsync/);
    } finally {
      if (previousPath === undefined) {
        delete process.env.LODY_LOCAL_CODEX_ACP_PATH;
      } else {
        process.env.LODY_LOCAL_CODEX_ACP_PATH = previousPath;
      }
      if (previousEnabled === undefined) {
        delete process.env.LODY_LOCAL_CODEX_ACP;
      } else {
        process.env.LODY_LOCAL_CODEX_ACP = previousEnabled;
      }
    }
  });

  it('refreshes metadata when a registry local command uses npx', () => {
    const resolved = resolveACPSetting({ cliType: 'registry', agentType: 'amp-acp' });

    expect(resolved.exec).toMatchObject({
      command: 'npx',
      args: ['--prefer-offline', '-y', 'amp-acp'],
    });
  });

  it('refreshes metadata when a registry npx distribution is used', () => {
    const agent = getRegistryAgent('auggie');
    const npx = agent.distribution.npx;
    if (!npx) {
      throw new Error('Expected auggie to have an npx distribution');
    }

    const resolved = resolveACPSetting({ cliType: 'registry', agentType: 'auggie' });

    expect(resolved.exec).toMatchObject({
      command: 'npx',
      args: ['--prefer-offline', '-y', npx.package, ...(npx.args ?? [])],
    });
  });

  it('uses the direct ACP launch from the Factory Droid registry entry', () => {
    const agent = getRegistryAgent('factory-droid');
    const npx = agent.distribution.npx;
    if (!npx) {
      throw new Error('Expected Factory Droid to have an npx distribution');
    }

    expect(npx.package).toBe(`droid@${agent.version}`);
    expect(npx.args).toEqual(expect.arrayContaining(['exec', '--output-format', 'acp']));
    expect(npx.args).not.toContain('acp-daemon');
    expect(resolveACPSetting({ cliType: 'registry', agentType: 'factory-droid' })).toEqual({
      status: { agent: `Factory Droid@${agent.version}`, command: 'npx' },
      exec: {
        command: 'npx',
        args: ['--prefer-offline', '-y', npx.package, ...(npx.args ?? [])],
        env: npx.env,
      },
    });
    expect(getAcpCapabilitySourceVersion({ cliType: 'registry', agentType: 'factory-droid' })).toBe(
      `factory-droid@${agent.version}`
    );
  });

  it('uses the hardcoded Interactive Claude registry provider with exact platform npx packages', () => {
    const agent = getRegistryAgent('claude-p');
    const npx = agent.distribution.npx;
    if (!npx) {
      throw new Error('Expected claude-p to have an npx distribution');
    }

    const resolved = resolveACPSetting({ cliType: 'registry', agentType: 'claude-p' });
    const expectedPackage = resolveRegistryNpxPackage(npx);

    expect(REGISTRY_ACP_AGENTS[0]?.id).toBe('claude-p');
    expect(resolved.exec).toEqual({
      command: 'npx',
      args: ['--registry=https://registry.npmjs.org/', '--prefer-offline', '-y', expectedPackage],
    });
    expect(getAcpCapabilitySourceVersion({ cliType: 'registry', agentType: 'claude-p' })).toBe(
      'claude-p@0.1.5'
    );
  });

  it('maps Interactive Claude registry npx packages by platform and falls back to wrapper', () => {
    const agent = getRegistryAgent('claude-p');
    const npx = agent.distribution.npx;
    if (!npx) {
      throw new Error('Expected claude-p to have an npx distribution');
    }

    expect(resolveRegistryNpxPackage(npx, 'darwin', 'arm64')).toBe(
      'acp-extension-claude-pty-darwin-arm64@0.1.5'
    );
    expect(resolveRegistryNpxPackage(npx, 'linux', 'x64')).toBe(
      'acp-extension-claude-pty-linux-x64@0.1.5'
    );
    expect(resolveRegistryNpxPackage(npx, 'win32', 'arm64')).toBe(
      'acp-extension-claude-pty-win32-arm64@0.1.5'
    );
    expect(resolveRegistryNpxPackage(npx, 'freebsd', 'x64')).toBe('acp-extension-claude-pty@0.1.5');
    expect(resolveRegistryNpxPackage(npx, 'linux', 'ia32')).toBe('acp-extension-claude-pty@0.1.5');
  });

  it('launches Kimi Code through the local kimi ACP command', () => {
    const resolved = resolveACPSetting({ cliType: 'registry', agentType: 'kimi-code' });

    expect(resolved).toEqual({
      status: { agent: 'Kimi Code CLI@local', command: 'kimi' },
      exec: {
        command: 'kimi',
        args: ['acp'],
      },
    });
  });

  it('refreshes metadata when a registry uvx distribution is used', () => {
    const resolved = resolveRegistryAgentACPSetting({
      id: 'fast-agent',
      name: 'Fast Agent',
      version: '1.2.3',
      distribution: {
        uvx: {
          package: 'fast-agent@1.2.3',
          args: ['--acp'],
          env: { FAST_AGENT_AUTO_UPDATE: '0' },
        },
      },
    });

    expect(resolved).toEqual({
      status: { agent: 'Fast Agent@1.2.3', command: 'uvx' },
      exec: {
        command: 'uvx',
        args: ['fast-agent@1.2.3', '--acp'],
        env: { FAST_AGENT_AUTO_UPDATE: '0' },
      },
    });
  });
});

describe('custom ACP resolution', () => {
  it('resolves a custom provider to its user-defined command and args', () => {
    const resolved = resolveACPSetting({
      cliType: 'custom',
      agentType: 'custom-1234',
      customAcp: { command: '/usr/local/bin/my-acp', args: ['--acp', '--flag=1'] },
    });

    expect(resolved).toEqual({
      status: { agent: 'custom:custom-1234', command: '/usr/local/bin/my-acp' },
      exec: { command: '/usr/local/bin/my-acp', args: ['--acp', '--flag=1'] },
    });
  });

  it('resolves a custom provider without args to an empty arg list', () => {
    const resolved = resolveACPSetting({
      cliType: 'custom',
      agentType: 'custom-1234',
      customAcp: { command: 'my-acp' },
    });

    expect(resolved.exec).toEqual({ command: 'my-acp', args: [] });
  });

  it('throws when a custom provider has no launch command', () => {
    expect(() => resolveACPSetting({ cliType: 'custom', agentType: 'custom-1234' })).toThrow(
      /no launch command/
    );
    expect(() =>
      resolveACPSetting({
        cliType: 'custom',
        agentType: 'custom-1234',
        customAcp: { command: '   ' },
      })
    ).toThrow(/no launch command/);
  });

  it('keys the capability source version on the launch spec so edits re-probe', () => {
    const v1 = getAcpCapabilitySourceVersion({
      cliType: 'custom',
      agentType: 'custom-1234',
      customAcp: { command: 'my-acp', args: ['--acp'] },
    });
    const v2 = getAcpCapabilitySourceVersion({
      cliType: 'custom',
      agentType: 'custom-1234',
      customAcp: { command: 'my-acp', args: ['--acp', '--new-flag'] },
    });

    expect(v1).not.toBe(v2);
    expect(
      getAcpCapabilitySourceVersion({
        cliType: 'custom',
        agentType: 'custom-1234',
        customAcp: { command: 'my-acp', args: ['--acp'] },
      })
    ).toBe(v1);
    expect(getAcpCapabilitySourceVersion({ cliType: 'custom', agentType: 'custom-1234' })).toBe(
      'custom:custom-1234:unknown'
    );
  });
});

describe('withDefaultAcpPathEntries', () => {
  it('prepends user-local bin directories to PATH', () => {
    const result = withDefaultAcpPathEntries({ PATH: '/usr/bin' });

    expect(result.PATH?.split(delimiter)).toEqual([
      join(homedir(), '.local/bin'),
      join(homedir(), 'bin'),
      join(homedir(), '.claude/local'),
      '/usr/bin',
    ]);
  });

  it.each(['kimi', 'kimi-code'])('prepends the Kimi Code bin directory for %s', (agentType) => {
    const result = withDefaultAcpPathEntries({ PATH: '/usr/bin' }, agentType);

    expect(result.PATH?.split(delimiter)).toEqual([
      join(homedir(), '.kimi-code/bin'),
      join(homedir(), '.local/bin'),
      join(homedir(), 'bin'),
      join(homedir(), '.claude/local'),
      '/usr/bin',
    ]);
  });

  it('moves existing default entries to the front without duplicating them', () => {
    const localBin = join(homedir(), '.local/bin');
    const homeBin = join(homedir(), 'bin');
    const claudeLocal = join(homedir(), '.claude/local');
    const result = withDefaultAcpPathEntries({
      PATH: ['/usr/bin', `${localBin}/`, '/bin', homeBin, claudeLocal].join(delimiter),
    });

    expect(result.PATH?.split(delimiter)).toEqual([
      localBin,
      homeBin,
      claudeLocal,
      '/usr/bin',
      '/bin',
    ]);
  });
});

describe('mergeLoginShellEnv', () => {
  const splitPath = (value: string | undefined): string[] =>
    (value ?? '').split(delimiter).filter(Boolean);

  it('returns the base unchanged when the shell env is empty or missing', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/u' };
    expect(mergeLoginShellEnv(base, null)).toBe(base);
    expect(mergeLoginShellEnv(base, undefined)).toBe(base);
    expect(mergeLoginShellEnv(base, {})).toBe(base);
  });

  it('prepends login-shell PATH entries so user-installed tools resolve first', () => {
    // A GUI-launched daemon inherits a minimal PATH; the login shell knows where
    // tools like opencode actually live (homebrew, cargo, ~/.local/bin, ...).
    const base = { PATH: '/usr/bin:/bin' };
    const shell = { PATH: '/opt/homebrew/bin:/home/u/.local/bin:/usr/bin' };

    expect(splitPath(mergeLoginShellEnv(base, shell).PATH)).toEqual([
      '/opt/homebrew/bin',
      '/home/u/.local/bin',
      '/usr/bin',
      '/bin',
    ]);
  });

  it('keeps base-only PATH entries (e.g. runtime-injected node_modules/.bin)', () => {
    const base = { PATH: '/proj/node_modules/.bin:/usr/bin' };
    const shell = { PATH: '/home/u/.local/bin:/usr/bin' };

    expect(splitPath(mergeLoginShellEnv(base, shell).PATH)).toEqual([
      '/home/u/.local/bin',
      '/usr/bin',
      '/proj/node_modules/.bin',
    ]);
  });

  it('dedupes PATH entries that differ only by trailing slash', () => {
    const base = { PATH: '/usr/bin/' };
    const shell = { PATH: '/usr/bin' };

    expect(splitPath(mergeLoginShellEnv(base, shell).PATH)).toEqual(['/usr/bin']);
  });

  it('lets base win for non-PATH vars but fills in vars only the shell has', () => {
    const base = { PATH: '/usr/bin', CODEX_HOME: '/work/.codex', LODY_E2E: '1' };
    const shell = { PATH: '/usr/bin', CODEX_HOME: '/home/u/.codex', LANG: 'en_US.UTF-8' };

    const merged = mergeLoginShellEnv(base, shell);

    // base-injected values are preserved...
    expect(merged.CODEX_HOME).toBe('/work/.codex');
    expect(merged.LODY_E2E).toBe('1');
    // ...while vars only the login shell defines are added.
    expect(merged.LANG).toBe('en_US.UTF-8');
  });
});
