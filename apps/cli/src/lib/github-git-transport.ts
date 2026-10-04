import path from 'node:path';
import { existsSync, readdirSync, symlinkSync, linkSync, copyFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeIfChanged } from './shell-file-utils';
import { githubCredentialRuntime } from './github-credential-runtime';

/** Native Git discovers these adapters through GIT_EXEC_PATH; URLs stay ordinary HTTPS. */
export function ensureGitHubGitTransport(
  directory: string,
  statePath: string,
  realGit: string
): void {
  const execPath = execFileSync(realGit, ['--exec-path'], { encoding: 'utf8' }).trim();
  const coreGit = path.join(execPath, process.platform === 'win32' ? 'git.exe' : 'git');
  const nativeGit = existsSync(coreGit) ? coreGit : realGit;
  writeIfChanged(path.join(directory, 'package.json'), '{"type":"commonjs"}\n');
  const source = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const REAL_GIT = ${JSON.stringify(nativeGit)};
const EXEC_PATH = ${JSON.stringify(execPath)};
const STATE_PATH = ${JSON.stringify(statePath)};
${githubCredentialRuntime}
let context;
const getContext = () => context ??= readCredentialContext(fs, STATE_PATH, process.env);
const requestBroker = (endpoint, body, timeoutMs) => {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return fetch(state.url + endpoint, { method: 'POST', redirect: 'error',
    headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
};
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const nativeEnv = () => {
  const env = { ...process.env, GIT_EXEC_PATH: EXEC_PATH, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LODY_GIT_NATIVE: '1' };
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  Object.assign(env, JSON.parse(process.env.LODY_GIT_LOCAL_CONFIG || '{}'));
  return env;
};
const authenticatedEnv = (url, token) => {
  const env = nativeEnv();
  const options = ['credential.helper=', 'credential.' + url + '.helper=',
    'http.extraHeader=', 'http.' + url + '.extraHeader=',
    'http.' + url + '.extraHeader=' + (token ? 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64') : 'Authorization:'),
    'http.cookieFile=', 'http.' + url + '.cookieFile=', 'http.saveCookies=false',
    'http.followRedirects=false'];
  env.GIT_CONFIG_PARAMETERS = [env.GIT_CONFIG_PARAMETERS, ...options.map(quote)].filter(Boolean).join(' ');
  env.GIT_ASKPASS = ''; env.SSH_ASKPASS = '';
  return env;
};
const delegate = (args, env) => {
  const child = spawn(REAL_GIT, args, { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { diagnostic('transport', 'spawn', error); process.exitCode = 1; });
  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
};
const main = async () => {
  const target = String(process.argv[3] || '');
  let url;
  try { url = new URL(target); } catch { throw credentialError('invalid_remote'); }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    delegate(['remote-' + url.protocol.slice(0, -1), ...process.argv.slice(2)], nativeEnv());
    return;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw credentialError('unsupported_github_url');
  const repo = url.pathname.replace(/^\//, '').replace(/\/?$/, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw credentialError('invalid_repository');
  const sshPort = /^https:\/\/github\.com:443\//i.test(target) ? ' -p 443' : '';
  const httpsUrl = 'https://github.com/' + repo + '.git';
  const policy = readCredentialPolicy();
  // Missing operation context is conservative (e.g. /usr/bin/git bypassed PATH).
  const write = process.env.LODY_GIT_OPERATION !== 'read';
  const local = async () => {
    const env = nativeEnv();
    const header = spawnSync(REAL_GIT, ['config', '--get-urlmatch', 'http.extraHeader', httpsUrl], { env, encoding: 'utf8' });
    const auth = (header.stdout || '').split(/\r?\n/).find(line => /^authorization:/i.test(line));
    if (auth) {
      const basic = /^authorization:\s*basic\s+(.+)$/i.exec(auth);
      const bearer = /^authorization:\s*bearer\s+(.+)$/i.exec(auth);
      const token = basic ? Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':') : bearer?.[1];
      if (token) return { token };
      throw credentialError('unsupported_local_header');
    }
    const fill = spawnSync(REAL_GIT, ['credential', 'fill'], { env: { ...env, LODY_GIT_LOCAL_DELEGATE: '1' }, input: 'protocol=https\nhost=github.com\npath=' + repo + '.git\n\n', encoding: 'utf8', timeout: 3000 });
    if (fill.error) throw fill.error;
    const token = /^password=(.*)$/m.exec(fill.stdout || '')?.[1];
    if (token) return { token };
    // Native SSH is the machine's last local mechanism, not a different identity.
    return { token: null, ssh: true };
  };
  const verify = async candidate => {
    const env = candidate.ssh ? nativeEnv() : authenticatedEnv(httpsUrl, candidate.token);
    if (candidate.ssh) {
      const configured = spawnSync(REAL_GIT, ['config', '--get', 'core.sshCommand'], { env, encoding: 'utf8' });
      env.GIT_SSH_COMMAND = (env.GIT_SSH_COMMAND || configured.stdout?.trim() || (env.GIT_SSH ? quote(env.GIT_SSH) : 'ssh')) + sshPort + ' -oBatchMode=yes -oConnectTimeout=3';
    }
    // Native upload/receive-pack advertisement has no write effects. It lets
    // denied credentials fall through without replaying an uncertain push.
    const target = candidate.ssh ? (sshPort ? 'ssh://git@ssh.github.com:443/' : 'git@github.com:') + repo + '.git' : httpsUrl;
    const args = candidate.ssh ? ['ls-remote', ...(write ? ['--upload-pack=git-receive-pack'] : []), target] : ['remote-https', 'lody-advertisement', target];
    const result = spawnSync(REAL_GIT, args, {
      env, input: candidate.ssh ? undefined : (write ? 'list for-push\n\n' : 'list\n\n'), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'ignore', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr || '';
      const status = /(?:error:|HTTP)\s*(401|403|404|429|500|502|503|504)/i.exec(stderr)?.[1];
      const reasons = [
        [/Could not resolve|Name or service not known|nodename nor servname/i, 'dns_lookup_failed'],
        [/SSL certificate|certificate verify|unable to get local issuer/i, 'tls_verification_failed'],
        [/timed out|timeout/i, 'timeout'],
        [/Failed to connect|Connection refused|Could not connect/i, 'connection_failed'],
        [/Host key verification failed/i, 'ssh_host_key_rejected'],
        [/Authentication failed|Permission denied|not found|denied to|403|401/i, 'access_denied'],
      ];
      const code = reasons.find(([pattern]) => pattern.test(stderr))?.[1] || 'git_advertisement_failed';
      throw credentialError(code, { status: status ? Number(status) : undefined });
    }
    candidate.env = env;
    return true;
  };
  const selected = await selectGitHubCredential(repo, policy, local, write, async () => true, verify);
  if (selected.ssh) {
    const ssh = selected.env.GIT_SSH_COMMAND;
    const command = ssh + (sshPort ? ' git@ssh.github.com' : ' git@github.com') + ' "$1" "$2"';
    delegate(['remote-ext', process.argv[2], 'sh -c ' + command.replace(/%/g, '%%').replace(/ /g, '% ') + ' lody %S ' + repo + '.git'], selected.env);
  } else delegate(['remote-https', process.argv[2], httpsUrl], selected.env);
};
main().catch(error => { diagnostic('git', 'failed', error); process.exitCode = 1; });
`;
  // Git shell subcommands source support files by GIT_EXEC_PATH, not PATH.
  // Expose the installed distribution alongside the two native helper adapters.
  for (const name of readdirSync(execPath)) {
    if (['git', 'git-remote-http', 'git-remote-https'].includes(name.replace(/\.exe$/, '')))
      continue;
    const target = path.join(directory, name);
    if (existsSync(target)) continue;
    const original = path.join(execPath, name);
    try {
      symlinkSync(original, target);
    } catch {
      if (!lstatSync(original).isFile()) continue;
      try {
        linkSync(original, target);
      } catch {
        copyFileSync(original, target);
      }
    }
  }
  for (const name of ['git-remote-https', 'git-remote-http']) {
    writeIfChanged(path.join(directory, name), source, 0o755);
  }
  writeIfChanged(
    path.join(directory, 'git'),
    String.raw`#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const args = process.argv.slice(2);
let command;
for (let i = 0; i < args.length; i++) {
  if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(args[i])) { i++; continue; }
  if (!args[i].startsWith('-')) { command = args[i]; break; }
}
const reads = ['fetch', 'clone', 'pull', 'ls-remote', 'submodule'];
const operation = reads.includes(command) ? 'read' : 'write';
const env = process.env.LODY_GIT_NATIVE === '1' ? process.env : {
  ...process.env, GIT_EXEC_PATH: __dirname,
  PATH: process.env.PATH + path.delimiter + ${JSON.stringify(execPath)},
  LODY_GIT_OPERATION: operation,
};
const child = spawn(${JSON.stringify(nativeGit)}, args, { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error('[Lody GitHub] git spawn: ' + (error.code || 'unknown')); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
`,
    0o755
  );
  if (process.platform === 'win32') {
    writeIfChanged(
      path.join(directory, 'git.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0git" %*\r\n`
    );
  }
}
