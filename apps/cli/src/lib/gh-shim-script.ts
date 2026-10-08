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
import { createHash } from 'crypto';

import { GITHUB_CREDENTIAL_ENV_KEYS, LODY_MANAGED_GH_TOKEN_SHA256_ENV } from '@/lib/gh-token-env';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { githubCredentialRuntime } from './github-credential-runtime';
import { ensureGitHubGitTransport } from './github-git-transport';
import {
  buildHostNodeScriptPreamble,
  resolveHostNodeRuntime,
  type HostNodeRuntime,
} from './host-node-launcher';

const GH_SHIM_POSIX_BASENAME = 'gh';
const GH_SHIM_WINDOWS_BASENAME = 'gh.cmd';
const REAL_GH_PATH_PLACEHOLDER = '__LODY_REAL_GH_PATH__';
const NODE_EXEC_PATH_PLACEHOLDER = '__LODY_NODE_EXEC_PATH__';
const BROKER_STATE_PATH_PLACEHOLDER = '__LODY_BROKER_STATE_PATH__';
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
  const managedRoot = toComparablePath(path.join(getLodyDataDir(), 'gh-session-bin'));
  const candidateNames =
    process.platform === 'win32' ? getWindowsExecutableCandidateNames(name) : [name];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }

    const comparableDir = toComparablePath(dir);
    if (
      comparableDir === excludedComparableDir ||
      path.dirname(comparableDir) === managedRoot ||
      comparableDir === toComparablePath(path.join(getLodyDataDir(), 'bin'))
    ) {
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

const wrapperSourceTemplate = `'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REAL_GH_PATH = '${REAL_GH_PATH_PLACEHOLDER}';
const SHIM_PATH = __filename;
const SHIM_DIR = path.dirname(SHIM_PATH);
const MANAGED_TOKEN_MARKER_ENV = '${MANAGED_TOKEN_MARKER_ENV}';
const GITHUB_CREDENTIAL_ENV_KEYS = ${JSON.stringify(GITHUB_CREDENTIAL_ENV_KEYS)};
const LEGACY_BIN_DIR = ${JSON.stringify(path.join(getLodyDataDir(), 'bin'))};
${githubCredentialRuntime}
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
  const shimRoot = path.dirname(shimComparableDir);
  const candidateNames =
    process.platform === 'win32' ? WINDOWS_EXECUTABLE_CANDIDATE_NAMES : ['gh'];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (path.dirname(toComparablePath(dir)) === shimRoot || toComparablePath(dir) === toComparablePath(LEGACY_BIN_DIR)) continue;

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

const clearManagedTokenEnv = (env) => {
  const marker = env[MANAGED_TOKEN_MARKER_ENV];
  if (!marker) return;
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (isManagedTokenValue(env[key], marker)) {
      delete env[key];
      delete env[MANAGED_TOKEN_MARKER_ENV];
    }
  }
};

const injectGhToken = (env, token) => {
  if (!token) return;
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
  env[MANAGED_TOKEN_MARKER_ENV] = fingerprintToken(token);
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

// Command-scoped option arity audited against cli/cli v2.96.0. Each descriptor is
// long-name[:short-name]; a short name is not necessarily boolean elsewhere.
const viewFlags = ['comments:c web:w', 'json jq:q template:t'];
const commentFlags = ['edit-last create-if-none delete-last editor:e web:w yes', 'body:b body-file:F attach'];
const editValues = 'add-assignee add-label add-project body:b body-file:F milestone:m remove-assignee remove-label remove-project title:t';
const createValues = 'assignee:a attach body:b body-file:F label:l milestone:m project:p recover template:T title:t';
const listValues = 'app assignee:a author:A json jq:q label:l limit:L search:S state:s template:t';
const repoCommandFlags = {
  run: {
    cancel: ['force', ''],
    delete: ['', ''],
    download: ['', 'dir:D name:n pattern:p'],
    list: ['all:a', 'limit:L workflow:w branch:b user:u event:e created commit:c status:s json jq:q template:t'],
    rerun: ['failed debug:d', 'job:j'],
    view: ['verbose:v exit-status log log-failed web:w', 'job:j attempt:a json jq:q template:t'],
    watch: ['exit-status compact', 'interval:i'],
  },
  workflow: {
    disable: ['', ''],
    enable: ['', ''],
    list: ['all:a', 'limit:L json jq:q template:t'],
    run: ['json', 'ref:r field:F raw-field:f'],
    view: ['web:w yaml:y', 'ref:r'],
  },
  cache: {
    delete: ['all:a succeed-on-no-caches', 'ref:r'],
    list: ['', 'limit:L order:O sort:S key:k ref:r json jq:q template:t'],
  },
  release: {
    create: ['draft:d prerelease:p generate-notes latest verify-tag notes-from-tag fail-on-no-commits', 'target title:t notes:n notes-file:F discussion-category notes-start-tag'],
    delete: ['yes:y cleanup-tag', ''],
    'delete-asset': ['yes:y', ''],
    download: ['clobber skip-existing', 'output:O dir:D pattern:p archive:A'],
    edit: ['draft prerelease latest verify-tag', 'notes:n title:t discussion-category target tag notes-file:F'],
    list: ['exclude-drafts exclude-pre-releases', 'limit:L order:O json jq:q template:t'],
    upload: ['clobber', ''],
    verify: ['', 'format jq:q template:t custom-trusted-root'],
    'verify-asset': ['', 'format jq:q template:t custom-trusted-root'],
    view: ['web:w', 'json jq:q template:t'],
  },
  repo: {
    clone: ['recurse-submodules', ''],
    fork: ['clone remote default-branch-only', 'fork-name org remote-name'],
    sync: ['force', 'branch:b'],
    view: ['web:w', 'branch:b json jq:q template:t'],
    archive: ['confirm yes:y', ''],
    delete: ['confirm yes', ''],
    edit: ['template enable-issues enable-projects enable-wiki enable-discussions enable-merge-commit enable-squash-merge enable-rebase-merge enable-auto-merge enable-advanced-security enable-secret-scanning enable-secret-scanning-push-protection delete-branch-on-merge allow-forking allow-update-branch accept-visibility-change-consequences', 'description:d homepage:h default-branch visibility squash-merge-commit-message add-topic remove-topic'],
    rename: ['confirm yes:y', ''],
    // sync: ['force', 'source:s branch:b'], // OMIT: secondary repository --source
  },
  label: {
    create: ['force:f', 'description:d color:c'],
    delete: ['confirm yes', ''],
    edit: ['', 'description:d color:c name:n'],
    list: ['web:w', 'limit:L search:S order sort json jq:q template:t'],
    // clone OMIT: positional source repository, --repo destination repository
  },
  pr: {
    checkout: ['detach force:f recurse-submodules', 'branch:b worktree'],
    checks: ['fail-fast required watch web:w', 'interval:i json jq:q template:t'],
    close: ['delete-branch:d', 'comment:c'],
    comment: commentFlags,
    create: ['draft:d dry-run editor:e fill:f fill-first fill-verbose no-maintainer-edit web:w', createValues + ' base:B head:H reviewer:r'],
    diff: ['name-only patch web:w', 'color exclude:e'],
    edit: ['remove-milestone', editValues + ' add-reviewer base:B remove-reviewer'],
    list: ['draft:d web:w', listValues + ' base:B head:H'],
    lock: ['', 'reason:r'],
    merge: ['admin auto delete-branch:d disable-auto merge:m rebase:r squash:s', 'author-email:A body:b body-file:F match-head-commit subject:t'],
    ready: ['undo', ''],
    reopen: ['', 'comment:c'],
    revert: ['draft:d', 'body:b body-file:F title:t'],
    review: ['approve:a comment:c request-changes:r', 'body:b body-file:F'],
    status: ['conflict-status:c', 'json jq:q template:t'],
    unlock: ['', ''],
    'update-branch': ['rebase', ''],
    view: viewFlags,
  },
  issue: {
    close: ['', 'comment:c reason:r duplicate-of'],
    comment: commentFlags,
    create: ['editor:e web:w', createValues + ' blocked-by blocking parent type'],
    delete: ['yes confirm', ''],
    develop: ['checkout:c list:l', 'base:b branch-repo name:n issue-repo:i'],
    edit: ['remove-milestone remove-type remove-parent', editValues + ' type parent add-sub-issue remove-sub-issue add-blocked-by remove-blocked-by add-blocking remove-blocking'],
    list: ['web:w', listValues + ' mention milestone:m type'],
    lock: ['', 'reason:r'],
    pin: ['', ''],
    reopen: ['', 'comment:c'],
    status: ['', 'json jq:q template:t'],
    transfer: ['', ''],
    unlock: ['', ''],
    unpin: ['', ''],
    view: viewFlags,
  },
};

// null means ambiguous: local gh may handle it, but managed auth must not guess.
const readRepoCommandArgs = (args) => {
  const isUrl = (value) => /^https?:/i.test(value || '');
  const arity = new Map([['--repo', true], ['-R', true], ['--help', false], ['-h', false]]);
  const positionals = [];
  let command;
  let help = false;
  let disableAuto = false;
  let repo;
  let issueRepo;
  let branchRepo;
  let duplicate;
  let options = true;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === '--') { options = false; continue; }
    if (!options || !arg.startsWith('-') || arg === '-') {
      if (command) { positionals.push(arg); continue; }
      if (!options) return null;
      command = { new: 'create', ls: 'list', co: 'checkout' }[arg] || arg;
      const flags = repoCommandFlags[args[0]]?.[command];
      if (!Array.isArray(flags)) return null;
      for (const [takesValue, descriptors] of [[false, flags[0]], [true, flags[1]]]) {
        for (const descriptor of descriptors.split(' ').filter(Boolean)) {
          const [long, short] = descriptor.split(':');
          arity.set('--' + long, takesValue);
          if (short) arity.set('-' + short, takesValue);
        }
      }
      continue;
    }
    const long = arg.startsWith('--');
    const names = long ? [arg.split('=')[0]] : [...arg.slice(1)].map((letter) => '-' + letter);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      if (!arity.has(name)) return null;
      const attached = long ? arg.indexOf('=') : j + 2 < arg.length ? j + 1 : -1;
      if (arity.get(name)) {
        let value = attached >= 0 ? arg.slice(attached + 1) : args[++i];
        if (!long && attached >= 0 && value.startsWith('=')) value = value.slice(1);
        // Consume known values once; never rescan them as flags or subjects.
        if (value === undefined) return null;
        if (name === '--repo' || name === '-R') repo = value;
        if (args[0] === 'issue' && command === 'develop') {
          if (name === '--issue-repo' || name === '-i') issueRepo = value;
          if (name === '--branch-repo') branchRepo = value;
        }
        if (args[0] === 'issue' && command === 'close' && name === '--duplicate-of') duplicate = value;
        break;
      }
      const value = long && attached >= 0 ? arg.slice(attached + 1) :
        !long && arg[j + 2] === '=' ? arg.slice(j + 3) : 'true';
      if (!/^(true|false|1|0|t|f)$/i.test(value)) return null;
      if (name === '--help' || name === '-h') help = /^(true|1|t)$/i.test(value);
      if (name === '--disable-auto') disableAuto = /^(true|1|t)$/i.test(value);
      if (!long && arg[j + 2] === '=') break;
    }
  }
  if (help) return { help, command };
  if (!command) return null;
  const subjectCommand = args[0] === 'pr' || args[0] === 'issue';
  if (subjectCommand && ['create', 'list', 'status'].includes(command) && positionals.length) return null;
  let subject = positionals[0];
  if (args[0] === 'issue' && command === 'edit') {
    const urls = positionals.filter(isUrl);
    let issueTarget;
    for (const value of urls) {
      try {
        const url = new URL(value);
        const repo = parseRepo(url.pathname.split('/').slice(1, 3).join('/'), url.hostname);
        if (!repo || repo.host !== 'github.com') return null;
        const target = repo.repo.toLowerCase();
        if (issueTarget && issueTarget !== target) return null;
        issueTarget = target;
      } catch { return null; }
    }
    // Native gh applies the first URL's repository to every number in the batch.
    subject = urls[0] || subject;
  } else if (subjectCommand && positionals.slice(1).some(isUrl)) return null;
  if (!subjectCommand) {
    // These repo commands take a repository operand; other groups take IDs, tags or files.
    if (args[0] === 'repo' && ['view', 'archive', 'delete', 'edit', 'clone', 'fork', 'sync'].includes(command)) {
      repo = subject || repo;
    }
    subject = undefined;
  }
  // These commands also send authenticated requests to a secondary repository.
  // Native owner auth can handle other hosts; managed credentials must not reach them.
  if (issueRepo !== undefined && repo !== undefined) branchRepo = repo;
  if (branchRepo && parseRepo(branchRepo, process.env.GH_HOST || 'github.com')?.host !== 'github.com') return null;
  if (isUrl(duplicate)) {
    try { if (new URL(duplicate).hostname !== 'github.com') return null; }
    catch { return null; }
  }
  // develop's deprecated selector overrides --repo regardless of flag order.
  return { subject, command, disableAuto, repo: issueRepo !== undefined ? issueRepo : repo };
};

// API accepts exactly one endpoint. Values can themselves look like URLs or
// hostname flags, so only consumed positional/hostname arguments select auth.
const readApiArgs = (args) => {
  const arity = new Map();
  for (const [takesValue, descriptors] of [
    [false, 'include:i slurp paginate silent verbose help:h'],
    [true, 'hostname method:X field:F raw-field:f header:H preview:p input template:t jq:q cache'],
  ]) {
    for (const descriptor of descriptors.split(' ')) {
      const [long, short] = descriptor.split(':');
      arity.set('--' + long, takesValue);
      if (short) arity.set('-' + short, takesValue);
    }
  }
  const positionals = [];
  let hostname;
  let help = false;
  let options = true;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === '--') { options = false; continue; }
    if (!options || !arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }
    const long = arg.startsWith('--');
    const names = long ? [arg.split('=')[0]] : [...arg.slice(1)].map((letter) => '-' + letter);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      if (!arity.has(name)) return null;
      const attached = long ? arg.indexOf('=') : j + 2 < arg.length ? j + 1 : -1;
      if (arity.get(name)) {
        let value = attached >= 0 ? arg.slice(attached + 1) : args[++i];
        if (!long && attached >= 0 && value.startsWith('=')) value = value.slice(1);
        if (value === undefined) return null;
        if (name === '--hostname') hostname = value;
        break;
      }
      const value = long && attached >= 0 ? arg.slice(attached + 1) :
        !long && arg[j + 2] === '=' ? arg.slice(j + 3) : 'true';
      if (!/^(true|false|1|0|t|f)$/i.test(value)) return null;
      if (name === '--help' || name === '-h') help = /^(true|1|t)$/i.test(value);
      if (!long && arg[j + 2] === '=') break;
    }
  }
  return help || positionals.length === 1 ? { endpoint: positionals[0], hostname, help } : null;
};

const normalizeRepoArgs = (args) => {
  // gh also accepts inherited repo flags before repository command groups.
  let groupIndex = 0;
  while (groupIndex < args.length) {
    const arg = args[groupIndex];
    if (arg === '--repo' || arg === '-R') { groupIndex += 2; continue; }
    if (arg.startsWith('--repo=') || (arg.startsWith('-R') && arg.length > 2)) { groupIndex++; continue; }
    break;
  }
  if (groupIndex && Object.hasOwn(repoCommandFlags, args[groupIndex])) {
    args = [args[groupIndex], ...args.slice(0, groupIndex), ...args.slice(groupIndex + 1)];
  }
  return args;
};

const readGitHubTarget = async (args) => {
  const repoCommand = Object.hasOwn(repoCommandFlags, args[0]);
  const apiArgs = args[0] === 'api' ? readApiArgs(args) : undefined;
  if (apiArgs === null || (!repoCommand && !apiArgs)) return { host: null, repo: null };
  const host = String(apiArgs?.hostname || process.env.GH_HOST || 'github.com').toLowerCase();
  if (apiArgs) {
    const endpoint = apiArgs.endpoint;
    let url = null;
    try { if (endpoint.includes('://')) url = new URL(endpoint); }
    catch { return { host: null, repo: null }; }
    if (url && url.protocol !== 'https:') return { host: null, repo: null };
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
    // Repository-less API endpoints use the workspace's credential context.
    return { host: apiHost, repo: repo && !repo.includes('{') ? repo :
      (!match && !url ? process.env.LODY_GITHUB_REPO_FULL_NAME || null : null) };
  }
  // PR/Issue subjects override ambient repositories; option values do not.
  const parsed = repoCommand ? readRepoCommandArgs(args) : undefined;
  if (parsed === null) return { host: null, repo: null };
  const subject = parsed.subject;
  if (subject && /^https?:\\/\\//i.test(subject)) {
    try {
      const url = new URL(subject);
      const repoPath = url.pathname.split('/').slice(1, 3).join('/');
      return parseRepo(repoPath, url.hostname) || { host: url.hostname, repo: null };
    } catch { return { host, repo: null }; }
  }
  // Never rescan option values (e.g. a template containing '-Rowner/repo').
  const explicitRepo = parsed.repo || process.env.GH_REPO;
  if (explicitRepo) return parseRepo(explicitRepo, host) || { host, repo: null };
  return parseRepo(await readGitRemoteOrigin(), host) ||
    parseRepo(process.env.LODY_GITHUB_REPO_FULL_NAME || process.env.GITHUB_REPOSITORY, host) ||
    { host, repo: null };
};

const helpGroups = new Set([...Object.keys(repoCommandFlags), ...
  'agent-task alias attestation auth codespace config discussion extension gist gpg-key org preview project ruleset search secret skill ssh-key variable'.split(' ')]);

const readCredentialFreeArgs = (args) => {
  if (!args.length || (args.length === 1 && args[0] === '-h')) return ['help', '--'];
  if (args.length === 1 && /^(version|--version(?:=(true|1|t))?)$/i.test(args[0])) return ['--version'];
  const parsed = args[0] === 'api' ? readApiArgs(args) :
    Object.hasOwn(repoCommandFlags, args[0]) ? readRepoCommandArgs(args) : null;
  if (parsed?.help) return ['help', '--', args[0], ...(parsed.command ? [parsed.command] : [])];
  // A successfully consumed value (e.g. repo edit -h=true) is never rescanned as help.
  if (parsed) return null;
  let parts;
  if (args[0] === 'help') return ['help', '--', ...args.slice(1)];
  else if (helpGroups.has(args[0]) && (args.length === 1 || (args.length === 2 && args[1] === '-h'))) parts = [args[0]];
  else {
    let help = false;
    let options = true;
    parts = [];
    for (const arg of args) {
      if (arg === '--') { options = false; continue; }
      const match = options && /^--help(?:=(true|false|1|0|t|f))?$/i.exec(arg);
      if (match) help = !match[1] || /^(true|1|t)$/i.test(match[1]);
      else parts.push(arg);
    }
    if (!help) return null;
  }
  // Outside the arity table, accept plain help paths only, never unknown option values.
  return parts.every((part) => !part.startsWith('-')) ? ['help', '--', ...parts] : null;
};

// The daemon chooses this workspace binding when generating the wrapper.
// Child environment overrides must never select the authorization authority.
const BROKER_STATE_PATH = '${BROKER_STATE_PATH_PLACEHOLDER}';
const getBrokerConfig = () => {
  const state = JSON.parse(fs.readFileSync(BROKER_STATE_PATH, 'utf8'));
  if (typeof state?.url !== 'string' || typeof state?.token !== 'string') throw credentialError('broker_state_invalid');
  return state;
};

let capturedContext;
const getContext = () => capturedContext ??= readCredentialContext(fs, BROKER_STATE_PATH, process.env);
const requestBroker = async (endpoint, body, timeoutMs) => {
  const config = getBrokerConfig();
  if (!config) throw credentialError('broker_state_unavailable');
  return await fetch(config.url + endpoint, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
};

const isolatedGhEnv = (env, token) => {
  const isolated = { ...env };
  for (const key of Object.keys(isolated)) if (GITHUB_CREDENTIAL_ENV_KEYS.includes(key.toUpperCase())) delete isolated[key];
  const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lody-gh-auth-'));
  process.on('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
  isolated.GH_CONFIG_DIR = directory;
  isolated.XDG_DATA_HOME = directory;
  isolated.XDG_STATE_HOME = directory;
  isolated.XDG_CACHE_HOME = directory;
  isolated.GH_NO_UPDATE_NOTIFIER = '1';
  isolated.GH_NO_EXTENSION_UPDATE_NOTIFIER = '1';
  isolated.GH_PROMPT_DISABLED = '1';
  injectGhToken(isolated, token);
  return isolated;
};

async function* ghEnvironments(ghCommand, args) {
  const env = { ...process.env };
  clearManagedTokenEnv(env);
  const normalizedArgs = normalizeRepoArgs(args);
  const helpArgs = readCredentialFreeArgs(normalizedArgs);
  if (helpArgs) { yield { env: isolatedGhEnv(env), args: helpArgs, source: 'help' }; return; }
  const policy = readCredentialPolicy();
  if (args[0] === 'auth') {
    if (!policy.allowLocalAuth) throw credentialError('machine_identity_not_allowed');
    yield { env, source: 'local' }; return;
  }
  const target = await readGitHubTarget(normalizedArgs);
  if (target.host !== 'github.com' || !target.repo) {
    diagnostic('personal', 'target', credentialError('repository_required'));
    if (policy.allowLocalAuth) { yield { env, source: 'local' }; return; }
    throw credentialError('repository_required');
  }
  const local = async () => {
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    if (token) return { token };
    const result = await runGhCommand(ghCommand, ['auth', 'token', '--hostname', target.host], {
      env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw credentialError('local_auth_missing');
    return result.stdout.trim() ? { token: result.stdout.trim() } : null;
  };
  for await (const candidate of githubCredentials(target.repo, policy, local)) {
    const attemptEnv = candidate.source === 'local' ? { ...env } : isolatedGhEnv(env, candidate.token);
    injectGhToken(attemptEnv, candidate.token);
    attemptEnv.GH_HOST = 'github.com';
    yield { env: attemptEnv, source: candidate.source };
  }
}
const main = async () => {
  const ghCommand = resolveRealGhCommand();
  if (!ghCommand) throw credentialError('gh_not_found');
  const args = process.argv.slice(2);
  for await (const attempt of ghEnvironments(ghCommand, args)) {
    console.error('[Lody GitHub] ' + JSON.stringify({ source: attempt.source, stage: 'execute' }));
    // Preserve native streaming. Once output or a possible write is observed,
    // never replay a command (gh may issue multiple API calls internally).
    const result = await new Promise(resolve => {
      const child = spawnGh(ghCommand, attempt.args || args, { stdio: ['inherit', 'pipe', 'pipe'], env: attempt.env });
      let output = false;
      let stderr = '';
      child.stdout.on('data', chunk => { output = true; process.stdout.write(chunk); });
      child.stderr.on('data', chunk => { process.stderr.write(chunk); stderr += String(chunk).slice(0, Math.max(0, 20000 - stderr.length)); });
      child.on('error', error => resolve({ error, code: 1, output, stderr }));
      child.on('close', (code, signal) => resolve({ code, signal, output, stderr }));
    });
    if (result.signal) { process.kill(process.pid, result.signal); return; }
    if (result.code === 0) return;
    if (result.error) throw result.error;
    // A single unpaginated REST API request with no hooks has a clear rejection
    // boundary. Other commands may have completed an earlier write: stop.
    const singleApi = args[0] === 'api' && !args.includes('graphql') && !args.includes('--paginate') && !args.includes('--cache');
    const rejected = /HTTP (401|403|404)\\b/.test(result.stderr);
    const normalized = normalizeRepoArgs(args);
    const readCommands = { pr: ['view', 'list', 'status', 'checks', 'diff'], issue: ['view', 'list', 'status'], repo: ['view', 'list'], release: ['view', 'list'], run: ['view', 'list'], workflow: ['view', 'list'] };
    const safeRead = (args[0] === 'api' && !args.some(arg => /^(?:-X|-f|-F|--method|--field|--raw-field|--input)/.test(arg)) && !args.includes('graphql')) || readCommands[normalized[0]]?.includes(normalized[1]);
    if (!result.output && (safeRead || (singleApi && rejected))) {
      diagnostic(attempt.source, 'execute', credentialError(rejected ? 'access_denied' : 'command_failed'));
      continue;
    }
    console.error('[Lody GitHub] command_failed; no replay because effects may have occurred.');
    process.exitCode = result.code ?? 1;
    return;
  }
};

main().catch((error) => { diagnostic('gh', 'failed', error); process.exitCode = 1; });
`;

const windowsLauncherSourceTemplate = `@echo off
"${NODE_EXEC_PATH_PLACEHOLDER}" "%~dp0gh" %*
`;

// Only managed session PATHs include this directory. Ordinary local shells use
// native gh, so missing session context never needs an authorization exception.
const resolveBrokerStatePath = (statePath?: string): string =>
  path.resolve(statePath ?? path.join(getLodyDataDir(), 'broker.json'));

// Parent of every per-broker shim dir; agent PATH merges pin any child of it first.
export const getGhShimSessionBinRoot = (): string => path.join(getLodyDataDir(), 'gh-session-bin');

export const getGhShimHostBinDir = (brokerStateFilePath?: string): string =>
  path.join(
    getGhShimSessionBinRoot(),
    createHash('sha256')
      .update(resolveBrokerStatePath(brokerStateFilePath))
      .digest('hex')
      .slice(0, 16)
  );

const getGhShimHostNodeScriptPath = (brokerStateFilePath?: string): string =>
  path.join(getGhShimHostBinDir(brokerStateFilePath), GH_SHIM_POSIX_BASENAME);

const getGhShimHostWindowsLauncherPath = (brokerStateFilePath?: string): string =>
  path.join(getGhShimHostBinDir(brokerStateFilePath), GH_SHIM_WINDOWS_BASENAME);

export const getGhShimHostPath = (brokerStateFilePath?: string): string =>
  process.platform === 'win32'
    ? getGhShimHostWindowsLauncherPath(brokerStateFilePath)
    : getGhShimHostNodeScriptPath(brokerStateFilePath);

const escapeForSingleQuotedString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const escapeForDoubleQuotedCmdString = (value: string): string => value.replace(/"/g, '""');

const buildGhShimSource = (
  realGhPath: string | null,
  brokerStateFilePath: string | undefined,
  runtime: HostNodeRuntime
): string => {
  const escapedRealPath = realGhPath ? escapeForSingleQuotedString(realGhPath) : '';
  const source = wrapperSourceTemplate
    .split(REAL_GH_PATH_PLACEHOLDER)
    .join(escapedRealPath)
    .split(BROKER_STATE_PATH_PLACEHOLDER)
    .join(escapeForSingleQuotedString(resolveBrokerStatePath(brokerStateFilePath)));
  return buildHostNodeScriptPreamble(runtime) + source;
};

const buildWindowsLauncherSource = (runtime: HostNodeRuntime): string =>
  windowsLauncherSourceTemplate
    .split(NODE_EXEC_PATH_PLACEHOLDER)
    .join(escapeForDoubleQuotedCmdString(runtime.execPath));

const resolveRealGhPath = (brokerStateFilePath?: string): string | null =>
  resolveExecutableFromPath('gh', getGhShimHostPath(brokerStateFilePath));

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

export const ensureGhShimScript = (
  brokerStateFilePath?: string,
  runtime = resolveHostNodeRuntime()
): void => {
  const source = buildGhShimSource(
    resolveRealGhPath(brokerStateFilePath),
    brokerStateFilePath,
    runtime
  );
  const shimTargets =
    process.platform === 'win32'
      ? [
          { filePath: getGhShimHostNodeScriptPath(brokerStateFilePath), content: source },
          {
            filePath: getGhShimHostWindowsLauncherPath(brokerStateFilePath),
            content: buildWindowsLauncherSource(runtime),
          },
        ]
      : [{ filePath: getGhShimHostNodeScriptPath(brokerStateFilePath), content: source }];

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
  const realGit = resolveExecutableFromPath(
    'git',
    path.join(getGhShimHostBinDir(brokerStateFilePath), 'git')
  );
  if (realGit)
    ensureGitHubGitTransport(
      getGhShimHostBinDir(brokerStateFilePath),
      resolveBrokerStatePath(brokerStateFilePath),
      realGit,
      runtime
    );
};

export const prependGhShimBinDirToPath = (
  pathEnv: string | undefined,
  brokerStateFilePath?: string
): string => {
  const shimBinDir = getGhShimHostBinDir(brokerStateFilePath);
  const entries = (pathEnv ?? '').split(path.delimiter).filter(Boolean);
  const shimComparableDir = toComparablePath(shimBinDir);
  const filtered = entries.filter((entry) => toComparablePath(entry) !== shimComparableDir);
  return [shimBinDir, ...filtered].join(path.delimiter);
};
