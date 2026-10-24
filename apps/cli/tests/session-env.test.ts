import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { Session } from '../src/session/session';
import type { CreateAgentConfig } from '../src/session/session-manager';
import { createNoopSessionSandbox, type SessionSandbox } from '../src/session/session-sandbox';
import type { SessionConfig } from '../src/session/types';
import type { SessionCredentials } from '../src/session/session-credentials';
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

describe('Session Git identity and signing', () => {
  let root: string;
  let repo: string;
  let home: string;
  const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const shellEnv = (session: Session, extra?: Record<string, string>) =>
    (
      session as unknown as { buildShellEnv(extra?: Record<string, string>): NodeJS.ProcessEnv }
    ).buildShellEnv(extra);
  const commitIdentity = (cwd: string, env: NodeJS.ProcessEnv) => {
    git(cwd, env, 'commit', '--allow-empty', '-qm', 'synthetic identity fixture');
    return git(cwd, env, 'log', '-1', '--format=%an <%ae>|%cn <%ce>');
  };
  const bind = (session: Session, owner: boolean, email = 'member@example.invalid') =>
    session.updateGitIdentity('Member', email, owner ? 'user-1' : 'member', {
      preferMachineIdentity: owner,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lody-session-git-'));
    home = join(root, 'home');
    repo = join(root, 'repo');
    mkdirSync(home);
    mkdirSync(repo);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_') || key.startsWith('LODY_GIT_')) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('EMAIL', undefined);
    vi.stubEnv('LODY_DATA_DIR', join(root, 'lody'));
    writeFileSync(
      join(home, '.gitconfig'),
      '[user]\nname = Global Owner\nemail = global@example.invalid\n'
    );
    git(repo, process.env, 'init', '-q');
    git(repo, process.env, 'config', 'user.name', 'Repo Owner');
    git(repo, process.env, 'config', 'user.email', 'repo@example.invalid');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    loginShellOverlay.value = {};
    resolvedLoginShellOverlay.value = {};
    rmSync(root, { recursive: true, force: true });
  });

  it('lets owner commits use repository configuration without caching a fork identity', () => {
    const session = new Session(createConfig(), createSilentLogger(), repo);
    bind(session, true);
    expect(commitIdentity(repo, shellEnv(session))).toBe(
      'Repo Owner <repo@example.invalid>|Repo Owner <repo@example.invalid>'
    );
    expect(session.getGitIdentityForUser('user-1')).toBeNull();
    expect(shellEnv(session).GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it.each([false, true])(
    'evaluates gitdir includes at the commit directory (linked=%s)',
    (linked) => {
      git(repo, process.env, 'config', '--remove-section', 'user');
      commitIdentity(repo, process.env);
      let cwd = repo;
      if (linked) {
        cwd = join(root, 'linked');
        git(repo, process.env, 'worktree', 'add', '-qb', 'linked', cwd);
      }
      const gitdir = git(cwd, process.env, 'rev-parse', '--absolute-git-dir').replaceAll('\\', '/');
      git(cwd, process.env, 'config', 'remote.origin.url', 'https://example.invalid/owner/repo');
      writeFileSync(join(home, 'conditional'), '[user]\nname = Conditional Owner\n');
      writeFileSync(join(home, 'remote'), '[user]\nemail = conditional@example.invalid\n');
      writeFileSync(
        join(home, '.gitconfig'),
        `[includeIf "gitdir:${gitdir}"]\npath = conditional\n` +
          '[includeIf "hasconfig:remote.*.url:https://example.invalid/owner/**"]\npath = remote\n'
      );
      const session = new Session(createConfig(), createSilentLogger(), cwd);
      bind(session, true);
      expect(commitIdentity(cwd, shellEnv(session))).toBe(
        'Conditional Owner <conditional@example.invalid>|Conditional Owner <conditional@example.invalid>'
      );
    }
  );

  it('keeps owner env precedence and reports missing identity through Git', () => {
    const session = new Session(
      createConfig({
        env: {
          GIT_AUTHOR_NAME: 'Explicit Author',
          GIT_AUTHOR_EMAIL: 'author@example.invalid',
          GIT_COMMITTER_NAME: 'Explicit Committer',
          GIT_COMMITTER_EMAIL: 'committer@example.invalid',
        },
      }),
      createSilentLogger(),
      repo
    );
    bind(session, false);
    commitIdentity(repo, shellEnv(session));
    bind(session, true);
    expect(commitIdentity(repo, shellEnv(session))).toBe(
      'Explicit Author <author@example.invalid>|Explicit Committer <committer@example.invalid>'
    );
    git(repo, process.env, 'config', '--remove-section', 'user');
    writeFileSync(join(home, '.gitconfig'), '[user]\nuseConfigOnly = true\n');
    const unconfigured = new Session(createConfig(), createSilentLogger(), repo);
    bind(unconfigured, true);
    expect(() => commitIdentity(repo, shellEnv(unconfigured))).toThrow();
  });

  it.each([true, false])(
    'binds ACP launch env and keeps its existing snapshot (owner=%s)',
    async (owner) => {
      let captured: NodeJS.ProcessEnv | undefined;
      const stopped = new Error('captured ACP launch');
      const session = new Session(createConfig(), createSilentLogger(), repo, {
        ...createNoopSessionSandbox(),
        spawn: async (_command, _args, options) => {
          captured = options.env;
          throw stopped;
        },
      });
      bind(session, owner);
      await expect(
        session.createAgent({
          cliType: 'registry',
          agentType: 'opencode',
          command: 'opencode',
          args: ['acp'],
        } as CreateAgentConfig)
      ).rejects.toBe(stopped);
      if (!captured) throw new Error('ACP environment was not captured');
      const ownerIdentity = 'Repo Owner <repo@example.invalid>|Repo Owner <repo@example.invalid>';
      const memberIdentity = 'Member <member@example.invalid>|Member <member@example.invalid>';
      expect(commitIdentity(repo, captured)).toBe(owner ? ownerIdentity : memberIdentity);
      bind(session, !owner);
      expect(commitIdentity(repo, shellEnv(session))).toBe(owner ? memberIdentity : ownerIdentity);
      expect(commitIdentity(repo, captured)).toBe(owner ? ownerIdentity : memberIdentity);
    }
  );

  it.each(['native', 'managed'] as const)(
    'disables member signing after env overrides and restores native owner settings (%s)',
    (mode) => {
      for (const [key, value] of [
        ['commit.gpgsign', 'true'],
        ['tag.gpgsign', 'true'],
        ['user.signingkey', 'synthetic-owner-key'],
        ['gpg.program', join(root, 'missing-signer')],
      ])
        git(repo, process.env, 'config', key, value);
      const originalConfig = readFileSync(join(repo, '.git', 'config'), 'utf8');
      const config = createConfig({
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: 'synthetic-helper',
        },
      });
      const credentials: SessionCredentials | undefined =
        mode === 'native'
          ? undefined
          : {
              mode: 'managed',
              release: async () => {},
              lease: {
                context: {
                  sessionId: 'session-1' as SessionId,
                  requesterUserId: 'user-1',
                  machineId: 'machine-1',
                },
                contextToken: 'synthetic-context',
                contextFilePath: undefined,
                stateFilePath: undefined,
                allowLocalAuth: true,
                active: true,
                revoke: () => {},
              },
            };
      const session = new Session(config, createSilentLogger(), repo, undefined, credentials);
      bind(session, false);
      const env = shellEnv(session, {
        GIT_AUTHOR_EMAIL: 'override@example.invalid',
        GIT_COMMITTER_EMAIL: 'override@example.invalid',
      });
      expect(commitIdentity(repo, env)).toBe(
        'Member <member@example.invalid>|Member <member@example.invalid>'
      );
      git(repo, env, 'tag', '-am', 'synthetic unsigned tag', 'member-tag');
      expect(git(repo, env, 'config', '--get', 'user.signingkey')).toBe('');
      expect(git(repo, env, 'config', '--get', 'credential.helper')).toBe('synthetic-helper');
      expect(shellEnv(session).GIT_CONFIG_COUNT).toBe(env.GIT_CONFIG_COUNT);
      bind(session, false, '');
      expect(commitIdentity(repo, shellEnv(session))).toBe(
        'LodyAI <agent@lody.ai>|LodyAI <agent@lody.ai>'
      );
      bind(session, true);
      const ownerEnv = shellEnv(session);
      expect(ownerEnv.GIT_CONFIG_COUNT).toBe('1');
      expect(ownerEnv.GIT_AUTHOR_EMAIL).toBeUndefined();
      expect(git(repo, ownerEnv, 'config', '--get', 'user.signingkey')).toBe('synthetic-owner-key');
      expect(() => commitIdentity(repo, ownerEnv)).toThrow();
      expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(originalConfig);
    }
  );
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
