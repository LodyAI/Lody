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
import {
  getGhTokenFingerprint,
  LODY_MANAGED_GH_TOKEN_SHA256_ENV,
} from '../src/lib/gh-token-injector';

let tempHomeDir: string | null = null;
let fakeBinDir: string | null = null;
let tokenBroker: http.Server | null = null;
let brokerRequestCount = 0;

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

  writeFakeGh(
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "$FAKE_GH_AUTHED" = "1" ]; then
    exit 0
  fi
  exit 1
fi
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
    "recovers through the session's broker state file after the broker restarts",
    async () => {
      // A restarted broker listens on a new port. The session env still names the old
      // one; only the per-workspace state file carries the new address.
      const broker = await startTokenBroker('restarted-broker-token');
      const deadUrl = await reserveClosedLoopbackUrl();
      const stateFile = path.join(tempHomeDir ?? '', 'broker-workspace-a.json');
      writeFileSync(stateFile, JSON.stringify({ url: broker.url, token: broker.authToken }));
      ensureGhShimScript();

      const result = await runShim({
        LODY_GIT_CRED_BROKER_URL: deadUrl,
        LODY_GIT_CRED_BROKER_TOKEN: 'stale-broker-auth',
        LODY_GIT_CRED_BROKER_STATE_FILE: stateFile,
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=restarted-broker-token');
      expect(result.stderr).toBe('');
      expect(brokerRequestCount).toBe(1);
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );

  it(
    'names the unreachable broker on stderr instead of failing silently',
    async () => {
      const deadUrl = await reserveClosedLoopbackUrl();
      ensureGhShimScript();

      const result = await runShim({
        LODY_GIT_CRED_BROKER_URL: deadUrl,
        LODY_GIT_CRED_BROKER_TOKEN: 'stale-broker-auth',
        LODY_GITHUB_REPO_FULL_NAME: 'loro-dev/lody',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=\n');
      expect(result.stderr).toContain(`credential broker unreachable at ${deadUrl}`);
      expect(result.stderr).toContain('ECONNREFUSED');
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );

  it(
    'clears stale managed tokens when the broker rejects the requester context',
    async () => {
      const broker = await startTokenBroker('ignored-token', { status: 403 });
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

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('GH_TOKEN=');
      expect(result.stdout).toContain('GITHUB_TOKEN=');
      expect(result.stdout).not.toContain(managedToken);
      expect(brokerRequestCount).toBe(1);
    },
    SHIM_INTEGRATION_TIMEOUT_MS
  );
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
  env: Record<string, string>
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

  const child = spawn(process.execPath, [shimPath, 'print-token'], {
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

// Binds and closes a loopback port so connecting to it is refused deterministically.
const reserveClosedLoopbackUrl = async (): Promise<string> => {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') {
    throw new Error('probe server did not bind to a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
};

const startTokenBroker = async (
  token: string,
  options?: { status?: number }
): Promise<{ url: string; authToken: string }> => {
  const authToken = 'broker-auth-token';
  tokenBroker = http.createServer((req, res) => {
    req.resume();
    res.setHeader('Connection', 'close');
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
    if (options?.status && options.status !== 200) {
      res.writeHead(options.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_context' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token }));
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
