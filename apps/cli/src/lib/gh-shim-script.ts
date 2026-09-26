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

import { LODY_MANAGED_GH_TOKEN_SHA256_ENV } from '@/lib/gh-token-injector';
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
    resolve({ stdout, ...result });
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

const hasUserProvidedEnvToken = (env) => {
  const marker = env[MANAGED_TOKEN_MARKER_ENV];
  const tokens = [env.GH_TOKEN, env.GITHUB_TOKEN].filter(Boolean);
  return tokens.some((token) => !isManagedTokenValue(String(token), marker));
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

const buildGhAuthEnv = (env) => {
  const nextEnv = { ...env };
  delete nextEnv.GH_TOKEN;
  delete nextEnv.GITHUB_TOKEN;
  delete nextEnv[MANAGED_TOKEN_MARKER_ENV];
  return nextEnv;
};

const isGhCliAuthed = async (ghPath) => {
  if (!ghPath) return false;
  try {
    const result = await runGhCommand(ghPath, ['auth', 'status'], {
      env: buildGhAuthEnv(process.env),
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
};

const parseRepoFromUrl = (raw) => {
  const value = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!value) return null;

  const https = value.match(/^https?:\\/\\/github\\.com\\/(.+)$/i);
  if (https && https[1]) {
    const withoutQuery = https[1].split('?')[0].split('#')[0];
    const withoutGit = withoutQuery.replace(/\\.git$/i, '');
    const parts = withoutGit.split('/').filter(Boolean);
    if (parts.length >= 2) return parts[0] + '/' + parts[1];
  }

  const ssh = value.match(/^git@github\\.com:(.+)$/i);
  if (ssh && ssh[1]) {
    const withoutGit = ssh[1].replace(/\\.git$/i, '');
    const parts = withoutGit.split('/').filter(Boolean);
    if (parts.length >= 2) return parts[0] + '/' + parts[1];
  }

  const direct = value.replace(/\\.git$/i, '');
  const parts = direct.split('/').filter(Boolean);
  if (parts.length === 2 && !parts[0].includes(':')) {
    return parts[0] + '/' + parts[1];
  }

  return null;
};

const readGitRemoteOrigin = async () => {
  try {
    const result = await runGhCommand('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    if (!result || result.status !== 0) return null;
    return String(result.stdout || '').trim() || null;
  } catch {
    return null;
  }
};

const readRepoFullName = async () => {
  const fromEnv =
    process.env.LODY_GITHUB_REPO_FULL_NAME ||
    process.env.GITHUB_REPOSITORY ||
    process.env.GH_REPO;
  return parseRepoFromUrl(fromEnv) || parseRepoFromUrl(await readGitRemoteOrigin());
};

// LODY_GIT_CRED_BROKER_STATE_FILE names THIS session's workspace broker and must win,
// exactly as in the git credential helper: the shared broker.json is last-writer-wins
// across a fleet's workspaces, and a restarted broker only updates the state files.
const BROKER_STATE_PATHS = [
  process.env.LODY_GIT_CRED_BROKER_STATE_FILE,
  '/home/node/.lody/broker.json',
  path.join(
    process.env.LODY_DATA_DIR ||
      path.join(os.homedir(), process.env.LODY_PLATFORM === 'local' ? '.lody-oss' : '.lody'),
    'broker.json'
  ),
].filter(Boolean);

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
      const second = await action(fileConfig.url, fileConfig.token);
      if (second.error) reportBrokerUnreachable([url, fileConfig.url], second.error);
      return second;
    }
  }
  if (first.error) reportBrokerUnreachable([url], first.error);
  return first;
};

// Without this line a dead broker is indistinguishable from "not logged in": gh runs
// without a managed token and 'gh auth status' reports no account.
const reportBrokerUnreachable = (urls, error) => {
  const code = (error && (error.code || (error.cause && error.cause.code))) || '';
  const reason = code || String((error && error.message) || error);
  process.stderr.write(
    'lody gh: credential broker unreachable at ' + urls.join(', then ') + ' (' + reason +
      '); running gh without a Lody-managed token.\\n'
  );
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

const buildGhEnv = async (ghCommand) => {
  const env = { ...process.env };
  if (hasUserProvidedEnvToken(env)) {
    clearManagedTokenEnv(env);
    return { env };
  }

  const repoFullName = await readRepoFullName();
  const hasBroker = !!getBrokerConfig();
  if (repoFullName && hasBroker) {
    const result = await fetchTokenFromBroker(repoFullName);
    if (result && result.token) {
      injectGhToken(env, result.token);
      return { env, managed: { token: result.token, repoFullName } };
    }
    clearManagedTokenEnv(env);
    return { env };
  }

  if (await isGhCliAuthed(ghCommand)) {
    clearManagedTokenEnv(env);
    return { env };
  }
  return { env };
};

const main = async () => {
  const ghCommand = resolveRealGhCommand();
  if (!ghCommand) {
    console.error('gh CLI not found. Please install it from https://cli.github.com/');
    process.exit(127);
  }

  const ghEnv = await buildGhEnv(ghCommand);
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

main().catch(() => process.exit(1));
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
