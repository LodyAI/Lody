import { Flock } from '@loro-dev/flock-wasm/base64';
import { decompress } from 'fzstd';
import { clientFor } from './session';
import { decodeFrames, encodeFrame } from '../frames';
import type { RemoteSetting, SettingsRequest } from '../models/settings.ts';

type Grant = () => Promise<{ token: string; gatewayBaseUrl: string }>;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

// Settings are read on demand inside the native-owned runtime. Each stream's last
// read stays cached for this runtime, so the next open only catches up from its
// offset instead of bootstrapping the whole history. Callers always receive a
// private copy: a write that fails to append never leaks into the cache, and a
// fresh catch-up before an edit still preserves fields another client changed.
type Cached = {
  flock: Flock;
  offset: string;
  cursor: string | undefined;
  size: number;
};
const replicas = new Map<string, Cached>();
const SETTINGS_LIMIT = 8 * 1024 * 1024;

/** Drops every cached settings read (a new account or workspace). */
export function forgetSettings() {
  replicas.clear();
}

function copy(flock: Flock) {
  const result = new Flock(`lody-ios-settings-${crypto.randomUUID()}`);
  result.importFile(flock.exportFile());
  return result;
}

async function catchUp(
  client: Awaited<ReturnType<typeof clientFor>>,
  cached: Cached,
  signal: AbortSignal,
) {
  const apply = (bytes: Uint8Array) => {
    cached.size += bytes.length;
    if (cached.size > SETTINGS_LIMIT) throw new Error('catalog_limit');
    for (const frame of decodeFrames(bytes))
      cached.flock.importJson(JSON.parse(new TextDecoder().decode(frame)));
  };
  for (let page = 0; ; page++) {
    signal.throwIfAborted();
    if (page >= 100) throw new Error('catalog_limit');
    const next = await client.readOnce({
      offset: cached.offset,
      cursor: cached.cursor,
      signal,
    });
    if (!next.ok) throw new Error(next.result.code);
    if (next.result.payload) apply(next.result.payload.body);
    if (next.result.upToDate) {
      cached.offset = next.result.nextOffset;
      cached.cursor = next.result.cursor;
      return;
    }
    if (cached.offset === next.result.nextOffset)
      throw new Error('stalled_cursor');
    cached.offset = next.result.nextOffset;
    cached.cursor = next.result.cursor;
  }
}

export async function openSettings(
  stream: string,
  grant: Grant,
  signal: AbortSignal,
) {
  const client = await clientFor(stream, grant);
  const cached = replicas.get(stream);
  if (cached) {
    try {
      await catchUp(client, cached, signal);
      return { flock: copy(cached.flock), client };
    } catch (error) {
      replicas.delete(stream);
      if (signal.aborted) throw error;
    }
  }
  const initial = await client.bootstrap({ signal });
  if (!initial.ok) throw new Error(initial.result.code);
  const flock = new Flock(`lody-ios-settings-${crypto.randomUUID()}`);
  const data = initial.result;
  let size = 0;
  const bound = (bytes: Uint8Array) => {
    size += bytes.length;
    if (size > SETTINGS_LIMIT) throw new Error('catalog_limit');
  };
  const apply = (bytes: Uint8Array) => {
    bound(bytes);
    for (const frame of decodeFrames(bytes))
      flock.importJson(JSON.parse(new TextDecoder().decode(frame)));
  };
  if (data.snapshotOffset !== '-1' && data.snapshot) {
    const bytes = data.snapshot.body;
    bound(bytes);
    flock.importFile(
      bytes[0] === 0x28 &&
        bytes[1] === 0xb5 &&
        bytes[2] === 0x2f &&
        bytes[3] === 0xfd
        ? decompress(bytes)
        : bytes,
    );
  }
  for (const part of data.updates) apply(part.body);
  let offset = data.nextOffset,
    cursor = data.cursor,
    upToDate = data.upToDate;
  for (let page = 0; !upToDate; page++) {
    signal.throwIfAborted();
    if (page >= 100) throw new Error('catalog_limit');
    const next = await client.readOnce({ offset, cursor, signal });
    if (!next.ok) throw new Error(next.result.code);
    if (next.result.payload) apply(next.result.payload.body);
    if (offset === next.result.nextOffset && !next.result.upToDate)
      throw new Error('stalled_cursor');
    ({ nextOffset: offset, cursor, upToDate } = next.result);
  }
  if (replicas.size >= 64) replicas.delete(replicas.keys().next().value!);
  replicas.set(stream, { flock, offset, cursor, size });
  return { flock: copy(flock), client };
}

export function settingsRows(
  kind: RemoteSetting['kind'],
  flock: Flock,
  machineId?: string,
): RemoteSetting[] {
  const rows: RemoteSetting[] = [];
  for (const row of flock.scan()) {
    if (row.key.length !== 2) continue;
    const id = text(row.key[1]),
      value = object(row.value);
    if (kind === 'machine') {
      if (
        row.key[0] !== 'e' ||
        !id.startsWith('machine-') ||
        row.value !== true
      )
        continue;
      const metadata = object(flock.get(['m', id]));
      rows.push({
        kind,
        id: id.slice(8),
        name: text(flock.get(['m', id, 'name']) ?? metadata.name),
        detail: text(flock.get(['m', id, 'os']) ?? metadata.os),
      });
    } else if (kind === 'agent') {
      if (
        row.key[0] !== 'agentConfig' ||
        value.id !== id ||
        value.machineId !== machineId
      )
        continue;
      rows.push({
        kind,
        id,
        machineId,
        name: text(value.name),
        prompt: text(value.prompt),
        detail: text(value.agentType),
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function editSetting(flock: Flock, request: SettingsRequest) {
  const edit = request.edit;
  if (
    !edit ||
    edit.item.kind !== request.kind ||
    !edit.item.id ||
    typeof edit.name !== 'string'
  )
    throw new Error('invalid_setting');
  const name = edit.name.trim();
  if (!name || name.length > 200 || name.includes('\0'))
    throw new Error('invalid_setting');
  const current = settingsRows(request.kind, flock, edit.item.machineId).find(
    (row) => row.id === edit.item.id,
  );
  if (!current) throw new Error('setting_not_found');
  const fields = ['name', 'prompt'] as const;
  for (const field of fields)
    if (edit[field] !== undefined && current[field] !== edit.item[field])
      throw new Error('setting_conflict');
  if (request.kind === 'machine') {
    flock.set(['m', `machine-${current.id}`, 'name'], name);
  } else {
    const key = ['agentConfig', current.id];
    const value = { ...object(flock.get(key)), name };
    if (
      typeof edit.prompt !== 'string' ||
      edit.prompt.length > 32000 ||
      edit.prompt.includes('\0')
    )
      throw new Error('invalid_setting');
    Object.assign(value, { prompt: edit.prompt });
    flock.set(key, value);
  }
  flock.commit();
}

export async function remoteSettings(
  request: SettingsRequest,
  userId: string,
  grant: Grant,
  signal: AbortSignal,
) {
  if (!['machine', 'agent'].includes(request.kind))
    throw new Error('invalid_setting');
  const { workspaceId, kind, edit } = request;
  const writing = !!edit;
  const meta = await openSettings(`${workspaceId}:meta`, grant, signal);
  const machines = settingsRows('machine', meta.flock);
  const owned = (id: string) => {
    const room = `machine-${id}`;
    const owner =
      meta?.flock.get(['m', room, 'ownerUserId']) ??
      object(meta?.flock.get(['m', room])).ownerUserId;
    return !!userId && owner === userId;
  };
  let ids = machines.map((machine) => machine.id);
  if (
    edit &&
    !owned(kind === 'machine' ? edit.item.id : (edit.item.machineId ?? ''))
  )
    throw new Error('setting_read_only');
  if (kind === 'agent' && edit) {
    if (!edit.item.machineId || !ids.includes(edit.item.machineId))
      throw new Error('machine_unavailable');
    ids = [edit.item.machineId];
  }
  let streams: { stream: string; machineId?: string }[];
  if (kind === 'agent')
    streams = ids.map((id) => ({
      stream: `${workspaceId}:mf:${id}`,
      machineId: id,
    }));
  else
    streams = [
      {
        stream: `${workspaceId}:meta`,
      },
    ];
  const result: RemoteSetting[] = [];
  for (const { stream, machineId } of streams) {
    let replica;
    try {
      replica =
        kind === 'machine' && meta
          ? meta
          : await openSettings(stream, grant, signal);
    } catch (error) {
      if (
        !writing &&
        kind !== 'machine' &&
        error instanceof Error &&
        error.message === 'not_found'
      )
        continue;
      throw error;
    }
    const { flock, client } = replica;
    if (writing) {
      const version = flock.version();
      editSetting(flock, request);
      signal.throwIfAborted();
      const saved = await client.append({
        part: {
          contentType: 'application/octet-stream',
          body: encodeFrame(
            new TextEncoder().encode(JSON.stringify(flock.exportJson(version))),
          ),
        },
      });
      if (!saved.ok) {
        if (saved.result.code === 'forbidden')
          throw new Error('setting_read_only');
        throw new Error('setting_write_unknown');
      }
    }
    result.push(
      ...settingsRows(kind, flock, machineId).map((item) => ({
        ...item,
        readOnly: !owned(machineId ?? item.id),
        ...(machineId
          ? {
              machineName: machines.find((machine) => machine.id === machineId)
                ?.name,
            }
          : {}),
      })),
    );
  }
  return result;
}
