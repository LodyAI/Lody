// Ported from web `components/lib/session-workspace-path.ts` and the browser-safe
// parts of @lody/shared `worktree-paths.ts` (its root is not browser-safe). The
// copied path must name the directory the CLI really uses, so keep it in step.

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOCAL_REPO_ID_PREFIX = 'local---';
const GITHUB_REPO_PART_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) throw new Error('invalid_session');
}

/** Web `deriveRepoIdFromGitHubRepo` for the stored `owner/repo` form (plus URL spellings). */
function deriveRepoIdFromGitHubRepo(raw: string): string {
  let value = raw.trim().replace(/^['"]+|['"]+$/g, '');
  if (/^git@github\.com:/i.test(value))
    value = value.replace(/^git@github\.com:/i, '');
  else if (
    /^(?:https?|ssh):\/\//i.test(value) ||
    /^(?:www\.)?github\.com\//i.test(value)
  ) {
    const url = new URL(
      /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`,
    );
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')
      throw new Error('invalid_repo');
    value = url.pathname;
  }
  const parts = value
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  const [owner = '', repo = ''] = parts;
  if (
    parts.length !== 2 ||
    owner.length > 39 ||
    repo.length > 100 ||
    !GITHUB_REPO_PART_RE.test(owner) ||
    !GITHUB_REPO_PART_RE.test(repo)
  )
    throw new Error('invalid_repo');
  return `github---${owner.toLowerCase()}---${repo.toLowerCase()}`;
}

/**
 * Normalize a filesystem path to use forward slashes, so the segment joining below
 * has a single separator to reason about. Callers that hand the result back to a
 * host (`fs`, `spawn`, an error message, a launcher argv) restore the host's own
 * separator with `toHostSeparators`; URI builders normalize to `/` themselves.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

const WINDOWS_ROOTED_PATH_RE = /^[A-Za-z]:[\\/]/;

/**
 * Whether a stored host path was produced on Windows.
 *
 * The shape of the value decides, never `process.platform`: these builders run in the
 * renderer against a `dotlodyPath` that the Flock carries from whichever machine owns
 * the session, so a Windows desktop routinely builds paths for a Linux machine and a
 * Linux browser builds paths for a Windows one.
 */
function isWindowsStyleHostPath(hostPath: string): boolean {
  return WINDOWS_ROOTED_PATH_RE.test(hostPath) || hostPath.includes('\\');
}

/**
 * Re-apply `hostPath`'s separator to a `/`-joined path derived from it.
 *
 * Without this a Windows machine's worktree and chat paths surface as
 * `C:/Users/x/.lody/...` while every path the CLI builds with `path.join` (local
 * project roots, the chat workdir the daemon actually creates) is `C:\Users\x\...`.
 * The two spellings name one directory but never compare equal, and the mixed form
 * is what the user sees in the workspace path, path launchers and workdir errors.
 */
function toHostSeparators(joined: string, hostPath: string): string {
  return isWindowsStyleHostPath(hostPath)
    ? joined.replace(/\//g, '\\')
    : joined;
}

function normalizeLocalProjectPathForRepoId(p: string): string {
  const normalized = normalizePath(p.trim());
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/g, '');
}

// Hand-rolled SHA-256: `deriveRepoIdFromLocalProjectPath` is called synchronously
// in render (e.g. session-chat-interface useMemo). `crypto.subtle.digest` is async-only
// and `node:crypto` is unavailable in browsers. CLI/Node consumers should import the
// `node/worktree-paths` entrypoint instead, which overrides the digest with `node:crypto`.
const SHA256_INITIAL_HASH: number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rightRotate = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddingLength = (64 - ((bytes.length + 1 + 8) % 64)) % 64;
  const data = new Uint8Array(bytes.length + 1 + paddingLength + 8);
  data.set(bytes);
  data[bytes.length] = 0x80;

  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(data.length - 4, bitLength >>> 0);

  const hash = [...SHA256_INITIAL_HASH];
  const words = new Array<number>(64).fill(0);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rightRotate(words[i - 15] ?? 0, 7) ^
        rightRotate(words[i - 15] ?? 0, 18) ^
        ((words[i - 15] ?? 0) >>> 3);
      const s1 =
        rightRotate(words[i - 2] ?? 0, 17) ^
        rightRotate(words[i - 2] ?? 0, 19) ^
        ((words[i - 2] ?? 0) >>> 10);
      words[i] =
        (((words[i - 16] ?? 0) + s0 + (words[i - 7] ?? 0) + s1) >>> 0) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 =
        rightRotate(e ?? 0, 6) ^
        rightRotate(e ?? 0, 11) ^
        rightRotate(e ?? 0, 25);
      const ch = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temp1 =
        (((h ?? 0) + s1 + ch + SHA256_K[i]! + words[i]!) >>> 0) >>> 0;
      const s0 =
        rightRotate(a ?? 0, 2) ^
        rightRotate(a ?? 0, 13) ^
        rightRotate(a ?? 0, 22);
      const maj =
        ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = ((d ?? 0) + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = ((hash[0] ?? 0) + (a ?? 0)) >>> 0;
    hash[1] = ((hash[1] ?? 0) + (b ?? 0)) >>> 0;
    hash[2] = ((hash[2] ?? 0) + (c ?? 0)) >>> 0;
    hash[3] = ((hash[3] ?? 0) + (d ?? 0)) >>> 0;
    hash[4] = ((hash[4] ?? 0) + (e ?? 0)) >>> 0;
    hash[5] = ((hash[5] ?? 0) + (f ?? 0)) >>> 0;
    hash[6] = ((hash[6] ?? 0) + (g ?? 0)) >>> 0;
    hash[7] = ((hash[7] ?? 0) + (h ?? 0)) >>> 0;
  }

  return hash.map((part) => part.toString(16).padStart(8, '0')).join('');
}

function normalizeDotlodyPath(dotlodyPath: string): string {
  const normalized = normalizePath(dotlodyPath.trim());
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/g, '');
}

function deriveRepoIdFromLocalProjectPath(absolutePath: string): string {
  const normalized = normalizeLocalProjectPathForRepoId(absolutePath);
  if (!normalized) throw new Error('invalid_path');
  return `${LOCAL_REPO_ID_PREFIX}${sha256Hex(normalized).slice(0, 12)}`;
}

/** Web `resolveSessionWorkspacePath`: worktree, then project root / chat workdir, then legacy. */
export function resolveSessionWorkspacePath(args: {
  sessionId: string;
  ownerSessionId?: string | null;
  isWorktree?: boolean;
  dotlodyPath?: string | null;
  localProjectRootPath?: string | null;
  repoFullName?: string | null;
  legacyWorkspacePath?: string | null;
}): string | null {
  const dotlodyPath = args.dotlodyPath?.trim();
  const localProjectRootPath = args.localProjectRootPath?.trim();
  const repoFullName = args.repoFullName?.trim();
  const legacyWorkspacePath = args.legacyWorkspacePath?.trim();
  const ownerSessionId = args.ownerSessionId || args.sessionId;

  if (args.isWorktree === true && dotlodyPath) {
    try {
      const repoId = localProjectRootPath
        ? deriveRepoIdFromLocalProjectPath(localProjectRootPath)
        : repoFullName
          ? deriveRepoIdFromGitHubRepo(repoFullName)
          : null;
      if (repoId) {
        assertSafeSessionId(ownerSessionId);
        return toHostSeparators(
          `${normalizeDotlodyPath(dotlodyPath)}/repos/${repoId}/worktrees/${ownerSessionId}`,
          dotlodyPath,
        );
      }
    } catch {
      // Fall through to the legacy path below.
    }
  }

  if (args.isWorktree !== true) {
    if (localProjectRootPath) return localProjectRootPath;
    if (dotlodyPath) {
      try {
        assertSafeSessionId(ownerSessionId);
        return toHostSeparators(
          `${normalizeDotlodyPath(dotlodyPath)}/chats/${ownerSessionId}`,
          dotlodyPath,
        );
      } catch {
        // Fall through to the legacy path below.
      }
    }
  }

  return legacyWorkspacePath || null;
}
