import path from 'node:path';
import { writeIfChanged } from './shell-file-utils';
import { githubCredentialRuntime } from './github-credential-runtime';

/** Git remote helpers run once per actual remote, including nested submodules. */
export function ensureGitHubGitTransport(
  directory: string,
  statePath: string,
  realGit: string
): void {
  writeIfChanged(path.join(directory, 'package.json'), '{"type":"commonjs"}\n');
  const source = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const REAL_GIT = ${JSON.stringify(realGit)};
const STATE_PATH = ${JSON.stringify(statePath)};
const capturedContextToken = (() => {
  if (process.env.LODY_GIT_CRED_CONTEXT_FILE) {
    try { return JSON.parse(fs.readFileSync(process.env.LODY_GIT_CRED_CONTEXT_FILE, 'utf8')).contextToken || null; } catch { return null; }
  }
  return process.env.LODY_GIT_CRED_CONTEXT_TOKEN || null;
})();
const getContextToken = () => capturedContextToken;
const requestBroker = async (endpoint, body, timeoutMs) => {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return fetch(state.url + endpoint, {
    method: 'POST', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
};
${githubCredentialRuntime}
const nativeEnv = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LODY_GITHUB_SSH_PROBE: '1' };
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  Object.assign(env, JSON.parse(process.env.LODY_GIT_LOCAL_CONFIG || '{}'));
  return env;
};
const main = async () => {
  if (process.env.LODY_GITHUB_SSH_PROBE) throw new Error('Recursive GitHub SSH transport configuration.');
  const target = String(process.argv[3] || '');
  const https = target.startsWith('https/');
  const ssh443 = target.startsWith('ssh443/');
  const repo = target.replace(/^(https|ssh443)\//, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid GitHub SSH repository.');
  const url = 'https://github.com/' + repo + '.git';
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const localEnv = nativeEnv();
  const configuredSsh = spawnSync(REAL_GIT, ['config', '--get', 'core.sshCommand'], { env: localEnv, encoding: 'utf8' });
  const ssh = localEnv.GIT_SSH_COMMAND || configuredSsh.stdout?.trim() || (localEnv.GIT_SSH ? quote(localEnv.GIT_SSH) : 'ssh');
  const sshHost = ssh443 ? 'git@ssh.github.com' : 'git@github.com';
  const sshPort = ssh443 ? ' -p 443' : '';
  const policy = await readCredentialPolicy();
  const selection = await selectGitHubCredential(repo, policy, async () => {
    if (https) {
      // Headers can authenticate before Git ever calls a credential helper.
      // Inspect them only inside the owner-local branch of the selector.
      const headers = spawnSync(REAL_GIT, ['config', '--get-urlmatch', 'http.extraHeader', url], { env: localEnv, encoding: 'utf8' });
      let token;
      const auth = (headers.stdout || '').split(/\r?\n/).find(line => /^authorization:/i.test(line));
      if (auth) {
        const basic = /^authorization:\s*basic\s+(.+)$/i.exec(auth);
        const bearer = /^authorization:\s*bearer\s+(.+)$/i.exec(auth);
        token = basic ? Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':') : bearer?.[1];
        if (!token) throw new Error('Unsupported local GitHub authorization header.');
      } else {
        const fill = spawnSync(REAL_GIT, ['credential', 'fill'], { env: { ...localEnv, GCM_INTERACTIVE: 'never', LODY_GIT_LOCAL_DELEGATE: '1' }, input: 'protocol=https\nhost=github.com\npath=' + repo + '.git\n\n', encoding: 'utf8', timeout: 5000 });
        if (fill.error) throw new Error('Local Git credential lookup failed; identity was not changed.');
        token = /^password=(.*)$/m.exec(fill.stdout || '')?.[1];
      }
      if (!token) return null;
      const access = await checkRepositoryCredential(token, repo, process.env.LODY_GIT_OPERATION === 'write');
      return access === 'usable' ? { token } : null;
    }
    // Read-only SSH advertisement proves access without replaying a push.
    // Batch mode prevents a shared daemon from prompting for owner credentials.
    const env = { ...localEnv, GIT_SSH_COMMAND: ssh + ' -oBatchMode=yes -oConnectTimeout=5' };
    const probe = spawnSync(REAL_GIT, ['ls-remote', ...(process.env.LODY_GIT_OPERATION === 'write' ? ['--upload-pack=git-receive-pack'] : []), ssh443 ? 'ssh://git@ssh.github.com:443/' + repo + '.git' : 'git@github.com:' + repo + '.git'], {
      env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (probe.status === 0) return { token: null };
    if (!probe.error && /Permission denied \(publickey\)|Repository not found|write access to repository not granted|marked as read only|Permission to [^\r\n]+ denied to/i.test(probe.stderr)) return null;
    throw new Error('Local SSH access could not be checked; identity was not changed.');
  }, process.env.LODY_GIT_OPERATION === 'write', async () => {
    return await checkRepositoryCredential(null, repo, false, true) === 'usable';
  });
  const env = { ...process.env };
  let args;
  if (selection.source === 'local' && !https) {
    // remote-ext speaks Git's remote-helper protocol and delegates the actual
    // upload/receive-pack once. sh preserves a configured SSH command's quoting.
    const command = ssh + ' -oBatchMode=yes' + sshPort + ' ' + sshHost + ' "$1" "$2"';
    const escaped = command.replace(/%/g, '%%').replace(/ /g, '% ');
    args = ['remote-ext', process.argv[2], 'sh -c ' + escaped + ' lody %S ' + repo + '.git'];
  } else {
    // Append last-precedence config without exposing the token in argv. Reset
    // inherited headers and helpers; neither may leak or persist other identity.
    // Git rejects leading whitespace when there are no inherited parameters.
    env.GIT_CONFIG_PARAMETERS = [env.GIT_CONFIG_PARAMETERS, ...[
      'http.' + url + '.extraHeader=',
      'http.' + url + '.extraHeader=' + (selection.token ? 'Authorization: Basic ' + Buffer.from('x-access-token:' + selection.token).toString('base64') : 'Authorization:'),
      'credential.' + url + '.helper=',
    ].map(quote)].filter(Boolean).join(' ');
    args = ['remote-https', process.argv[2], url];
  }
  const child = spawn(REAL_GIT, args, { env, stdio: 'inherit', windowsHide: true });
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
};
main().catch(error => { console.error('[Lody] ' + error.message); process.exit(1); });
`;
  writeIfChanged(path.join(directory, 'git-remote-lody-github'), source, 0o755);
  // Git's credential protocol does not include the operation. Set it at the
  // command boundary, inherited by all internal submodule transports/helpers.
  writeIfChanged(
    path.join(directory, 'git'),
    `#!/usr/bin/env node
const { spawn, spawnSync } = require('child_process');
const args = process.argv.slice(2);
let command;
let commandIndex = -1;
for (let i = 0; i < args.length; i++) {
  if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(args[i])) { i++; continue; }
  if (!args[i].startsWith('-')) { command = args[i]; commandIndex = i; break; }
}
// Git applies only one insteadOf rewrite; an existing equal/longer prefix
// can bypass the managed transport entirely. Do not silently borrow credentials
// in that configuration. Non-network commands remain usable for repairing it.
if (['fetch', 'clone', 'pull', 'push', 'ls-remote', 'submodule'].includes(command) ||
    !['status', 'diff', 'log', 'show', 'rev-parse', 'config', 'credential', 'add', 'commit', 'branch', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase', 'tag', 'worktree', 'remote', 'init'].includes(command)) {
  const config = spawnSync(${JSON.stringify(realGit)}, [...args.slice(0, commandIndex), 'config', '--null', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], { env: process.env, encoding: 'utf8' });
  const conflict = (config.stdout || '').split('\\0').some(record => {
    const separator = record.indexOf('\\n');
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    return !key.startsWith('url.lody-github::') && /(?:github\\.com|ssh\\.github\\.com)[/:]/i.test(key + ' ' + value);
  });
  if (conflict) {
    console.error('[Lody] A custom GitHub URL rewrite bypasses credential selection. Remove the conflicting url.*.insteadOf/pushInsteadOf configuration before this network command.');
    process.exit(1);
  }
}
// Local operations can download objects or run LFS/smudge filters, but do not
// write remote refs. Credential subprocesses inherit the enclosing operation.
// A nested push always overrides read; aliases/unknown commands stay conservative.
const readCommands = ['fetch', 'clone', 'pull', 'ls-remote', 'submodule', 'status', 'diff', 'log', 'show', 'rev-parse', 'config', 'add', 'commit', 'branch', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase', 'tag', 'worktree', 'remote', 'init'];
const operation = command === 'credential'
  ? (process.env.LODY_GIT_OPERATION === 'read' ? 'read' : 'write')
  : (readCommands.includes(command) ? 'read' : 'write');
const env = { ...process.env, LODY_GIT_OPERATION: operation };
const child = spawn(${JSON.stringify(realGit)}, args, { env, stdio: 'inherit', windowsHide: true });
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
`,
    0o755
  );
  if (process.platform === 'win32') {
    for (const command of ['git', 'git-remote-lody-github']) {
      writeIfChanged(
        path.join(directory, `${command}.cmd`),
        `@echo off\r\n"${process.execPath}" "%~dp0${command}" %*\r\n`
      );
    }
  }
}
