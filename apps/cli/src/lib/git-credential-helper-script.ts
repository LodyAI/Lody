import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { RepoId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { githubCredentialRuntime } from './github-credential-runtime';

const HELPER_BASENAME = 'lody-git-credential-helper.cjs';

const helperSource = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
let context;
const getContext = () => context ??= readCredentialContext(fs, process.env.LODY_GIT_CRED_BROKER_STATE_FILE, process.env);
const requestBroker = async (endpoint, body, timeoutMs) => {
  const file = process.env.LODY_GIT_CRED_BROKER_STATE_FILE;
  if (!file) throw credentialError('broker_state_missing');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.url || !config.token) throw credentialError('broker_state_invalid');
  return fetch(config.url + endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
};
${githubCredentialRuntime}

const localCredential = async (request, repo) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LODY_GIT_LOCAL_DELEGATE: '1' };
  // Restore native Git's system/global/repository helper chain. Never forward
  // managed "store": Git broadcasts it to all configured credential helpers.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key];
  }
  Object.assign(env, JSON.parse(process.env.LODY_GIT_LOCAL_CONFIG || '{}'));
  const input = Object.entries(request).map(([key, value]) => key + '=' + value).join('\n') + '\n\n';
  const result = spawnSync('git', ['credential', 'fill'], {
    input, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (!fields.username || !fields.password) return null;
  return { token: fields.password, username: fields.username };
};

const main = async () => {
  const action = process.argv[2] || 'get';
  if (process.env.LODY_GIT_LOCAL_DELEGATE === '1') return;
  // Injected credentials are ephemeral: store never reaches the local keychain.
  if (!['get', 'erase', 'reject'].includes(action)) return;
  const input = fs.readFileSync(0, 'utf8');
  const request = {};
  for (const line of input.split(/\r?\n/)) {
    if (!line) break;
    const index = line.indexOf('=');
    if (index > 0) request[line.slice(0, index)] = line.slice(index + 1);
  }
  if (request.protocol !== 'https' || !['github.com', 'github.com:443', 'www.github.com'].includes(request.host)) return;
  const repo = String(request.path || '').replace(/^\/+|\/+$/g, '').split('/').slice(0, 2).join('/').replace(/\.git$/i, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return;
  if (action !== 'get') {
    await requestBroker('/git-credential/reject', {
      repoFullName: repo, contextToken: getContext().contextToken, invalidatedToken: request.password,
    }, 2000);
    return;
  }
  const policy = await readCredentialPolicy();
  const credential = await selectGitHubCredential(repo, policy, () => localCredential(request, repo), process.env.LODY_GIT_OPERATION === 'write');
  if (!credential.token || /[\r\n]/.test(credential.token)) throw new Error('Invalid GitHub credential.');
  process.stdout.write('username=' + (credential.username || 'x-access-token') + '\npassword=' + credential.token + '\n\n');
};
main().catch(error => {
  diagnostic('git-helper', 'failed', error);
  process.stdout.write('quit=true\n\n');
  process.exitCode = 1;
});
`;

export const getCredentialHelperHostPath = (repoId: RepoId): string =>
  path.join(getLodyDataDir(), 'repos', repoId, HELPER_BASENAME);

export const getCredentialHelperContainerPath = (repoId: RepoId): string =>
  `/workspaces/${repoId}/${HELPER_BASENAME}`;

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, '\n');

export const ensureCredentialHelperScript = (repoId: RepoId): void => {
  ensureCredentialHelperAtPath(getCredentialHelperHostPath(repoId));
};

export const ensureCredentialHelperAtPath = (filePath: string): void => {
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

export const buildCredentialHelperValueForPath = (filePath: string): string =>
  `!node "${escapeForGitHelper(filePath)}"`;
