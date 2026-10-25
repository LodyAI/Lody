import { z } from 'zod';
import { ProjectMemberIdSchema, type ProjectMemberId } from './workspace-project';

export const MAIN_SESSION_FILE_ROOT_ID = 'main';
export function getProjectMemberRootId(memberId: ProjectMemberId | string): string {
  return `member:${ProjectMemberIdSchema.parse(memberId)}`;
}
export function parseProjectMemberRootId(rootId: string): ProjectMemberId | undefined {
  if (!rootId.startsWith('member:')) return undefined;
  const parsed = ProjectMemberIdSchema.safeParse(rootId.slice(7));
  return parsed.success ? parsed.data : undefined;
}
export const SessionFileRootIdSchema = z
  .string()
  .refine((id) => id === MAIN_SESSION_FILE_ROOT_ID || parseProjectMemberRootId(id) !== undefined);

// NUL cannot occur in a filesystem name. This is a wire key, NEVER a filesystem path.
const MEMBER_FILE_KEY_PREFIX = '\0lody-root:';
function isRelativeFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
/** Main paths stay byte-for-byte unchanged. Decode member keys before using filesystem APIs. */
export function encodeSessionFilePath(path: SessionFilePath): string {
  SessionFileRootIdSchema.parse(path.rootId);
  if (!isRelativeFilePath(path.relativePath)) throw new Error('Invalid session file path');
  return path.rootId === MAIN_SESSION_FILE_ROOT_ID
    ? path.relativePath
    : `${MEMBER_FILE_KEY_PREFIX}${path.rootId}/${path.relativePath}`;
}
export function decodeSessionFilePath(value: string): SessionFilePath | undefined {
  let rootId = MAIN_SESSION_FILE_ROOT_ID;
  let relativePath = value;
  if (value.startsWith(MEMBER_FILE_KEY_PREFIX)) {
    const suffix = value.slice(MEMBER_FILE_KEY_PREFIX.length);
    const slash = suffix.indexOf('/');
    if (slash < 0) return undefined;
    rootId = suffix.slice(0, slash);
    relativePath = suffix.slice(slash + 1);
    if (!parseProjectMemberRootId(rootId)) return undefined;
  }
  return isRelativeFilePath(relativePath) ? { rootId, relativePath } : undefined;
}

/** Machine-local roots. Never persist absolutePath in synced metadata. */
export type SessionFileRoot = { id: string; absolutePath: string };
export type SessionFilePath = { rootId: string; relativePath: string };

function normalizeAbsolutePath(input: string): string | undefined {
  if (Array.from(input).some((char) => char.charCodeAt(0) < 32)) return undefined;
  const windows =
    /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('//');
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
