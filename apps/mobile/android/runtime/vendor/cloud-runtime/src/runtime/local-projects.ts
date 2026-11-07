import { Flock } from '@loro-dev/flock-wasm/base64';
import { clientFor } from './session';
import { machineRpc } from './machine-rpc';
import { encodeFrame } from '../frames';
import type { Project } from '../models/catalog.ts';

type Grant = () => Promise<{ token: string; gatewayBaseUrl: string }>;
export type Directory = {
  path: string;
  parentPath: string | null;
  entries: { name: string; absolutePath: string; error?: string }[];
  truncated: boolean;
  nextCursor?: string;
};

export async function projectControl(
  workspaceId: string,
  machineId: string,
  request: Record<string, unknown>,
  getGrant: Grant,
  signal: AbortSignal,
) {
  const reply = await machineRpc(
    workspaceId,
    machineId,
    'local-project/control',
    { request: { ...request, workspaceId, machineId } },
    getGrant,
    signal,
  );
  const result = reply.result as
    | { ok?: boolean; type?: string; message?: string; result?: unknown }
    | undefined;
  if (reply.error || !result?.ok)
    throw new Error(
      reply.error?.message ?? result?.message ?? 'project_request_failed',
    );
  if (result.type !== request.type) throw new Error('invalid_project_response');
  return result.result as Record<string, unknown>;
}

export function directoryResult(value: Record<string, unknown>): Directory {
  if (
    typeof value.path !== 'string' ||
    !value.path ||
    !Array.isArray(value.entries) ||
    !(value.parentPath === null || typeof value.parentPath === 'string') ||
    (value.truncated &&
      (typeof value.nextCursor !== 'string' || !value.nextCursor))
  )
    throw new Error('invalid_directory');
  return {
    path: value.path,
    parentPath: value.parentPath as string | null,
    entries: value.entries.map((entry) => {
      if (
        !entry ||
        typeof entry.name !== 'string' ||
        typeof entry.absolutePath !== 'string'
      )
        throw new Error('invalid_directory');
      return {
        name: entry.name,
        absolutePath: entry.absolutePath,
        ...(entry.error ? { error: String(entry.error) } : {}),
      };
    }),
    truncated: !!value.truncated,
    nextCursor:
      typeof value.nextCursor === 'string' ? value.nextCursor : undefined,
  };
}

// A lost append ACK must not turn a second tap into a second write.
const uncertain = new Set<string>();
export async function registerProject(
  workspaceId: string,
  machineId: string,
  prepared: Record<string, unknown>,
  flock: Flock,
  getGrant: Grant,
  signal: AbortSignal,
): Promise<Project> {
  const { localProjectId, name, rootPath } = prepared;
  if (
    typeof localProjectId !== 'string' ||
    !localProjectId ||
    typeof name !== 'string' ||
    !name ||
    typeof rootPath !== 'string' ||
    !rootPath
  )
    throw new Error('invalid_project_response');
  const project = (value: Record<string, unknown>): Project => {
    if (typeof value.name !== 'string' || typeof value.rootPath !== 'string')
      throw new Error('invalid_project');
    return {
      id: `${machineId}:local:${localProjectId}`,
      machineId,
      name: value.name,
      rootPath: value.rootPath,
    };
  };
  if (flock.get(['cmd', 'deleteLocalProject', localProjectId]) !== undefined)
    throw new Error('project_removal_pending');
  const existing = flock.get(['localProject', localProjectId]);
  if (existing) return project(existing as Record<string, unknown>);
  if (prepared.alreadyRegistered) throw new Error('project_sync_pending');
  const key = `${workspaceId}:${machineId}:${localProjectId}`;
  if (uncertain.has(key)) throw new Error('project_write_unknown');
  const write = new Flock(`lody-ios-project-${crypto.randomUUID()}`);
  const now = Date.now();
  const value = {
    id: localProjectId,
    name,
    rootPath,
    createdAtMs: now,
    lastOpenedAtMs: now,
  };
  write.set(['localProject', localProjectId], value);
  write.commit();
  const update = write.exportJson();
  const client = await clientFor(`${workspaceId}:mf:${machineId}`, getGrant);
  signal.throwIfAborted();
  uncertain.add(key);
  try {
    const result = await client.append({
      part: {
        contentType: 'application/octet-stream',
        body: encodeFrame(new TextEncoder().encode(JSON.stringify(update))),
      },
    });
    if (!result.ok) throw new Error(result.result.code);
  } catch {
    throw new Error('project_write_unknown');
  }
  flock.importJson(update);
  uncertain.delete(key);
  return project(value);
}
