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

// Settings are read on demand inside the native-owned runtime. A fresh bootstrap
// before an edit preserves fields changed by another client while the editor was open.
export async function openSettings(
  stream: string,
  grant: Grant,
  signal: AbortSignal,
) {
  const client = await clientFor(stream, grant);
  const initial = await client.bootstrap({ signal });
  if (!initial.ok) throw new Error(initial.result.code);
  const flock = new Flock(`lody-ios-settings-${crypto.randomUUID()}`);
  const data = initial.result;
  let size = 0;
  const bound = (bytes: Uint8Array) => {
    size += bytes.length;
    if (size > 8 * 1024 * 1024) throw new Error('catalog_limit');
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
  return { flock, client };
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
    } else {
      if (
        row.key[0] !== 'mcpServer' ||
        value.id !== id ||
        !['stdio', 'http'].includes(text(value.transport))
      )
        continue;
      rows.push({
        kind,
        id,
        name: text(value.name),
        detail: text(value.transport),
        enabledByDefault: value.enabledByDefault === true,
        configured:
          object(value.connection).transport === value.transport &&
          (value.transport === 'http'
            ? !!text(object(value.connection).url).trim()
            : !!text(object(value.connection).command).trim()),
        updatedAt:
          typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function editSetting(flock: Flock, request: SettingsRequest) {
  if (request.remove) {
    const item = request.remove;
    if (
      request.edit ||
      request.kind !== 'mcp' ||
      item.kind !== 'mcp' ||
      !item.id
    )
      throw new Error('invalid_setting');
    const current = settingsRows('mcp', flock).find(
      (row) => row.id === item.id,
    );
    if (!current) throw new Error('setting_not_found');
    if (
      ['name', 'enabledByDefault', 'detail', 'configured', 'updatedAt'].some(
        (field) =>
          current[field as keyof RemoteSetting] !==
          item[field as keyof RemoteSetting],
      )
    )
      throw new Error('setting_conflict');
    flock.delete(['mcpServer', item.id]);
    flock.commit();
    return;
  }
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
  if (
    request.kind === 'mcp' &&
    edit.enabledByDefault &&
    current.configured === false
  )
    throw new Error('mcp_connection_missing');
  const fields = ['name', 'prompt', 'enabledByDefault'] as const;
  for (const field of fields)
    if (edit[field] !== undefined && current[field] !== edit.item[field])
      throw new Error('setting_conflict');
  if (request.kind === 'machine') {
    flock.set(['m', `machine-${current.id}`, 'name'], name);
  } else {
    const key = [
      request.kind === 'agent' ? 'agentConfig' : 'mcpServer',
      current.id,
    ];
    const value = { ...object(flock.get(key)), name };
    if (request.kind === 'agent') {
      if (
        typeof edit.prompt !== 'string' ||
        edit.prompt.length > 32000 ||
        edit.prompt.includes('\0')
      )
        throw new Error('invalid_setting');
      Object.assign(value, { prompt: edit.prompt });
    } else {
      if (typeof edit.enabledByDefault !== 'boolean')
        throw new Error('invalid_setting');
      if (
        settingsRows('mcp', flock).some(
          (row) =>
            row.id !== current.id &&
            row.name.localeCompare(name, undefined, {
              sensitivity: 'accent',
            }) === 0,
        )
      )
        throw new Error('setting_duplicate');
      Object.assign(value, {
        enabledByDefault: edit.enabledByDefault,
        updatedAt: Date.now(),
      });
    }
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
  if (!['machine', 'agent', 'mcp'].includes(request.kind))
    throw new Error('invalid_setting');
  const { workspaceId, kind, edit, remove } = request;
  const writing = !!(edit || remove);
  if (remove && (kind !== 'mcp' || edit)) throw new Error('invalid_setting');
  const meta =
    kind === 'mcp'
      ? undefined
      : await openSettings(`${workspaceId}:meta`, grant, signal);
  const machines = meta ? settingsRows('machine', meta.flock) : [];
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
    kind !== 'mcp' &&
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
        stream: `${workspaceId}:${kind === 'machine' ? 'meta' : 'wf:workspace'}`,
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
        readOnly: kind !== 'mcp' && !owned(machineId ?? item.id),
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
