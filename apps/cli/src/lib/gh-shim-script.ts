import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'fs';
import { writeIfChanged } from './shell-file-utils';
import path from 'path';

import { LODY_MANAGED_GH_TOKEN_SHA256_ENV } from '@/lib/gh-token-env';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const GH_SHIM_POSIX_BASENAME = 'gh';
const GH_SHIM_WINDOWS_BASENAME = 'gh.cmd';
const REAL_GH_PATH_PLACEHOLDER = '__LODY_REAL_GH_PATH__';
const NODE_EXEC_PATH_PLACEHOLDER = '__LODY_NODE_EXEC_PATH__';
const MANAGED_TOKEN_MARKER_ENV = LODY_MANAGED_GH_TOKEN_SHA256_ENV;

const getWindowsExecutableCandidateNames = (name: string): string[] =>
  ['.exe', '.cmd', '.bat', '.com'].map((ext) => `${name}${ext}`).concat(name);

const normalizeComparablePath = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const toComparablePath = (value: string): string => {
  try {
    return normalizeComparablePath(realpathSync.native(value));
  } catch {
    return normalizeComparablePath(value);
  }
};

const isExecutableFile = (filePath: string): boolean => {
  try {
    if (!statSync(filePath).isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveExecutableFromPath = (name: string, excludedPath: string): string | null => {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return null;
  }

  const excludedComparablePath = toComparablePath(excludedPath);
  const excludedComparableDir = toComparablePath(path.dirname(excludedPath));
  const candidateNames =
    process.platform === 'win32' ? getWindowsExecutableCandidateNames(name) : [name];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }

    const comparableDir = toComparablePath(dir);
    if (comparableDir === excludedComparableDir) {
      continue;
    }

    for (const candidateName of candidateNames) {
      const candidatePath = path.join(dir, candidateName);
      if (!isExecutableFile(candidatePath)) {
        continue;
      }
      if (toComparablePath(candidatePath) === excludedComparablePath) {
        continue;
      }
      return candidatePath;
    }
  }

  return null;
};

const wrapperSourceTemplate = `#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REAL_GH_PATH = '${REAL_GH_PATH_PLACEHOLDER}';
const SHIM_PATH = __filename;
const SHIM_DIR = path.dirname(SHIM_PATH);
const MANAGED_TOKEN_MARKER_ENV = '${MANAGED_TOKEN_MARKER_ENV}';
const WINDOWS_EXECUTABLE_CANDIDATE_NAMES = ['gh.exe', 'gh.cmd', 'gh.bat', 'gh.com', 'gh'];

const normalizeComparablePath = (value) => {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const toComparablePath = (value) => {
  if (!value) return '';
  try {
    return normalizeComparablePath(fs.realpathSync.native(String(value)));
  } catch {
    return normalizeComparablePath(String(value));
  }
};

const isExecutableFile = (filePath) => {
  if (!filePath) return false;
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveGhFromPath = () => {
  const pathEnv = String(process.env.PATH || '');
  if (!pathEnv) return null;

  const shimComparablePath = toComparablePath(SHIM_PATH);
  const shimComparableDir = toComparablePath(SHIM_DIR);
  const candidateNames =
    process.platform === 'win32' ? WINDOWS_EXECUTABLE_CANDIDATE_NAMES : ['gh'];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (toComparablePath(dir) === shimComparableDir) continue;

    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      if (!isExecutableFile(candidate)) continue;
      if (toComparablePath(candidate) === shimComparablePath) continue;
      return candidate;
    }
  }

  return null;
};

const resolveRealGhCommand = () => {
  if (REAL_GH_PATH && isExecutableFile(REAL_GH_PATH)) {
    return REAL_GH_PATH;
  }
  return resolveGhFromPath();
};

const quoteCmdArg = (arg) => {
  const value = String(arg || '');
  if (value === '') return '""';
  if (!/[\\s"]/u.test(value)) return value;
  return '"' + value.replace(/"/g, '""') + '"';
};

const buildWindowsSpawnSpec = (command, args) => {
  const lower = String(command || '').toLowerCase();
  if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    const cmdline = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ');
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', cmdline] };
  }
  return { command, args };
};

const spawnGh = (command, args, options) => {
  const spec = buildWindowsSpawnSpec(command, args);
  return spawn(spec.command, spec.args, { windowsHide: true, ...options });
};

const runGhCommand = (command, args, options) => new Promise((resolve) => {
  const spec = buildWindowsSpawnSpec(command, args);
  const timeoutMs = Number(options && options.timeout) || 0;
  const child = spawn(spec.command, spec.args, {
    windowsHide: true,
    ...options,
    timeout: undefined,
  });
  let stdout = '';
  let stderr = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk) => { stderr += String(chunk || '').slice(0, 20000 - stderr.length); });
  }
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
  }
  let settled = false;
  let timeoutId = null;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timeoutId) clearTimeout(timeoutId);
    resolve({ stdout, stderr, ...result });
  };
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // best effort
      }
      finish({ status: null, error: new Error('Command timed out') });
    }, timeoutMs);
  }
  child.on('error', (error) => finish({ status: null, error }));
  child.on('close', (code) => finish({ status: code == null ? null : code }));
});

const fingerprintToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const isManagedTokenValue = (token, marker) => {
  if (!token || !marker) return false;
  return fingerprintToken(String(token)) === String(marker);
};

const hasManagedEnvToken = (env) => {
  const marker = env[MANAGED_TOKEN_MARKER_ENV];
  return (
    isManagedTokenValue(env.GH_TOKEN, marker) ||
    isManagedTokenValue(env.GITHUB_TOKEN, marker)
  );
};

const clearManagedTokenEnv = (env) => {
  if (!hasManagedEnvToken(env)) return;
  const marker = env[MANAGED_TOKEN_MARKER_ENV];
  if (isManagedTokenValue(env.GH_TOKEN, marker)) delete env.GH_TOKEN;
  if (isManagedTokenValue(env.GITHUB_TOKEN, marker)) delete env.GITHUB_TOKEN;
  delete env[MANAGED_TOKEN_MARKER_ENV];
};

const injectGhToken = (env, token) => {
  if (!token) return;
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
  env[MANAGED_TOKEN_MARKER_ENV] = fingerprintToken(token);
};

// Keep authentication checks on the real executable and this invocation's env.
// auth token checks local availability without a network request. /user then
// distinguishes revoked credentials (401) from transient/permission errors.
const hasUsableGhAuth = async (ghPath, env, host) => {
  const available = await runGhCommand(ghPath, ['auth', 'token', '--hostname', host], {
    env, stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000,
  });
  if (available.error) throw new Error('Unable to inspect local GitHub credentials.');
  if (available.status !== 0) return false;
  const check = await runGhCommand(ghPath, ['api', '--hostname', host, 'user', '--silent'], {
    env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000,
  });
  if (check.status === 0) return true;
  if (!check.error && /\\bHTTP 401\\b/i.test(check.stderr)) return false;
  // A token may authenticate APIs that /user does not permit (e.g. installation
  // tokens). Preserve this identity on 403, rate limits and network failures;
  // the real command reports its own error and is never replayed.
  return true;
};

const readGitRemoteOrigin = async () => {
  try {
    const result = await runGhCommand('git', ['remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
};

const readFlag = (args, long, short) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === long || (short && arg === short)) return args[i + 1];
    if (arg.startsWith(long + '=')) return arg.slice(long.length + 1);
    if (short && arg.startsWith(short) && arg.length > short.length) return arg.slice(short.length);
  }
  return null;
};

const parseRepo = (raw, defaultHost) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  let host = defaultHost;
  let repo = value;
  if (/^https?:\\/\\//i.test(value) || value.startsWith('ssh://')) {
    try { const url = new URL(value); host = url.hostname; repo = url.pathname.slice(1); }
    catch { return null; }
  } else if (value.startsWith('git@')) {
    const match = value.match(/^git@([^:]+):(.+)$/);
    if (!match) return null;
    host = match[1]; repo = match[2];
  } else if (value.split('/').length === 3) {
    const parts = value.split('/'); host = parts.shift(); repo = parts.join('/');
  }
  repo = repo.replace(/\\.git$/, '').replace(/\\/$/, '');
  return /^[\\w.-]+\\/[\\w.-]+$/.test(repo) ? { host: host.toLowerCase(), repo } : null;
};

const readGitHubTarget = async (args) => {
  const host = String(readFlag(args, '--hostname') || process.env.GH_HOST || 'github.com').toLowerCase();
  if (args[0] === 'api') {
    const endpoint = args.find((arg) => /^(\\/?repos\\/|https?:\\/\\/)/.test(arg));
    if (endpoint) {
      const url = endpoint.startsWith('http') ? new URL(endpoint) : null;
      const apiHost = url ? (url.hostname === 'api.github.com' ? 'github.com' : url.hostname) : host;
      const match = (url ? url.pathname : endpoint).match(/^\\/?repos\\/([^/]+\\/[^/?#]+)/);
      let repo = match ? match[1] : null;
      if (repo && repo.includes('{')) {
        const context = parseRepo(process.env.GH_REPO || await readGitRemoteOrigin() || process.env.LODY_GITHUB_REPO_FULL_NAME, host);
        if (context) {
          const [owner, name] = context.repo.split('/');
          repo = repo.replace('{owner}', owner).replace('{repo}', name);
        }
      }
      return { host: apiHost, repo: repo && !repo.includes('{') ? repo : null };
    }
    // API calls honor GH_HOST/--hostname, not a git remote's hostname.
    return { host, repo: process.env.LODY_GITHUB_REPO_FULL_NAME || null };
  }
  // gh pr/issue commands accept a URL that overrides the current repository.
  const subjectUrls = args.filter((arg) => /^https?:\\/\\/[^/]+\\/[^/]+\\/[^/]+\\/(pull|issues)\\//i.test(arg));
  // A URL-valued --body/--template is not necessarily the command's target.
  // Do not guess an identity when multiple URLs or an option value are present.
  if (subjectUrls.length > 1 || subjectUrls.some((url) => {
    const previous = args[args.indexOf(url) - 1];
    return previous && previous !== '--' && previous.startsWith('-');
  })) return { host: null, repo: null };
  const subject = subjectUrls[0] || args[2];
  if (subject && /^https?:\\/\\//i.test(subject)) {
    try {
      const url = new URL(subject);
      const repoPath = url.pathname.split('/').slice(1, 3).join('/');
      return parseRepo(repoPath, url.hostname) || { host: url.hostname, repo: null };
    } catch { return { host, repo: null }; }
  }
  const explicitRepo = readFlag(args, '--repo', '-R') || process.env.GH_REPO;
  if (explicitRepo) return parseRepo(explicitRepo, host) || { host, repo: null };
  return parseRepo(await readGitRemoteOrigin(), host) ||
    parseRepo(process.env.LODY_GITHUB_REPO_FULL_NAME || process.env.GITHUB_REPOSITORY, host) ||
    { host, repo: null };
};

const BROKER_STATE_PATHS = process.env.LODY_GIT_CRED_BROKER_STATE_FILE
  ? [process.env.LODY_GIT_CRED_BROKER_STATE_FILE]
  : [
  '/home/node/.lody/broker.json',
  path.join(
    process.env.LODY_DATA_DIR ||
      path.join(os.homedir(), process.env.LODY_PLATFORM === 'local' ? '.lody-oss' : '.lody'),
    'broker.json'
  ),
];

const getBrokerConfigFromFile = () => {
  for (const statePath of BROKER_STATE_PATHS) {
    try {
      if (!fs.existsSync(statePath)) continue;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state && typeof state.url === 'string' && typeof state.token === 'string') {
        return { url: state.url, token: state.token, source: 'file' };
      }
    } catch {
      // Try the next state path.
    }
  }
  return null;
};

const getBrokerConfig = () => {
  const envUrl = process.env.LODY_GIT_CRED_BROKER_URL;
  const envToken = process.env.LODY_GIT_CRED_BROKER_TOKEN;
  if (envUrl && envToken) {
    return { url: envUrl, token: envToken, source: 'env' };
  }
  return getBrokerConfigFromFile();
};

const getContextToken = () => {
  const value = process.env.LODY_GIT_CRED_CONTEXT_TOKEN;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const isConnectionError = (error) => {
  if (!error) return false;
  const code = error.code || (error.cause && error.cause.code);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return true;
  }
  const message = String(error.message || '').toLowerCase();
  return message.includes('econnrefused') || message.includes('enotfound') || message.includes('fetch failed');
};

const doBrokerRequest = async (baseUrl, brokerToken, endpoint, body, timeoutMs) => {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { unavailable: true };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(baseUrl + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + brokerToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { res };
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timeoutId);
  }
};

const doFetchFromBroker = async (baseUrl, brokerToken, repoFullName, contextToken) => {
  const reply = await doBrokerRequest(
    baseUrl,
    brokerToken,
    '/github-token',
    { repoFullName, ...(contextToken ? { contextToken } : {}) },
    10000
  );
  if (reply.unavailable) return { result: null };
  if (reply.error) return { error: reply.error };
  if (!reply.res.ok) return { result: null };
  const json = await reply.res.json().catch(() => null);
  if (!json || typeof json.token !== 'string' || !json.token) {
    return { result: null };
  }
  return { result: { token: json.token } };
};

const doRejectToBroker = async (
  baseUrl,
  brokerToken,
  repoFullName,
  invalidatedToken,
  contextToken
) => {
  // Short timeout: the gh shim awaits this before exiting, so a slow broker would stall
  // the user. The next gh invocation will re-trigger reject if delivery here fails.
  const reply = await doBrokerRequest(
    baseUrl,
    brokerToken,
    '/github-token/reject',
    {
      repoFullName,
      ...(contextToken ? { contextToken } : {}),
      ...(invalidatedToken ? { invalidatedToken } : {}),
    },
    2000
  );
  if (reply.unavailable) return { result: false };
  if (reply.error) return { error: reply.error };
  return { result: reply.res.ok };
};

const callBrokerWithFallback = async (action) => {
  const brokerConfig = getBrokerConfig();
  if (!brokerConfig) return null;

  const { url, token, source } = brokerConfig;
  const first = await action(url, token);
  if (first.result !== undefined) return first;

  if (first.error && source === 'env' && isConnectionError(first.error)) {
    const fileConfig = getBrokerConfigFromFile();
    if (fileConfig && fileConfig.url !== url) {
      return await action(fileConfig.url, fileConfig.token);
    }
  }
  return first;
};

const fetchTokenFromBroker = async (repoFullName) => {
  const contextToken = getContextToken();
  const reply = await callBrokerWithFallback((url, token) =>
    doFetchFromBroker(url, token, repoFullName, contextToken)
  );
  return reply && reply.result ? reply.result : null;
};

const rejectTokenToBroker = async (repoFullName, invalidatedToken) => {
  const contextToken = getContextToken();
  await callBrokerWithFallback((url, token) =>
    doRejectToBroker(url, token, repoFullName, invalidatedToken, contextToken)
  );
};

const GH_AUTH_FAILURE_PHRASES = [
  'http 401',
  '401 unauthorized',
  'bad credentials',
  'requires authentication',
  'authentication failed',
];

const isGhAuthFailureOutput = (stderrText) => {
  const value = String(stderrText || '').toLowerCase();
  return GH_AUTH_FAILURE_PHRASES.some((phrase) => value.includes(phrase));
};

const mayUseLocalAuth = async () => {
  const contextToken = getContextToken();
  if (!contextToken) {
    // Old managed sessions without context must not adopt the machine owner's login.
    return !process.env.LODY_GITHUB_REPO_FULL_NAME;
  }
  const reply = await callBrokerWithFallback(async (url, token) => {
    const response = await doBrokerRequest(url, token, '/github-auth-context', { contextToken }, 5000);
    if (response.error) return { error: response.error };
    if (!response.res || !response.res.ok) return { result: null };
    const body = await response.res.json().catch(() => null);
    return { result: body && typeof body.allowLocalAuth === 'boolean' ? body : null };
  });
  if (!reply || !reply.result) throw new Error('GitHub credential context is unavailable or expired.');
  return reply.result.allowLocalAuth;
};

const buildGhEnv = async (ghCommand, args) => {
  const env = { ...process.env };
  clearManagedTokenEnv(env);
  // Authentication management must reach the owner's real gh unchanged, even
  // when no login exists yet; injecting an App token prevents gh auth login.
  if (args[0] === 'auth' && await mayUseLocalAuth()) return { env };
  const target = await readGitHubTarget(args);
  if (!target.host) {
    // The owner's native gh can resolve ambiguous arguments itself. A shared
    // session must stop rather than risk selecting another host's credentials.
    if (await mayUseLocalAuth()) return { env };
    throw new Error('Cannot determine the GitHub target safely for this session.');
  }
  const tokenKeys = target.host === 'github.com' || target.host.endsWith('.ghe.com')
    ? ['GH_TOKEN', 'GITHUB_TOKEN'] : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  // Try explicit credentials in gh's precedence order. Only a definitive 401
  // allows the next credential; never retry the user's actual command.
  for (const key of tokenKeys) {
    if (!env[key]) continue;
    if (await hasUsableGhAuth(ghCommand, env, target.host)) return { env };
    delete env[key];
  }
  const allowLocalAuth = await mayUseLocalAuth();
  if (allowLocalAuth && await hasUsableGhAuth(ghCommand, env, target.host)) return { env };

  // Lody's installation credentials belong exclusively to github.com.
  if (target.host === 'github.com' && target.repo) {
    const result = await fetchTokenFromBroker(target.repo);
    if (result && result.token) {
      injectGhToken(env, result.token);
      return { env, managed: { token: result.token, repoFullName: target.repo } };
    }
  }
  if (!allowLocalAuth) throw new Error('No managed GitHub credential is available for this session.');
  return { env };
};

const main = async () => {
  const ghCommand = resolveRealGhCommand();
  if (!ghCommand) {
    console.error('gh CLI not found. Please install it from https://cli.github.com/');
    process.exit(127);
  }

  const ghEnv = await buildGhEnv(ghCommand, process.argv.slice(2));
  const child = spawnGh(ghCommand, process.argv.slice(2), {
    stdio: ['inherit', 'inherit', 'pipe'],
    env: ghEnv.env,
  });
  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '');
    process.stderr.write(chunk);
    if (stderrText.length < 20000) {
      stderrText += text.slice(0, 20000 - stderrText.length);
    }
  });

  child.on('error', () => process.exit(127));
  child.on('close', (code, signal) => {
    void (async () => {
      if (code && ghEnv.managed && isGhAuthFailureOutput(stderrText)) {
        await rejectTokenToBroker(ghEnv.managed.repoFullName, ghEnv.managed.token);
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    })();
  });
};

main().catch((error) => { console.error(error.message); process.exit(1); });
`;

const windowsLauncherSourceTemplate = `@echo off
"${NODE_EXEC_PATH_PLACEHOLDER}" "%~dp0gh" %*
`;

export const getGhShimHostBinDir = (): string => path.join(getLodyDataDir(), 'bin');

const getGhShimHostNodeScriptPath = (): string =>
  path.join(getGhShimHostBinDir(), GH_SHIM_POSIX_BASENAME);

const getGhShimHostWindowsLauncherPath = (): string =>
  path.join(getGhShimHostBinDir(), GH_SHIM_WINDOWS_BASENAME);

export const getGhShimHostPath = (): string =>
  process.platform === 'win32' ? getGhShimHostWindowsLauncherPath() : getGhShimHostNodeScriptPath();

const escapeForSingleQuotedString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const escapeForDoubleQuotedCmdString = (value: string): string => value.replace(/"/g, '""');

const buildGhShimSource = (realGhPath: string | null): string => {
  const escapedRealPath = realGhPath ? escapeForSingleQuotedString(realGhPath) : '';
  return wrapperSourceTemplate.split(REAL_GH_PATH_PLACEHOLDER).join(escapedRealPath);
};

const buildWindowsLauncherSource = (): string =>
  windowsLauncherSourceTemplate
    .split(NODE_EXEC_PATH_PLACEHOLDER)
    .join(escapeForDoubleQuotedCmdString(process.execPath));

const resolveRealGhPath = (): string | null => resolveExecutableFromPath('gh', getGhShimHostPath());

const ensureParentDirForFile = (filePath: string): void => {
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
    return;
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? (error.code as string | undefined) : undefined;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    const linkStat = lstatSync(dir);
    if (linkStat.isSymbolicLink()) {
      unlinkSync(dir);
    }
  } catch {
    // Best effort repair for stale legacy local setup.
  }

  mkdirSync(dir, { recursive: true });
};

const ensureWritableShimTarget = (filePath: string): void => {
  try {
    const entry = lstatSync(filePath);
    if (!entry.isSymbolicLink()) {
      return;
    }
    unlinkSync(filePath);
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? (error.code as string | undefined) : undefined;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }
};

export const ensureGhShimScript = (): void => {
  const source = buildGhShimSource(resolveRealGhPath());
  const shimTargets =
    process.platform === 'win32'
      ? [
          { filePath: getGhShimHostNodeScriptPath(), content: source },
          { filePath: getGhShimHostWindowsLauncherPath(), content: buildWindowsLauncherSource() },
        ]
      : [{ filePath: getGhShimHostNodeScriptPath(), content: source }];

  for (const { filePath, content } of shimTargets) {
    ensureParentDirForFile(filePath);
    ensureWritableShimTarget(filePath);

    try {
      writeIfChanged(filePath, content, 0o755);
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? (error.code as string | undefined) : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
      ensureParentDirForFile(filePath);
      writeIfChanged(filePath, content, 0o755);
    }
  }
};

export const prependGhShimBinDirToPath = (pathEnv: string | undefined): string => {
  const shimBinDir = getGhShimHostBinDir();
  const entries = (pathEnv ?? '').split(path.delimiter).filter(Boolean);
  const shimComparableDir = toComparablePath(shimBinDir);
  const filtered = entries.filter((entry) => toComparablePath(entry) !== shimComparableDir);
  return [shimBinDir, ...filtered].join(path.delimiter);
};
