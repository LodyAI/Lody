export type WorkspaceWatchParentMessage =
  | {
      type: 'code-collab-watch/replace-roots';
      generation: number;
      revision: number;
      roots: string[];
    }
  | { type: 'code-collab-watch/shutdown'; generation: number };

export type WorkspaceWatchChildMessage =
  | {
      type: 'code-collab-watch/ready';
      generation: number;
      revision: number;
      watchedRoots: string[];
    }
  | { type: 'code-collab-watch/dirty'; generation: number; root: string }
  | { type: 'code-collab-watch/error'; generation: number; root: string; code: string }
  | {
      type: 'code-collab-watch/stats';
      generation: number;
      watcherCount: number;
      rssBytes: number;
      reconfigurationCount: number;
      uptimeMs: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGenerationMessage(value: unknown): value is Record<string, unknown> & {
  type: string;
  generation: number;
} {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseWorkspaceWatchParentMessage(
  value: unknown
): WorkspaceWatchParentMessage | null {
  if (!isGenerationMessage(value)) return null;
  if (value.type === 'code-collab-watch/shutdown') {
    return { type: value.type, generation: value.generation };
  }
  if (
    value.type === 'code-collab-watch/replace-roots' &&
    Number.isSafeInteger(value.revision) &&
    typeof value.revision === 'number' &&
    isStringArray(value.roots)
  ) {
    return {
      type: value.type,
      generation: value.generation,
      revision: value.revision,
      roots: value.roots,
    };
  }
  return null;
}

export function parseWorkspaceWatchChildMessage(value: unknown): WorkspaceWatchChildMessage | null {
  if (!isGenerationMessage(value)) return null;
  if (value.type === 'code-collab-watch/dirty' && typeof value.root === 'string') {
    return { type: value.type, generation: value.generation, root: value.root };
  }
  if (
    value.type === 'code-collab-watch/error' &&
    typeof value.root === 'string' &&
    typeof value.code === 'string'
  ) {
    return {
      type: value.type,
      generation: value.generation,
      root: value.root,
      code: value.code,
    };
  }
  if (
    value.type === 'code-collab-watch/ready' &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    isStringArray(value.watchedRoots)
  ) {
    return {
      type: value.type,
      generation: value.generation,
      revision: value.revision,
      watchedRoots: value.watchedRoots,
    };
  }
  if (
    value.type === 'code-collab-watch/stats' &&
    typeof value.watcherCount === 'number' &&
    typeof value.rssBytes === 'number' &&
    typeof value.reconfigurationCount === 'number' &&
    typeof value.uptimeMs === 'number'
  ) {
    return {
      type: value.type,
      generation: value.generation,
      watcherCount: value.watcherCount,
      rssBytes: value.rssBytes,
      reconfigurationCount: value.reconfigurationCount,
      uptimeMs: value.uptimeMs,
    };
  }
  return null;
}
