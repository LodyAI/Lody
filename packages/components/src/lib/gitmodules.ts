/**
 * Read the submodule declarations of a `.gitmodules` file.
 *
 * Only `path` and `url` matter for Project group detection, so this is a
 * deliberately small reader of Git's config syntax: section headers, `key =
 * value` lines, `#`/`;` comments, and quoted values. Entries missing either key
 * are dropped rather than guessed.
 */
export type GitmodulesEntry = { name: string; path: string; url: string };

export function parseGitmodules(text: string): GitmodulesEntry[] {
  const entries: GitmodulesEntry[] = [];
  let current: { name: string; path?: string; url?: string } | null = null;
  const flush = () => {
    if (current?.path && current.url) {
      entries.push({ name: current.name, path: current.path, url: current.url });
    }
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*submodule\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(line);
    if (header) {
      flush();
      current = { name: header[1]!.replace(/\\(.)/g, '$1') };
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      current = null;
      continue;
    }
    if (!current) continue;
    const pair = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1]!.toLowerCase();
    let value = pair[2]!.replace(/\s+[#;].*$/, '').trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (key === 'path') current.path = value.replace(/\/+$/, '');
    else if (key === 'url') current.url = value;
  }
  flush();
  return entries;
}

/**
 * `owner/repo` for a github.com remote URL, in any of the forms Git accepts
 * (https, ssh, scp-like, git://), or `undefined` for anything else.
 */
export function parseGitHubRepoFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim();
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git:\/\/github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/\s]+@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      trimmed
    );
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

/**
 * Resolve a relative submodule URL (`../proto.git`) against the parent's
 * repository. Git resolves these against the superproject's remote, which for a
 * GitHub member is `https://github.com/<owner>/<repo>`.
 */
export function resolveSubmoduleRepo(
  url: string,
  parentRepoFullName: string | undefined
): string | undefined {
  const direct = parseGitHubRepoFromRemoteUrl(url);
  if (direct) return direct;
  if (!parentRepoFullName || !(url.startsWith('../') || url.startsWith('./'))) return undefined;
  const segments = parentRepoFullName.split('/');
  for (const part of url.replace(/\.git\/?$/, '').split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else segments.push(part);
  }
  return segments.length === 2 ? segments.join('/') : undefined;
}
