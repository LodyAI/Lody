import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import { AcpAuthenticationManager, probeBuiltinAuthentication } from './acp-authentication';
import {
  acquireAccountProfileUse,
  acquireAccountProfileAuthentication,
  createAccountProfile,
  listAccountProfiles,
  validateAccountProfile,
} from './account-profiles';
import { startLocalAcpAgent } from './acp-runner';
import { prepareManagedClaudeAuthentication } from './managed-claude-authentication';

vi.mock('./managed-claude-authentication', () => ({
  prepareManagedClaudeAuthentication: vi.fn(async (input) =>
    input.agentType === 'claude' && input.accountProfileId
      ? input.env.CLAUDE_CONFIG_DIR
      : os.homedir()
  ),
}));

const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  setLevel() {},
  child: () => logger,
  close: async () => {},
};
const roots: string[] = [];
async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-account-auth-test-'));
  roots.push(value);
  return value;
}
afterEach(async () => {
  for (const value of roots.splice(0)) await fs.rm(value, { recursive: true, force: true });
});

function childProcess() {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  });
  return child;
}

describe('account authentication provider boundary', () => {
  it('does not spawn native status or login after a settings preflight rejection', async () => {
    const profilesRoot = await root();
    const input = { cliType: 'builtin' as const, agentType: 'claude', profilesRoot };
    const profile = await createAccountProfile({ ...input, label: 'Guarded' });
    const selected = {
      ...input,
      accountProfileId: profile.accountProfileId,
      runtimeOverrides: { claudeCodeExecutable: '/verified/claude' },
    };
    const spawnProcess = vi.fn();
    vi.mocked(prepareManagedClaudeAuthentication).mockRejectedValueOnce(
      new Error('Settings rejected')
    );
    await expect(
      probeBuiltinAuthentication({
        ...selected,
        logger,
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      })
    ).rejects.toThrow('Settings rejected');
    vi.mocked(prepareManagedClaudeAuthentication).mockRejectedValueOnce(
      new Error('Settings rejected')
    );
    const manager = new AcpAuthenticationManager(logger, {
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv: async () => ({}),
    });
    await expect(
      manager.authenticate({ ...selected, requestId: 'settings-rejected' })
    ).resolves.toMatchObject({ success: false, disposition: 'error' });
    expect(spawnProcess).not.toHaveBeenCalled();
    acquireAccountProfileUse(selected)();
  });
  it.each(['claude', 'codex'] as const)(
    'rejects a duplicate request id for another %s account without disturbing the original login',
    async (secondAgentType) => {
      const profilesRoot = await root();
      const firstInput = { cliType: 'builtin' as const, agentType: 'claude', profilesRoot };
      const secondInput = { ...firstInput, agentType: secondAgentType };
      const firstProfile = await createAccountProfile({ ...firstInput, label: 'First' });
      const secondProfile = await createAccountProfile({ ...secondInput, label: 'Second' });
      let spawned!: () => void;
      const didSpawn = new Promise<void>((resolve) => {
        spawned = resolve;
      });
      const children: ChildProcess[] = [];
      const spawnProcess = vi.fn(() => {
        const child = childProcess();
        children.push(child);
        spawned();
        if (children.length > 1) {
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit('exit', 0);
          });
        }
        return child;
      });
      const manager = new AcpAuthenticationManager(logger, {
        spawnProcess: spawnProcess as never,
        resolveLoginShellEnv: async () => ({}),
      });
      const first = manager.authenticate({
        ...firstInput,
        requestId: 'shared-request',
        accountProfileId: firstProfile.accountProfileId,
        runtimeOverrides: { claudeCodeExecutable: '/verified/claude' },
      });
      await didSpawn;
      const secondTarget = { ...secondInput, accountProfileId: secondProfile.accountProfileId };
      await expect(
        manager.authenticate({
          ...secondTarget,
          requestId: 'shared-request',
          runtimeOverrides: {
            claudeCodeExecutable: '/verified/claude',
            codexPath: '/verified/codex',
          },
        })
      ).resolves.toMatchObject({
        success: false,
        disposition: 'error',
        error: 'Authentication request is already running',
      });
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(manager.getAgentType('shared-request')).toBe('claude');
      acquireAccountProfileUse(secondTarget)();
      expect(manager.cancel('shared-request')).toEqual({ success: true, disposition: 'cancelled' });
      expect(await first).toMatchObject({ disposition: 'cancelled' });
      expect(children[0]?.kill).toHaveBeenCalledOnce();
      expect(manager.getAgentType('shared-request')).toBeUndefined();
    }
  );

  it('releases cancelled pre-spawn login leases without releasing a subsequent retry lease', async () => {
    const profilesRoot = await root();
    const input = { cliType: 'builtin' as const, agentType: 'claude', profilesRoot };
    const profile = await createAccountProfile({ ...input, label: 'Retry' });
    const selected = {
      ...input,
      accountProfileId: profile.accountProfileId,
      runtimeOverrides: { claudeCodeExecutable: '/verified/claude' },
    };
    let preparationStarted!: () => void;
    const preparing = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    let finishPreparation!: (env: Record<string, string>) => void;
    const pendingEnv = new Promise<Record<string, string>>((resolve) => {
      finishPreparation = resolve;
    });
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const child = childProcess();
    const spawnProcess = vi.fn(() => {
      spawned();
      return child;
    });
    let attempts = 0;
    const released = vi.fn();
    const manager = new AcpAuthenticationManager(logger, {
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv: async () => {
        if (++attempts === 1) {
          preparationStarted();
          return await pendingEnv;
        }
        return {};
      },
    });
    const first = manager.authenticate({
      ...selected,
      requestId: 'cancelled',
      onAccountLeaseReleased: released,
    });
    await preparing;
    manager.cancel('cancelled');
    expect(released).toHaveBeenCalledTimes(1);
    const retry = manager.authenticate({
      ...selected,
      requestId: 'retry',
      onAccountLeaseReleased: released,
    });
    await didSpawn;
    finishPreparation({});
    expect(await first).toMatchObject({ disposition: 'cancelled' });
    expect(() => acquireAccountProfileUse(selected)).toThrow('signing in');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    child.exitCode = 0;
    child.emit('exit', 0);
    expect(await retry).toMatchObject({ disposition: 'authenticated' });
    expect(released).toHaveBeenCalledTimes(2);
    acquireAccountProfileUse(selected)();
  });
  it('blocks login during auxiliary use and blocks auxiliary launch during login across managers', async () => {
    const profilesRoot = await root();
    const input = { cliType: 'builtin' as const, agentType: 'codex', profilesRoot };
    const profile = await createAccountProfile({ ...input, label: 'Shared across workspaces' });
    const selected = { ...input, accountProfileId: profile.accountProfileId };
    const releaseUse = acquireAccountProfileUse(selected);
    const spawnProcess = vi.fn();
    const manager = new AcpAuthenticationManager(logger, { spawnProcess: spawnProcess as never });
    try {
      await expect(
        manager.authenticate({ ...selected, requestId: 'blocked-login' })
      ).resolves.toMatchObject({ success: false, disposition: 'error' });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(() => acquireAccountProfileAuthentication(selected)).toThrow('in use');
    } finally {
      releaseUse();
    }
    const releaseAuth = acquireAccountProfileAuthentication(selected);
    try {
      await expect(
        startLocalAcpAgent({
          ...selected,
          workdir: profilesRoot,
          logger,
          terminalManager: {
            createTerminal: async () => '',
            terminalOutput: async () => ({ output: '', truncated: false, exitStatus: null }),
            releaseTerminal: async () => {},
            waitForTerminalExit: async () => ({ exitCode: 0 }),
            killTerminal: async () => {},
          },
          onUpdateMessage: () => {},
          onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        })
      ).rejects.toThrow('signing in');
      expect(() => acquireAccountProfileUse(selected)).toThrow('signing in');
    } finally {
      releaseAuth();
    }
    acquireAccountProfileUse(selected)();
  });
  it('detects native Codex identity with read-only account/read and no home override', async () => {
    const requests: unknown[] = [];
    const child = childProcess();
    child.stdin?.on('data', (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as { id?: number; method: string };
      requests.push(message);
      if (message.id)
        queueMicrotask(() =>
          child.stdout?.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                id: message.id,
                result:
                  message.id === 1
                    ? {}
                    : { account: { type: 'chatgpt', email: 'work@example.test' } },
              }) + '\n'
            )
          )
        );
    });
    const spawnProcess = vi.fn(() => child);
    const result = await probeBuiltinAuthentication({
      cliType: 'builtin',
      agentType: 'codex',
      accountStatusOnly: true,
      env: { CODEX_HOME: '/native-home' },
      runtimeOverrides: { codexPath: '/verified/codex' },
      logger,
      resolveLoginShellEnv: async () => ({ CODEX_HOME: '/shell-home' }),
      spawnProcess: spawnProcess as never,
    });
    expect(result).toEqual({ status: 'authenticated', identity: 'work@example.test' });
    expect(requests).toContainEqual({
      id: 2,
      method: 'account/read',
      params: { refreshToken: false },
    });
    const call = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(call[2].env.CODEX_HOME).toBe('/native-home');
    expect(requests.some((value) => JSON.stringify(value).includes('thread/'))).toBe(false);
  });

  it('keeps malformed account status unknown and refuses to validate it', async () => {
    const spawnProcess = () => {
      const child = childProcess();
      child.stdin?.once('data', () =>
        queueMicrotask(() => child.stdout?.emit('data', Buffer.from('malformed\n')))
      );
      return child;
    };
    const input = {
      cliType: 'builtin' as const,
      agentType: 'codex',
      runtimeOverrides: { codexPath: '/verified/codex' },
      logger,
      resolveLoginShellEnv: async () => ({}),
      spawnProcess: spawnProcess as never,
    };
    await expect(validateAccountProfile(input)).rejects.toThrow('could not be verified');
    const profiles = await listAccountProfiles({ ...input, profilesRoot: await root() });
    expect(profiles).toEqual([
      { accountProfileId: 'system-default', label: 'System Default', status: 'unknown' },
    ]);
  });

  it('allows independent account logins and cancels only the requested account', async () => {
    const profilesRoot = await root();
    const input = { cliType: 'builtin' as const, agentType: 'claude', profilesRoot };
    const a = await createAccountProfile({ ...input, label: 'A' });
    const b = await createAccountProfile({ ...input, label: 'B' });
    const children: ChildProcess[] = [];
    const childrenByProfile = new Map<string, ChildProcess>();
    let spawned!: () => void;
    const bothSpawned = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const environments: NodeJS.ProcessEnv[] = [];
    const spawnProcess = (
      _command: string,
      _args: string[],
      options: { env: NodeJS.ProcessEnv }
    ) => {
      const child = childProcess();
      children.push(child);
      childrenByProfile.set(options.env.LODY_ACCOUNT_PROFILE_ID ?? '', child);
      environments.push(options.env);
      if (children.length === 2) spawned();
      return child;
    };
    const manager = new AcpAuthenticationManager(logger, {
      spawnProcess: spawnProcess as never,
      resolveLoginShellEnv: async () => ({
        CLAUDE_CONFIG_DIR: '/native-claude',
        ANTHROPIC_API_KEY: 'synthetic',
      }),
    });
    const auth = (requestId: string, accountProfileId: string) =>
      manager.authenticate({
        ...input,
        requestId,
        accountProfileId,
        runtimeOverrides: { claudeCodeExecutable: '/verified/claude' },
      });
    const first = auth('first', a.accountProfileId);
    const second = auth('second', b.accountProfileId);
    await bothSpawned;
    expect(manager.getAgentType('first')).toBe('claude');
    expect(manager.getAgentType('second')).toBe('claude');
    expect(environments[0]?.CLAUDE_CONFIG_DIR).not.toBe(environments[1]?.CLAUDE_CONFIG_DIR);
    expect(environments.every((env) => env.ANTHROPIC_API_KEY === undefined)).toBe(true);
    manager.cancel('first');
    const secondChild = childrenByProfile.get(b.accountProfileId);
    expect(secondChild?.kill).not.toHaveBeenCalled();
    if (secondChild) {
      secondChild.exitCode = 0;
      secondChild.emit('exit', 0);
    }
    expect(await first).toMatchObject({ disposition: 'cancelled' });
    expect(await second).toMatchObject({ disposition: 'authenticated' });
    expect(manager.getAgentType('first')).toBeUndefined();
    expect(manager.getAgentType('second')).toBeUndefined();
  });
});
