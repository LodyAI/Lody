const { createHash } = require('node:crypto');
const { getInstallationProfile } = require('./installation-profile.cjs');

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOCAL_REPO_ID_PREFIX = 'local---';

function assertSafeSessionId(sessionId) {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `Invalid sessionId ${JSON.stringify(sessionId)}: expected /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`
    );
  }
}

const GITHUB_REPO_PART_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const GITHUB_REPO_OWNER_MAX_LEN = 39;
const GITHUB_REPO_NAME_MAX_LEN = 100;

function parseOwnerRepoFromPathSegment(pathStr, raw) {
  const cleaned = String(pathStr)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const parts = cleaned.split('/').filter(Boolean);

  if (parts.length !== 2) {
    throw new Error(`Invalid GitHub repo: expected owner/repo, got ${JSON.stringify(raw)}`);
  }

  const owner = parts[0] || '';
  const repo = parts[1] || '';

  if (
    !owner ||
    !repo ||
    owner.length > GITHUB_REPO_OWNER_MAX_LEN ||
    repo.length > GITHUB_REPO_NAME_MAX_LEN ||
    !GITHUB_REPO_PART_RE.test(owner) ||
    !GITHUB_REPO_PART_RE.test(repo)
  ) {
    throw new Error(`Invalid GitHub repo: expected owner/repo, got ${JSON.stringify(raw)}`);
  }

  return { owner, repo };
}

function stripWrappingQuotes(value) {
  if (!value) return value;
  return String(value).replace(/^['"]+|['"]+$/g, '');
}

function parseGitHubRepo(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  const value = stripWrappingQuotes(trimmed) ?? trimmed;
  if (!value) {
    throw new Error('Invalid GitHub repo: empty value');
  }

  if (/^git@github\.com:/i.test(value)) {
    return parseOwnerRepoFromPathSegment(value.replace(/^git@github\.com:/i, ''), raw);
  }

  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      throw new Error(`Invalid GitHub repo: expected github.com host, got ${JSON.stringify(raw)}`);
    }
    return parseOwnerRepoFromPathSegment(url.pathname, raw);
  }

  if (/^github\.com\//i.test(value) || /^www\.github\.com\//i.test(value)) {
    const url = new URL(`https://${value}`);
    return parseOwnerRepoFromPathSegment(url.pathname, raw);
  }

  return parseOwnerRepoFromPathSegment(value, raw);
}

function deriveRepoIdFromGitHubRepo(repo) {
  const parts = parseGitHubRepo(repo);
  return `github---${parts.owner.toLowerCase()}---${parts.repo.toLowerCase()}`;
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

const WINDOWS_ROOTED_PATH_RE = /^[A-Za-z]:[\\/]/;

// Parity with `toHostSeparators` in ../worktree-paths.ts: a path derived from a host
// path keeps that host's separator, so a Windows machine never gets `C:/Users/...`.
function isWindowsStyleHostPath(hostPath) {
  return WINDOWS_ROOTED_PATH_RE.test(hostPath) || String(hostPath).includes('\\');
}

function toHostSeparators(joined, hostPath) {
  return isWindowsStyleHostPath(hostPath) ? joined.replace(/\//g, '\\') : joined;
}

function normalizeLocalProjectPathForRepoId(p) {
  const normalized = normalizePath(String(p).trim());
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/g, '');
}

function getLodyReposBaseDir(homeDir) {
  return toHostSeparators(
    `${normalizePath(homeDir)}/${getInstallationProfile().dataDirectoryName}/repos`,
    homeDir
  );
}

function getWorktreeHostPath(repoId, sessionId, homeDir) {
  assertSafeSessionId(sessionId);
  if (homeDir) {
    return toHostSeparators(
      `${normalizePath(getLodyReposBaseDir(homeDir))}/${repoId}/worktrees/${sessionId}`,
      homeDir
    );
  }
  return `~/${getInstallationProfile().dataDirectoryName}/repos/${repoId}/worktrees/${sessionId}`;
}

function deriveRepoIdFromLocalProjectPath(absolutePath) {
  const normalized = normalizeLocalProjectPathForRepoId(absolutePath);
  if (!normalized) {
    throw new Error('Invalid local project path: empty value');
  }
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `${LOCAL_REPO_ID_PREFIX}${hash}`;
}

function isLocalRepoId(repoId) {
  return String(repoId).startsWith(LOCAL_REPO_ID_PREFIX);
}

module.exports = {
  parseGitHubRepo,
  deriveRepoIdFromGitHubRepo,
  deriveRepoIdFromLocalProjectPath,
  isLocalRepoId,
  getWorktreeHostPath,
};
