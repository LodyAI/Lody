import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureGhShimScript,
  getGhShimHostBinDir,
  getGhShimHostPath,
} from '../src/lib/gh-shim-script';
import { getGhTokenFingerprint, LODY_MANAGED_GH_TOKEN_SHA256_ENV } from '../src/lib/gh-token-env';

let tempHomeDir: string | null = null;
let fakeBinDir: string | null = null;
let tokenBroker: http.Server | null = null;
let brokerRequestCount = 0;
let brokerRequests: unknown[] = [];

const originalPath = process.env.PATH ?? '';
// Full workspace test runs can heavily delay Node child startup/close on CI.
const SHIM_INTEGRATION_TIMEOUT_MS = 150_000;
const SHIM_CHILD_TIMEOUT_MS = 120_000;

beforeEach(() => {
  tempHomeDir = mkdtempSync(path.join(os.tmpdir(), 'lody-gh-shim-home-'));
  fakeBinDir = mkdtempSync(path.join(os.tmpdir(), 'lody-gh-shim-bin-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tempHomeDir);
  vi.stubEnv('PATH', `${fakeBinDir}${path.delimiter}${originalPath}`);
  brokerRequestCount = 0;
  brokerRequests = [];

  writeFakeGh(
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  if [ -n "$GH_TOKEN$GITHUB_TOKEN$GH_ENTERPRISE_TOKEN$GITHUB_ENTERPRISE_TOKEN" ] || [ "$FAKE_GH_AUTHED" = "1" ]; then exit 0; fi
  exit 1
fi
if [ "$1" = "api" ] && [ "$4" = "user" ]; then
  if [ -n "$FAKE_GH_PROBE_ERROR" ]; then printf '%s' "$FAKE_GH_PROBE_ERROR" >&2; exit 1; fi
  if [ "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}" = "expired-token" ] || [ "$FAKE_GH_LOCAL_INVALID" = "1" ]; then
    printf 'gh: Bad credentials (HTTP 401)' >&2; exit 1
  fi
  exit 0
fi
if [ -n "$FAKE_GH_EXEC_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_GH_EXEC_LOG"; fi
if [ -n "$FAKE_GH_COMMAND_ERROR" ]; then printf '%s' "$FAKE_GH_COMMAND_ERROR" >&2; exit 1; fi
if [ "$1" = "print-token" ]; then
  printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN:-}"
  printf 'GITHUB_TOKEN=%s\\n' "\${GITHUB_TOKEN:-}"
  printf 'MARKER=%s\\n' "\${${LODY_MANAGED_GH_TOKEN_SHA256_ENV}:-}"
  exit 0
fi
printf '%s\\n' "$*"
`
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tokenBroker) {
    await new Promise<void>((resolve) => tokenBroker?.close(() => resolve()));
    tokenBroker = null;
  }
  if (tempHomeDir) {
    rmSync(tempHomeDir, { recursive: true, force: true });
    tempHomeDir = null;
  }
  if (fakeBinDir) {
    rmSync(fakeBinDir, { recursive: true, force: true });
    fakeBinDir = null;
  }
});

describe('ensureGhShimScript', () => {
  it('generates a gh wrapper without PR association behavior', () => {
    ensureGhShimScript();

    const source = readFileSync(getGhShimHostPath(), 'utf8');

    expect(source).toContain('/github-token');
    expect(source).not.toContain('associatePullRequestForCli');
    expect(source).not.toContain('pr create');
  });

  it('generates a Windows gh.cmd launcher that points at the Node shim', () => {
    const restorePlatform = setPlatformForTest('win32');
    try {
      writeFakeGhNamed('gh.cmd', '@echo off\r\n');
      ensureGhShimScript();

      const launcherPath = getGhShimHostPath();
      const launcherSource = readFileSync(launcherPath, 'utf8');
      const nodeShimPath = path.join(getGhShimHostBinDir(), 'gh');
      const nodeShimSource = readFileSync(nodeShimPath, 'utf8');

      expect(launcherPath).toMatch(/gh\.cmd$/i);
      expect(launcherSource).toContain(process.execPath);
      expect(launcherSource).toContain('%~dp0gh');
      expect(nodeShimSource).toContain('/github-token');
      expect(nodeShimSource).toContain(path.join(fakeBinDir!, 'gh.cmd'));
    } finally {
      restorePlatform();
    }
  });

  it(
    'fetches a fresh installation token when the session has no gh auth',
    async () => {
      const broker = await startTokenBroker('installation-token');
      ensureGhShimScript();

      const result = await runShim({
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=installation-token');
      expect(result.stdout).toContain('GITHUB_TOKEN=installation-token');
      expect(brokerRequestCount).toBe(1);
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );

  it(
    'preserves a user-provided GH_TOKEN and does not call the broker',
    async () => {
      const broker = await startTokenBroker('installation-token');
      ensureGhShimScript();

      const result = await runShim({
        GH_TOKEN: 'user-token',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=user-token');
      expect(result.stdout).toContain('GITHUB_TOKEN=');
      expect(brokerRequestCount).toBe(0);
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );

  it(
    'clears a managed GH_TOKEN while preserving a user-provided GITHUB_TOKEN',
    async () => {
      const broker = await startTokenBroker('installation-token');
      const managedToken = 'old-lody-token';
      ensureGhShimScript();

      const result = await runShim({
        GH_TOKEN: managedToken,
        GITHUB_TOKEN: 'user-github-token',
        [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint(managedToken),
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=');
      expect(result.stdout).toContain('GITHUB_TOKEN=user-github-token');
      expect(result.stdout).not.toContain(managedToken);
      expect(brokerRequestCount).toBe(0);
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );

  it(
    'uses the broker token before ambient gh auth for managed repo sessions',
    async () => {
      const broker = await startTokenBroker('installation-token');
      const managedToken = 'old-lody-token';
      ensureGhShimScript();

      const result = await runShim({
        FAKE_GH_AUTHED: '1',
        GH_TOKEN: managedToken,
        [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint(managedToken),
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=installation-token');
      expect(result.stdout).toContain('GITHUB_TOKEN=installation-token');
      expect(result.stdout).not.toContain(managedToken);
      expect(brokerRequestCount).toBe(1);
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );

  it(
    'fails closed when the broker rejects the requester context',
    async () => {
      const broker = await startTokenBroker('ignored-token', { contextStatus: 403 });
      const managedToken = 'old-lody-token';
      ensureGhShimScript();

      const result = await runShim({
        GH_TOKEN: managedToken,
        [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint(managedToken),
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GIT_CRED_CONTEXT_TOKEN: 'stale-context',
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('context is unavailable or expired');
      expect(brokerRequestCount).toBe(0);
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );
  it('prefers the owner local login over an inherited managed token', async () => {
    const broker = await startTokenBroker('app-token', { allowLocalAuth: true });
    ensureGhShimScript();
    const result = await runShim({
      FAKE_GH_AUTHED: '1',
      GH_TOKEN: 'stale-token',
      [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint('stale-token'),
      LODY_GIT_CRED_CONTEXT_TOKEN: 'owner-context',
      LODY_GIT_CRED_BROKER_URL: broker.url,
      LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
      LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('GH_TOKEN=\nGITHUB_TOKEN=\nMARKER=\n');
    expect(brokerRequestCount).toBe(0);
  });

  it.each([{ GH_TOKEN: 'expired-token' }, { FAKE_GH_AUTHED: '1', FAKE_GH_LOCAL_INVALID: '1' }, {}])(
    'falls back for absent or revoked owner credentials: %j',
    async (credentials) => {
      const broker = await startTokenBroker('app-token', { allowLocalAuth: true });
      ensureGhShimScript();
      const result = await runShim({
        ...credentials,
        LODY_GIT_CRED_CONTEXT_TOKEN: 'owner-context',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=app-token');
      expect(brokerRequestCount).toBe(1);
    }
  );

  it('tries GITHUB_TOKEN after a revoked GH_TOKEN without changing the parent env', async () => {
    ensureGhShimScript();
    const env = { GH_TOKEN: 'expired-token', GITHUB_TOKEN: 'user-token' };
    const result = await runShim(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GH_TOKEN=\nGITHUB_TOKEN=user-token');
    expect(env.GH_TOKEN).toBe('expired-token');
  });

  it.each(['HTTP 403', 'HTTP 429', 'HTTP 500', 'network unavailable'])(
    'preserves local identity on %s and runs a failed write exactly once',
    async (error) => {
      const broker = await startTokenBroker('app-token', { allowLocalAuth: true });
      ensureGhShimScript();
      const log = path.join(tempHomeDir!, 'executed');
      const result = await runShim(
        {
          FAKE_GH_AUTHED: '1',
          FAKE_GH_PROBE_ERROR: error,
          FAKE_GH_COMMAND_ERROR: 'HTTP 401',
          FAKE_GH_EXEC_LOG: log,
          LODY_GIT_CRED_CONTEXT_TOKEN: 'owner-context',
          LODY_GIT_CRED_BROKER_URL: broker.url,
          LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
          LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
        },
        ['pr', 'create']
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('HTTP 401');
      expect(readFileSync(log, 'utf8')).toBe('pr create\n');
      expect(brokerRequestCount).toBe(0);
    }
  );

  it('never falls back to the host login when managed credentials are unavailable', async () => {
    const broker = await startTokenBroker('ignored', { status: 403 });
    ensureGhShimScript();
    const result = await runShim({
      FAKE_GH_AUTHED: '1',
      LODY_GIT_CRED_CONTEXT_TOKEN: 'teammate-context',
      LODY_GIT_CRED_BROKER_URL: broker.url,
      LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
      LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['--repo', 'enterprise.example/owner/repo'],
    ['--repo=https://enterprise.example/owner/repo'],
  ])('does not inject github.com credentials for %j', async (...args) => {
    const broker = await startTokenBroker('app-token', { allowLocalAuth: true });
    ensureGhShimScript();
    const result = await runShim(
      {
        LODY_GIT_CRED_CONTEXT_TOKEN: 'owner-context',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      },
      ['print-token', ...args]
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('app-token');
    expect(brokerRequestCount).toBe(0);
  });

  it('keeps local-project sessions on the host login without a cloud context', async () => {
    ensureGhShimScript();
    const result = await runShim({ LODY_SESSION_ID: 'local-session', FAKE_GH_AUTHED: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('GH_TOKEN=\nGITHUB_TOKEN=\nMARKER=\n');
  });

  it.each([
    ['api', '--hostname', 'other.ghe.com', 'repos/owner/repo/issues'],
    ['api', 'https://other.ghe.com/repos/owner/repo/issues'],
    ['pr', 'view', 'https://other.ghe.com/owner/repo/pull/1'],
    ['issue', 'view', 'https://other.ghe.com/owner/repo/issues/1'],
  ])('keeps an explicit command host ahead of github.com repo context: %j', async (...args) => {
    const broker = await startTokenBroker('app-token', { allowLocalAuth: true });
    ensureGhShimScript();
    const result = await runShim(
      {
        GH_REPO: 'github.com/loro-dev/lody',
        LODY_GIT_CRED_CONTEXT_TOKEN: 'owner-context',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      },
      args
    );
    expect(result.status).toBe(0);
    expect(brokerRequestCount).toBe(0);
  });

  it.each(['https', 'http'])('rejects a teammate PR URL after flags (%s)', async (protocol) => {
    const broker = await startTokenBroker('app-token');
    ensureGhShimScript();
    const result = await runShim(
      {
        FAKE_GH_AUTHED: '1',
        LODY_GIT_CRED_CONTEXT_TOKEN: 'teammate-context',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      },
      ['pr', 'view', '--json', 'title', `${protocol}://other.ghe.com/owner/repo/pull/1`]
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No managed GitHub credential');
    expect(brokerRequestCount).toBe(0);
  });

  it.each([
    [
      'pr',
      'comment',
      '--body',
      'https://github.com/loro-dev/lody/pull/1',
      'https://other.ghe.com/owner/repo/pull/2',
    ],
    ['pr', 'comment', '--body', 'https://github.com/loro-dev/lody/pull/1', '2'],
  ])('does not mistake a body URL for the target in a teammate session: %j', async (...args) => {
    const broker = await startTokenBroker('app-token');
    ensureGhShimScript();
    const result = await runShim(
      {
        FAKE_GH_AUTHED: '1',
        GH_REPO: 'other.ghe.com/owner/repo',
        LODY_GIT_CRED_CONTEXT_TOKEN: 'teammate-context',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      },
      args
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Cannot determine the GitHub target');
    expect(brokerRequestCount).toBe(0);
  });

  it('lets native gh resolve ambiguous owner command arguments without an App token', async () => {
    const broker = await startTokenBroker('app-token', { allowLocalAuth: true });
    ensureGhShimScript();
    const args = ['pr', 'comment', '--body', 'https://github.com/loro-dev/lody/pull/1', '2'];
    const result = await runShim(
      {
        LODY_GIT_CRED_CONTEXT_TOKEN: 'owner-context',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      },
      args
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(args.join(' ') + '\n');
    expect(brokerRequestCount).toBe(0);
  });

  it('resolves gh api repo placeholders before requesting a managed token', async () => {
    const broker = await startTokenBroker('app-token');
    ensureGhShimScript();
    const result = await runShim(
      {
        GH_REPO: 'loro-dev/lody',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      },
      ['api', 'repos/{owner}/{repo}/releases']
    );
    expect(result.status).toBe(0);
    expect(brokerRequestCount).toBe(1);
    expect(brokerRequests).toEqual([{ repoFullName: 'loro-dev/lody' }]);
  });

  it('allows the owner to log in without injecting managed credentials', async () => {
    const broker = await startTokenBroker('app-token', { allowLocalAuth: true });
    ensureGhShimScript();
    const result = await runShim(
      {
        LODY_GIT_CRED_CONTEXT_TOKEN: 'owner-context',
        LODY_GIT_CRED_BROKER_URL: broker.url,
        LODY_GIT_CRED_BROKER_TOKEN: broker.authToken,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      },
      ['auth', 'login']
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('auth login\n');
    expect(brokerRequestCount).toBe(0);
  });
});

const writeFakeGh = (source: string): void => {
  writeFakeGhNamed('gh', source);
};

const writeFakeGhNamed = (name: string, source: string): void => {
  if (!fakeBinDir) {
    throw new Error('fakeBinDir is not initialized');
  }
  writeFileSync(path.join(fakeBinDir, name), source, { encoding: 'utf8', mode: 0o755 });
};

const setPlatformForTest = (platform: NodeJS.Platform): (() => void) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  return () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  };
};

const runShim = async (
  env: Record<string, string | undefined>,
  args: string[] = ['print-token']
): Promise<{ status: number | null; stdout: string; stderr: string }> => {
  const shimPath = getGhShimHostPath();
  const shimBinDir = getGhShimHostBinDir();
  if (!fakeBinDir) {
    throw new Error('fakeBinDir is not initialized');
  }
  if (!tempHomeDir) {
    throw new Error('tempHomeDir is not initialized');
  }

  const childEnv: NodeJS.ProcessEnv = {
    HOME: tempHomeDir,
    PATH: [shimBinDir, fakeBinDir, path.dirname(process.execPath)].join(path.delimiter),
  };
  if (process.platform === 'win32') {
    childEnv.USERPROFILE = tempHomeDir;
    childEnv.SystemRoot = process.env.SystemRoot;
    childEnv.ComSpec = process.env.ComSpec;
    childEnv.PATHEXT = process.env.PATHEXT;
  }
  Object.assign(childEnv, env);

  const child = spawn(process.execPath, [shimPath, ...args], {
    env: childEnv,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const status = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() =>
        reject(
          new Error(
            `gh shim did not exit within ${SHIM_CHILD_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        )
      );
    }, SHIM_CHILD_TIMEOUT_MS);

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => resolve(code)));
  });
  return { status, stdout, stderr };
};

const startTokenBroker = async (
  token: string,
  options?: { status?: number; allowLocalAuth?: boolean; contextStatus?: number }
): Promise<{ url: string; authToken: string }> => {
  const authToken = 'broker-auth-token';
  tokenBroker = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      res.setHeader('Connection', 'close');
      if (
        req.url === '/github-auth-context' &&
        req.headers.authorization === `Bearer ${authToken}`
      ) {
        res.writeHead(options?.contextStatus ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allowLocalAuth: options?.allowLocalAuth ?? false }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/github-token') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${authToken}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      brokerRequestCount += 1;
      brokerRequests.push(JSON.parse(body));
      if (options?.status && options.status !== 200) {
        res.writeHead(options.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_context' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    tokenBroker?.once('error', reject);
    tokenBroker?.listen(0, '127.0.0.1', () => resolve());
  });

  const address = tokenBroker.address();
  if (!address || typeof address === 'string') {
    throw new Error('broker did not bind to a TCP port');
  }
  return { url: `http://127.0.0.1:${address.port}`, authToken };
};
