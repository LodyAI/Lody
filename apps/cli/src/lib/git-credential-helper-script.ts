import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { RepoId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const HELPER_BASENAME = 'lody-git-credential-helper.cjs';

const helperSource = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// Normalize Git host so helper behavior stays consistent with WorktreeManager.
// We intentionally accept "www.github.com" because some clone URLs include it.
const normalizeHost = (rawHost) => {
  const value = String(rawHost || '').trim().toLowerCase();
  if (!value) return '';
  const withoutPort = value.includes(':') ? value.split(':')[0] : value;
  if (withoutPort === 'www.github.com') return 'github.com';
  return withoutPort;
};

const isTruthyEnv = (value) => {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const debugEnabled = isTruthyEnv(process.env.LODY_GIT_CRED_HELPER_DEBUG);
const debugFile = process.env.LODY_GIT_CRED_HELPER_DEBUG_FILE;

const debug = (event, data) => {
  if (!debugEnabled || !debugFile) return;
  try {
    const payload = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      data: data || {},
    };
    fs.appendFileSync(debugFile, JSON.stringify(payload) + '\\n', 'utf8');
  } catch {
    // ignore debug write errors
  }
};

// Broker state file paths - check both container and host locations.
// LODY_GIT_CRED_BROKER_STATE_FILE, when set, names the state file of the broker
// owned by THIS session's workspace and must win: the shared broker.json is
// last-writer-wins across the workspaces of a fleet process, so falling back to
// it can recover onto another workspace's broker and token manager.
const BROKER_STATE_PATHS = [
  process.env.LODY_GIT_CRED_BROKER_STATE_FILE,
  '/home/node/.lody/broker.json',  // Container path
  path.join(
    process.env.LODY_DATA_DIR ||
      path.join(os.homedir(), process.env.LODY_PLATFORM === 'local' ? '.lody-oss' : '.lody'),
    'broker.json'
  ), // Host path (native mode)
].filter(Boolean);

/**
 * Read broker config from state file only.
 * Used as fallback when env var URL fails.
 */
const getBrokerConfigFromFile = () => {
  for (const statePath of BROKER_STATE_PATHS) {
    try {
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf8');
        const state = JSON.parse(content);
        if (state && state.url && state.token) {
          debug('broker_config', { source: 'state_file', path: statePath, url: state.url });
          return { url: state.url, token: state.token, source: 'file' };
        }
      }
    } catch {
      // Ignore errors, try next path
    }
  }
  return null;
};

/**
 * Read broker config from env vars or state file.
 *
 * Priority: env vars > state file
 *
 * Env vars are preferred because:
 * 1. In Docker containers on macOS/Windows, the state file contains 127.0.0.1
 *    which points to the container itself, not the host where the broker runs.
 * 2. The CLI sets LODY_GIT_CRED_BROKER_URL to a Docker-reachable address
 *    (e.g., host.docker.internal) for containers.
 * 3. The state file is still useful as a fallback for native mode or when
 *    the CLI restarts and env vars aren't re-injected.
 */
const getBrokerConfig = () => {
  // Prefer environment variables - they contain the correct Docker-reachable URL
  // when running in containers on macOS/Windows (host.docker.internal vs 127.0.0.1)
  const envUrl = process.env.LODY_GIT_CRED_BROKER_URL;
  const envToken = process.env.LODY_GIT_CRED_BROKER_TOKEN;
  if (envUrl && envToken) {
    debug('broker_config', { source: 'env_var', url: envUrl });
    return { url: envUrl, token: envToken, source: 'env' };
  }

  // Fall back to state file for native mode or CLI restart scenarios
  const fileConfig = getBrokerConfigFromFile();
  if (!fileConfig) {
    debug('broker_config', { source: 'none' });
  }
  return fileConfig;
};

const getContextToken = () => {
  const value = process.env.LODY_GIT_CRED_CONTEXT_TOKEN;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * Check if an error is a connection error (ECONNREFUSED, ENOTFOUND, etc.)
 * that indicates the broker URL is stale and we should try the fallback.
 */
const isConnectionError = (error) => {
  if (!error) return false;
  const code = error.code || (error.cause && error.cause.code);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return true;
  }
  // Also check error message for connection-related errors
  const message = String(error.message || '').toLowerCase();
  return message.includes('econnrefused') || message.includes('enotfound') || message.includes('fetch failed');
};

const readRequest = async () => {
  const entries = {};
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = String(line || '').trim();
      if (!trimmed) break;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx);
      const value = trimmed.slice(idx + 1);
      if (!key) continue;
      entries[key] = value;
    }
  } finally {
    rl.close();
  }
  return entries;
};

const normalizeRepoPath = (rawPath) => {
  const cleaned = String(rawPath || '').replace(/^\\/+/, '').replace(/\\/+$/, '');
  if (!cleaned) return null;
  const withoutGit = cleaned.replace(/\\.git$/i, '');
  const parts = withoutGit.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return null;
  return \`\${owner}/\${repo}\`;
};

const main = async () => {
  const action = process.argv[2];
  const isRejectAction = action === 'erase' || action === 'reject';
  if (action && action !== 'get' && !isRejectAction) {
    debug('skip', { reason: 'unsupported_action', action });
    return;
  }

  const req = await readRequest();
  const normalizedHost = normalizeHost(req.host);
  debug('request', { protocol: req.protocol, host: req.host, normalizedHost, path: req.path });
  if (req.protocol !== 'https') {
    debug('skip', { reason: 'unsupported_protocol', protocol: req.protocol });
    return;
  }
  if (normalizedHost !== 'github.com') {
    debug('skip', { reason: 'unsupported_host', host: req.host, normalizedHost });
    return;
  }
  if (!req.path) {
    debug('skip', { reason: 'missing_path' });
    return;
  }

  const repoFullName = normalizeRepoPath(req.path);
  if (!repoFullName) {
    debug('skip', { reason: 'unparseable_repo_path', path: req.path });
    return;
  }

  const brokerConfig = getBrokerConfig();
  if (!brokerConfig) {
    debug('skip', { reason: 'missing_broker_config', repoFullName });
    return;
  }

  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    debug('skip', { reason: 'missing_fetch' });
    return;
  }

  const tryBrokerRequest = async (baseUrl, token, endpoint, body) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      debug('fetch', { repoFullName, baseUrl, endpoint });
      const res = await fetchImpl(\`\${baseUrl}\${endpoint}\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: \`Bearer \${token}\`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      debug('fetch_response', { repoFullName, status: res && res.status, ok: !!(res && res.ok) });
      if (!res || !res.ok) return { success: false };

      let json;
      try {
        json = await res.json();
      } catch {
        debug('parse_error', { repoFullName, reason: 'invalid_json' });
        return { success: false };
      }

      return { success: true, json };
    } catch (error) {
      debug('fetch_error', { repoFullName, error: error && error.message });
      return { success: false, error };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  /**
   * Attempt to fetch credentials from a broker URL.
   * Returns { success: true, json } on success, { success: false, error } on connection error,
   * or { success: false } on other failures.
   */
  const tryFetchFromBroker = async (baseUrl, token) => {
    const contextToken = getContextToken();
    const result = await tryBrokerRequest(baseUrl, token, '/git-credential', {
      repoFullName,
      ...(contextToken ? { contextToken } : {}),
    });
    if (!result.success) return result;

    const json = result.json;
    if (!json || typeof json.username !== 'string' || typeof json.password !== 'string') {
      return { success: false };
    }
    if (!json.username || !json.password) return { success: false };

    return result;
  };

  const tryRejectFromBroker = async (baseUrl, token) => {
    const invalidatedToken = typeof req.password === 'string' ? req.password : undefined;
    const contextToken = getContextToken();
    return tryBrokerRequest(baseUrl, token, '/git-credential/reject', {
      repoFullName,
      ...(contextToken ? { contextToken } : {}),
      ...(invalidatedToken ? { invalidatedToken } : {}),
    });
  };

  const { url: baseUrl, token, source } = brokerConfig;
  let result = isRejectAction
    ? await tryRejectFromBroker(baseUrl, token)
    : await tryFetchFromBroker(baseUrl, token);

  // If we had a connection error and we were using env vars, try the file fallback
  // This handles the case where the broker restarted on a different port
  if (!result.success && result.error && source === 'env' && isConnectionError(result.error)) {
    const fileConfig = getBrokerConfigFromFile();
    if (fileConfig && fileConfig.url !== baseUrl) {
      debug('fallback', { from: baseUrl, to: fileConfig.url });
      result = isRejectAction
        ? await tryRejectFromBroker(fileConfig.url, fileConfig.token)
        : await tryFetchFromBroker(fileConfig.url, fileConfig.token);
    }
  }

  if (isRejectAction) {
    debug(result.success ? 'reject_success' : 'reject_failed', { repoFullName });
    return;
  }

  if (!result.success || !result.json) {
    return;
  }

  debug('success', { repoFullName });
  process.stdout.write(\`username=\${result.json.username}\\npassword=\${result.json.password}\\n\\n\`);
};

main().catch(() => {});
`;

export const getCredentialHelperHostPath = (repoId: RepoId): string =>
  path.join(getLodyDataDir(), 'repos', repoId, HELPER_BASENAME);

export const getCredentialHelperContainerPath = (repoId: RepoId): string =>
  `/workspaces/${repoId}/${HELPER_BASENAME}`;

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, '\n');

export const ensureCredentialHelperScript = (repoId: RepoId): void => {
  const filePath = getCredentialHelperHostPath(repoId);
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  if (existsSync(filePath)) {
    try {
      const current = normalizeNewlines(readFileSync(filePath, 'utf8'));
      if (current === normalizeNewlines(helperSource)) {
        return;
      }
    } catch {
      // fall through and rewrite
    }
  }

  writeFileSync(filePath, helperSource, { encoding: 'utf8', mode: 0o755 });
};

const escapeForGitHelper = (value: string): string => value.replace(/"/g, '\\"');

export const buildCredentialHelperValueForHost = (repoId: RepoId): string => {
  const helperPath = escapeForGitHelper(getCredentialHelperHostPath(repoId));
  return `!node "${helperPath}"`;
};

export const buildCredentialHelperValueForContainer = (repoId: RepoId): string => {
  const helperPath = escapeForGitHelper(getCredentialHelperContainerPath(repoId));
  return `!node "${helperPath}"`;
};
