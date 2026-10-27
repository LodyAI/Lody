import { delimiter, join } from 'node:path';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as processOptions from '../src/platform/process-options';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import * as harnessRuntime from '../src/agent/deepseek-harness-runtime';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, WorkspaceId } from '@lody/shared';

// Control the login-shell overlay so we can simulate a `~/.zshrc` that exports
// ANTHROPIC_* (the second auth source the scrub must still see). Defaults to {}
// so every other test behaves as if the cache is cold.
const loginShellOverlay = vi.hoisted(() => ({ value: {} as NodeJS.ProcessEnv }));
const resolvedLoginShellOverlay = vi.hoisted(() => ({ value: {} as NodeJS.ProcessEnv }));
vi.mock('@/agent/login-shell-env', () => ({
  getCachedLoginShellEnvSyncLegacy: () => loginShellOverlay.value,
  getLoginShellEnvLegacy: async () => resolvedLoginShellOverlay.value,
}));

const controlledHome = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: () => controlledHome.value ?? original.homedir() };
});

import { Session } from '../src/session/session';
import type { CreateAgentConfig } from '../src/session/session-manager';
import type { SessionSandbox } from '../src/session/session-sandbox';
import type { SessionConfig } from '../src/session/types';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createConfig = (overrides: Partial<SessionConfig> = {}): SessionConfig => ({
  workspaceId: 'workspace-1' as WorkspaceId,
  requesterUserId: 'user-1',
  machineId: 'machine-1',
  agentCliType: 'builtin',
  agentType: 'codex',
  sessionId: 'session-1' as SessionId,
  userName: 'Test User',
  userEmail: 'test@example.com',
  ...overrides,
});

describe('Session buildShellEnv', () => {
  afterEach(() => {
    loginShellOverlay.value = {};
    resolvedLoginShellOverlay.value = {};
  });

  it('exposes the workspace owner session id for child sessions', () => {
    const session = new Session(
      createConfig({
        sessionId: 'child-session-2' as SessionId,
        parentSessionId: 'parent-session-1' as SessionId,
      }),
      createSilentLogger()
    );

    const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

    expect(env.LODY_SESSION_ID).toBe('child-session-2');
    expect(env.LODY_WORKSPACE_SESSION_ID).toBe('parent-session-1');
  });

  it('falls back to its own session id when no parent session exists', () => {
    const session = new Session(createConfig(), createSilentLogger());

    const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

    expect(env.LODY_SESSION_ID).toBe('session-1');
    expect(env.LODY_WORKSPACE_SESSION_ID).toBe('session-1');
  });

  it('allows updateEnv to remove stale session environment keys', () => {
    const session = new Session(
      createConfig({
        env: {
          GH_TOKEN: 'old-token',
          LODY_MANAGED_GH_TOKEN_SHA256: 'old-marker',
        },
      }),
      createSilentLogger()
    );

    session.updateEnv({
      GH_TOKEN: undefined,
      LODY_MANAGED_GH_TOKEN_SHA256: undefined,
      LODY_GIT_CRED_CONTEXT_TOKEN: 'next-context',
    });

    const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.LODY_MANAGED_GH_TOKEN_SHA256).toBeUndefined();
    expect(env.LODY_GIT_CRED_CONTEXT_TOKEN).toBe('next-context');
  });

  it('scrubs inherited Anthropic auth when claude session has explicit ANTHROPIC_AUTH_TOKEN', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    try {
      const session = new Session(
        createConfig({
          agentType: 'claude',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          },
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-config');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
    }
  });

  it('does not scrub inherited Anthropic env for non-claude agents', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
    try {
      const session = new Session(
        createConfig({
          agentType: 'codex',
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-from-config' },
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      expect(env.ANTHROPIC_API_KEY).toBe('sk-from-shell');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it('preserves inherited Anthropic env when claude session has no explicit auth/routing', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-from-shell';
    try {
      const session = new Session(
        createConfig({
          agentType: 'claude',
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      // Subscription / OAuth / shell-set users should still see their inherited credentials.
      expect(env.ANTHROPIC_API_KEY).toBe('sk-from-shell');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it('scrubs Anthropic auth that the login-shell env reintroduces (regression)', () => {
    // Regression: the login profile (~/.zshrc) is a *second* source of ANTHROPIC_*.
    // buildShellEnv must overlay the login-shell env BEFORE scrubbing — otherwise a
    // stray `ANTHROPIC_API_KEY` from the shell silently overrides the configured
    // `ANTHROPIC_AUTH_TOKEN`, defeating the scrub.
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // isolate: the login shell is the only source
    loginShellOverlay.value = {
      ANTHROPIC_API_KEY: 'sk-from-login-shell',
      PATH: '/opt/homebrew/bin',
    };
    try {
      const session = new Session(
        createConfig({
          agentType: 'claude',
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-from-config',
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          },
        }),
        createSilentLogger()
      );

      const env = (session as unknown as { buildShellEnv(): NodeJS.ProcessEnv }).buildShellEnv();

      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-from-config');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
      // The ENOENT fix is preserved: the login-shell PATH still reaches the agent.
      expect((env.PATH ?? '').split(delimiter)).toContain('/opt/homebrew/bin');
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it.each([undefined, { providerId: 'nowledge-mem', memoryId: 'reviewer' }])(
    'awaits the shell and injects the frozen memory at ACP spawn: %j',
    async (memory) => {
      loginShellOverlay.value = { PATH: '/usr/bin' };
      resolvedLoginShellOverlay.value = {
        PATH: ['/opt/homebrew/bin', '/usr/bin'].join(delimiter),
      };

      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      const stopAfterCapture = new Error('stop after capturing ACP spawn environment');
      const spawn: SessionSandbox['spawn'] = vi.fn(async (_command, _args, options) => {
        spawnedEnv = options.env;
        throw stopAfterCapture;
      });
      const sandbox: SessionSandbox = {
        enabled: false,
        description: 'test',
        applyLimits: async () => {},
        readResourceAccounting: async () => ({ kind: 'unavailable', reason: 'test' }),
        spawn,
        terminate: async () => {},
        cleanup: async () => {},
      };
      const session = new Session(
        createConfig({ memory }),
        createSilentLogger(),
        process.cwd(),
        sandbox
      );
      const callbacks = {
        cliType: 'registry',
        agentType: 'opencode',
        command: 'opencode',
        args: ['acp'],
      } as CreateAgentConfig;

      await expect(session.createAgent(callbacks)).rejects.toBe(stopAfterCapture);
      if (memory) expect(spawnedEnv?.NMEM_AGENT_ID).toBe(memory.memoryId);
      expect((spawnedEnv?.PATH ?? '').split(delimiter)).toEqual(
        expect.arrayContaining(['/opt/homebrew/bin', '/usr/bin'])
      );
      expect((spawnedEnv?.PATH ?? '').split(delimiter).indexOf('/opt/homebrew/bin')).toBeLessThan(
        (spawnedEnv?.PATH ?? '').split(delimiter).indexOf('/usr/bin')
      );
    }
  );
});

describe('Session.createAgent DeepSeek Node prerequisites', () => {
  const roots: string[] = [];
  const originalPlatformLayer = processOptions.platformLayer;
  const originalSpawnResolver = harnessRuntime.resolveDeepSeekHarnessSpawn;

  afterEach(async () => {
    vi.restoreAllMocks();
    controlledHome.value = undefined;
    loginShellOverlay.value = {};
    resolvedLoginShellOverlay.value = {};
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'lody-session-dsh-node-'));
    roots.push(root);
    controlledHome.value = root;
    const bin = join(root, 'Node with spaces');
    await mkdir(bin);
    const node = join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
    const table = new FakeProcessTable('linux');
    const probePids: number[] = [];
    let holdProbe = false;
    let probeRuntime:
      | ((cwd: string | undefined) => { execPath: string; node: string; napi: string })
      | undefined;
    let announceProbe: () => void = () => {};
    const probeStarted = new Promise<void>((onStarted) => {
      announceProbe = onStarted;
    });
    vi.spyOn(processOptions, 'platformLayer').mockImplementation((options) =>
      originalPlatformLayer({
        ...options,
        nodeProcess: {
          ...table.api,
          spawn: (...args: Parameters<typeof table.api.spawn>) => {
            const child = table.api.spawn(...args);
            probePids.push(child.pid ?? -1);
            announceProbe();
            if (!holdProbe)
              queueMicrotask(() => {
                child.stdout?.write(
                  JSON.stringify(
                    probeRuntime?.(args[2]?.cwd?.toString()) ?? {
                      execPath: args[0],
                      node: '24.22.1',
                      napi: '10',
                    }
                  )
                );
                table.exitOnItsOwn(child.pid ?? -1);
              });
            return child;
          },
        },
      })
    );
    const launch = await harnessRuntime.resolveDeepSeekHarnessProcessLaunch({
      rootDir: root,
      adapterPath: join(root, 'deepseek-acp.js'),
    });
    const captured: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const reachedSandbox = new Error('reached ACP sandbox boundary');
    let failFirstAttempt = false;
    const sandbox: SessionSandbox = {
      enabled: false,
      description: 'synthetic ACP sandbox',
      applyLimits: async () => {},
      readResourceAccounting: async () => ({ kind: 'unavailable', reason: 'test' }),
      spawn: async (command, args, options) => {
        captured.push({ command, args, env: options.env ?? {} });
        if (failFirstAttempt && captured.length === 1) {
          await rm(node);
          throw new Error('npm code ETARGET: No matching version found for synthetic package');
        }
        throw reachedSandbox;
      },
      terminate: async () => {},
      cleanup: async () => {},
    };
    resolvedLoginShellOverlay.value = { PATH: bin, SYNTHETIC_LOGIN_ENV: 'preserved' };
    const session = new Session(
      createConfig({
        agentType: 'deepseek',
        memory: { providerId: 'nowledge-mem', memoryId: 'synthetic-memory' },
      }),
      createSilentLogger(),
      root,
      sandbox
    );
    const callbacks = {
      cliType: 'builtin',
      agentType: 'deepseek',
      ...launch,
      env: { ...launch.env, PATH: bin, SYNTHETIC_PROVIDER_ENV: 'preserved' },
    } as CreateAgentConfig;
    return {
      root,
      bin,
      node,
      table,
      captured,
      session,
      callbacks,
      reachedSandbox,
      probeStarted,
      probePids,
      setProbeRuntime: (runtime: NonNullable<typeof probeRuntime>) => {
        probeRuntime = runtime;
      },
      holdProbe: () => {
        holdProbe = true;
      },
      failFirstAttempt: () => {
        failFirstAttempt = true;
      },
      installNode: () => writeFile(node, 'synthetic Node executable', { mode: 0o700 }),
    };
  }

  it('reports missing Node before npx and recovers on the same Session after installation', async () => {
    const f = await fixture();
    await expect(f.session.createAgent(f.callbacks)).rejects.toThrow('[DSH_NODE_NOT_FOUND]');
    expect(f.captured).toEqual([]);
    expect(f.table.spawned).toEqual([]);
    await f.installNode();
    await expect(f.session.createAgent(f.callbacks)).rejects.toBe(f.reachedSandbox);
    expect(f.captured[0]?.env.LODY_DSH_NODE_EXECUTABLE).toBe(f.node);
    expect(f.captured[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(f.captured[0]?.env.NMEM_AGENT_ID).toBe('synthetic-memory');
    expect(f.captured[0]?.env.SYNTHETIC_LOGIN_ENV).toBe('preserved');
    expect(f.captured[0]?.env.SYNTHETIC_PROVIDER_ENV).toBe('preserved');
    expect(f.table.spawned[0]?.options.env?.NMEM_AGENT_ID).toBe('synthetic-memory');
  });

  it('validates a directory-sensitive manager in the Session workdir and freezes its actual Node', async () => {
    const f = await fixture();
    await f.installNode();
    const actualNode = join(f.root, 'actual-node');
    f.setProbeRuntime((cwd) => ({
      execPath: actualNode,
      node: cwd === f.root ? '24.22.0' : '24.22.1',
      napi: '10',
    }));
    await expect(f.session.createAgent(f.callbacks)).rejects.toThrow('[DSH_NODE_UNSUPPORTED]');
    expect(f.captured).toEqual([]);
    expect(f.probePids.map((pid) => f.table.isAlive(pid))).toEqual([false]);
    // Correcting the project pin restores the same Session; execution bypasses the shim.
    f.setProbeRuntime(() => ({ execPath: actualNode, node: '24.22.1', napi: '10' }));
    await expect(f.session.createAgent(f.callbacks)).rejects.toBe(f.reachedSandbox);
    expect(f.captured[0]?.env.LODY_DSH_NODE_EXECUTABLE).toBe(actualNode);
  });

  it.skipIf(process.platform === 'win32')(
    'searches past an inaccessible PATH directory without changing its permissions',
    async () => {
      const f = await fixture();
      const denied = join(f.root, 'unrelated-private-bin');
      await mkdir(denied, { mode: 0o000 });
      resolvedLoginShellOverlay.value = { PATH: [denied, f.bin].join(delimiter) };
      try {
        await expect(f.session.createAgent(f.callbacks)).rejects.toThrow('[DSH_NODE_EXEC_FAILED]');
        expect(f.captured).toEqual([]);
        await f.installNode();
        await expect(f.session.createAgent(f.callbacks)).rejects.toBe(f.reachedSandbox);
        expect(f.captured[0]?.env.LODY_DSH_NODE_EXECUTABLE).toBe(f.node);
        expect((await stat(denied)).mode & 0o777).toBe(0);
      } finally {
        await chmod(denied, 0o700);
      }
    }
  );

  it('passes the validated Node into the Windows npm JS dispatch branch', async () => {
    const f = await fixture();
    await f.installNode();
    const actualNode = join(f.root, 'selected-node.exe');
    f.setProbeRuntime(() => ({ execPath: actualNode, node: '24.22.1', napi: '10' }));
    const npmDir = join(f.bin, 'node_modules', 'npm', 'bin');
    await mkdir(npmDir, { recursive: true });
    await writeFile(join(f.bin, 'npx.cmd'), '@exit /b 99\r\n');
    const npmEntry = join(npmDir, 'npx-cli.js');
    await writeFile(npmEntry, '// synthetic npm entry');
    // Run the real Windows resolver with the host-independent Windows PATH spelling.
    // The prerequisite probe and every other Session step remain real implementations.
    vi.spyOn(harnessRuntime, 'resolveDeepSeekHarnessSpawn').mockImplementation((options) =>
      originalSpawnResolver({
        ...options,
        platform: 'win32',
        env: { ...options.env, PATH: (options.env.PATH ?? '').split(delimiter).join(';') },
      })
    );
    await expect(f.session.createAgent(f.callbacks)).rejects.toBe(f.reachedSandbox);
    expect(f.captured[0]?.command).toBe(actualNode);
    expect(f.captured[0]?.args.slice(0, 3)).toEqual([
      '--import',
      expect.stringContaining('data:text/javascript;base64,'),
      await realpath(npmEntry),
    ]);
    expect(f.captured[0]?.args.slice(3)).toEqual(f.callbacks.args);
    expect(f.captured[0]?.env.LODY_DSH_NODE_EXECUTABLE).toBe(actualNode);
  });

  it('cancels the in-flight prerequisite probe without spawning npx or leaving its process alive', async () => {
    const f = await fixture();
    await f.installNode();
    f.holdProbe();
    const controller = new AbortController();
    const startup = f.session.createAgent({ ...f.callbacks, abortSignal: controller.signal });
    const rejected = expect(startup).rejects.toBeDefined();
    await f.probeStarted;
    controller.abort();
    await rejected;
    expect(f.captured).toEqual([]);
    expect(f.probePids.map((pid) => f.table.isAlive(pid))).toEqual([false]);
  });

  it('rechecks Node on each npm recovery attempt instead of reusing a stale executable', async () => {
    const f = await fixture();
    await f.installNode();
    const secondBin = join(f.root, 'replacement-node');
    await mkdir(secondBin);
    const secondNode = join(secondBin, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(secondNode, 'replacement Node executable', { mode: 0o700 });
    resolvedLoginShellOverlay.value = { PATH: [f.bin, secondBin].join(delimiter) };
    f.failFirstAttempt();
    await expect(f.session.createAgent(f.callbacks)).rejects.toBe(f.reachedSandbox);
    expect(f.captured.map((entry) => entry.env.LODY_DSH_NODE_EXECUTABLE)).toEqual([
      f.node,
      secondNode,
    ]);
    expect(f.probePids.map((pid) => f.table.isAlive(pid))).toEqual([false, false]);
  });
});
