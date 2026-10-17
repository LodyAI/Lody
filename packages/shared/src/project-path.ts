/** Machine-local roots. Never persist absolutePath in synced metadata. */
export type SessionFileRoot = { id: string; absolutePath: string };
export type SessionFilePath = { rootId: string; relativePath: string };

function normalizeAbsolutePath(input: string): string | undefined {
  if (Array.from(input).some((char) => char.charCodeAt(0) < 32)) return undefined;
  const windows = /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('//');
  const value = windows ? input.replace(/\\/g, '/') : input;
  const prefix = value.match(/^(?:[a-zA-Z]:\/|\/\/[^/]+\/[^/]+\/|\/)/)?.[0];
  if (!prefix) return undefined;
  const parts: string[] = [];
  for (const part of value.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return prefix + parts.join('/');
}

/** Lexical longest-root match. Filesystem callers must also check realpaths for symlink escapes. */
export function resolveSessionFilePath(
  roots: readonly SessionFileRoot[],
  absolutePath: string
): SessionFilePath | undefined {
  const target = normalizeAbsolutePath(absolutePath);
  if (!target) return undefined;
  let best: { length: number; path: SessionFilePath } | undefined;
  for (const root of roots) {
    const normalized = normalizeAbsolutePath(root.absolutePath);
    if (!normalized) continue;
    const base = normalized.replace(/\/$/, '');
    const windows = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//');
    const comparison = windows ? target.toLowerCase() : target;
    const rootComparison = windows ? base.toLowerCase() : base;
    if (comparison !== rootComparison && !comparison.startsWith(`${rootComparison}/`)) continue;
    if (!best || base.length > best.length)
      best = {
        length: base.length,
        path: { rootId: root.id, relativePath: target.slice(base.length).replace(/^\//, '') },
      };
  }
  return best?.path;
}
