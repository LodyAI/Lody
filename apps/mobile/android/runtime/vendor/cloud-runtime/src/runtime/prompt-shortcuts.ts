import { LoroDoc } from 'loro-crdt/base64';
import { decompress } from 'fzstd';
import { clientFor } from './session';
import { openSettings } from './settings';
import { decodeFrames, encodeFrame } from '../frames';
import {
  getShortcutBodyStreamId,
  getShortcutIndexStreamId,
} from '../protocol/prompt-shortcuts/access.ts';
import {
  PromptShortcutCatalog,
  parseShortcutIndex,
  projectShortcutIndex,
  type PromptShortcutIndexEntry,
} from '../protocol/prompt-shortcuts/catalog.ts';
import { PromptShortcutDocument } from '../protocol/prompt-shortcuts/document.ts';
import { parsePromptShortcut } from '../protocol/prompt-shortcuts/compiler.ts';
import {
  simpleShortcut,
  type ShortcutRequest,
} from '../models/prompt-shortcuts.ts';
import { z } from 'zod';

type Cloud = (
  operation: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
const directorySchema = z
  .array(
    z.object({
      shortcutId: z.string().min(1).max(200),
      bodyDocId: z.string().min(1).max(200),
      ownerUserId: z.string().min(1).max(200),
      visibility: z.enum(['private', 'workspace']),
      revision: z.string().nullable(),
      deleted: z.boolean().optional(),
    }),
  )
  .max(10000);

export function shortcutAccess(
  workspaceId: string,
  userId: string,
  cloud: Cloud,
  signal: AbortSignal,
) {
  const directory = async () =>
    directorySchema
      .parse(await cloud('listAccessibleDocuments', {}))
      .filter(
        (row) =>
          !row.deleted &&
          (row.visibility === 'workspace' || row.ownerUserId === userId),
      );
  const authorized = async (entry: PromptShortcutIndexEntry) => {
    if (
      entry.workspaceId !== workspaceId ||
      !(await directory()).some(
        (row) =>
          row.shortcutId === entry.id &&
          row.bodyDocId === entry.bodyDocId &&
          row.revision === entry.revision &&
          row.ownerUserId === entry.ownerUserId &&
          row.visibility === entry.visibility,
      )
    )
      throw new Error('shortcut_changed');
  };
  const grant =
    (streamId: string, target: object, write: boolean) => async () => {
      signal.throwIfAborted();
      const value = z
        .object({
          token: z.string().min(1),
          expiresIn: z.number().positive(),
          gatewayBaseUrl: z
            .string()
            .url()
            .refine((url) => url.startsWith('https://')),
          streamId: z.literal(streamId),
        })
        .parse(await cloud('getStreamToken', { target, write }));
      signal.throwIfAborted();
      return value;
    };
  const index = async (
    ownerUserId: string,
    visibility: 'private' | 'workspace',
    write = false,
  ) => {
    const stream = getShortcutIndexStreamId({
      workspaceId,
      ownerUserId,
      visibility,
    });
    const getGrant = grant(
      stream,
      { kind: 'index', ownerUserId, visibility },
      write,
    );
    if (write) {
      const client = await clientFor(stream, getGrant);
      const created = await client.create({
        contentType: 'application/octet-stream',
      });
      if (!created.ok) throw new Error('shortcut_write_unknown');
    }
    return openSettings(stream, getGrant, signal);
  };
  const list = async () => {
    const rows = await directory();
    const domains = new Map(
      rows.map((row) => [`${row.ownerUserId}:${row.visibility}`, row]),
    );
    const entries: PromptShortcutIndexEntry[] = [];
    for (const row of domains.values()) {
      const { flock } = await index(row.ownerUserId, row.visibility);
      entries.push(
        ...new PromptShortcutCatalog(flock)
          .list()
          .filter(
            (entry) =>
              entry.workspaceId === workspaceId &&
              entry.ownerUserId === row.ownerUserId &&
              entry.visibility === row.visibility &&
              rows.some(
                (access) =>
                  access.shortcutId === entry.id &&
                  access.bodyDocId === entry.bodyDocId &&
                  access.revision === entry.revision,
              ),
          ),
      );
    }
    const fresh = await directory();
    if (
      fresh.some(
        (row) =>
          !entries.some(
            (entry) =>
              entry.id === row.shortcutId &&
              entry.bodyDocId === row.bodyDocId &&
              entry.revision === row.revision,
          ),
      )
    )
      throw new Error('shortcut_index_pending');
    return entries
      .filter((entry) =>
        fresh.some(
          (row) =>
            row.shortcutId === entry.id &&
            row.bodyDocId === entry.bodyDocId &&
            row.revision === entry.revision,
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  const read = async (entry: PromptShortcutIndexEntry) => {
    await authorized(entry);
    const stream = getShortcutBodyStreamId(entry.bodyDocId);
    const client = await clientFor(
      stream,
      grant(stream, { kind: 'body', bodyDocId: entry.bodyDocId }, false),
    );
    const first = await client.bootstrap({ signal });
    if (!first.ok) throw new Error('shortcut_unavailable');
    const doc = new LoroDoc();
    let bytesRead = 0;
    const bound = (bytes: Uint8Array) => {
      bytesRead += bytes.length;
      if (bytesRead > 8 * 1024 * 1024) throw new Error('shortcut_limit');
    };
    const apply = (bytes: Uint8Array) => {
      bound(bytes);
      for (const frame of decodeFrames(bytes)) doc.import(frame);
    };
    const data = first.result;
    if (data.snapshotOffset !== '-1' && data.snapshot) {
      const bytes = data.snapshot.body;
      bound(bytes);
      doc.import(
        bytes[0] === 0x28 &&
          bytes[1] === 0xb5 &&
          bytes[2] === 0x2f &&
          bytes[3] === 0xfd
          ? decompress(bytes)
          : bytes,
      );
    }
    for (const part of data.updates) apply(part.body);
    let { nextOffset: offset, cursor, upToDate } = data;
    for (let page = 0; !upToDate; page++) {
      if (page >= 100) throw new Error('shortcut_limit');
      const next = await client.readOnce({ offset, cursor, signal });
      if (!next.ok) throw new Error('shortcut_unavailable');
      if (next.result.payload) apply(next.result.payload.body);
      if (offset === next.result.nextOffset && !next.result.upToDate)
        throw new Error('stalled_cursor');
      ({ nextOffset: offset, cursor, upToDate } = next.result);
    }
    const value = new PromptShortcutDocument(doc).read();
    if (
      !value ||
      JSON.stringify(projectShortcutIndex(value, entry.bodyDocId)) !==
        JSON.stringify(entry)
    )
      throw new Error('shortcut_changed');
    await authorized(entry);
    return value;
  };
  return { list, read, authorized, index, grant, directory };
}

export async function promptShortcuts(
  request: ShortcutRequest,
  userId: string,
  cloud: Cloud,
  signal: AbortSignal,
) {
  if (!userId) throw new Error('shortcut_unavailable');
  const access = shortcutAccess(request.workspaceId, userId, cloud, signal);
  if (request.action === 'list') return access.list();
  if (request.action === 'read')
    return access.read(parseShortcutIndex(request.entry));
  if (request.action !== 'save') throw new Error('invalid_shortcut');
  const value = parsePromptShortcut(request.value);
  if (
    value.workspaceId !== request.workspaceId ||
    value.ownerUserId !== userId ||
    !simpleShortcut(value) ||
    !value.prompt.trim()
  )
    throw new Error('invalid_shortcut');
  const base = request.entry ? parseShortcutIndex(request.entry) : null;
  if (
    base &&
    (base.id !== value.id ||
      base.ownerUserId !== userId ||
      !simpleShortcut(base))
  )
    throw new Error('invalid_shortcut');
  if (
    base &&
    (request.bodyDocId === base.bodyDocId ||
      value.createdAt !== base.createdAt ||
      value.visibility !== base.visibility ||
      value.revision === base.revision)
  )
    throw new Error('invalid_shortcut');
  const entry = projectShortcutIndex(value, request.bodyDocId);
  // Explicit retry uses the same body/revision. An activated save only repairs
  // its index; no recovery path automatically replays an uncertain write.
  const active = (await access.directory()).find(
    (row) => row.shortcutId === value.id,
  );
  const alreadyActive =
    active?.bodyDocId === entry.bodyDocId && active.revision === entry.revision;
  if (!alreadyActive) {
    if (base) await access.read(base);
    else if (active) throw new Error('shortcut_changed');
    const current = await access.index(userId, entry.visibility, true);
    new PromptShortcutCatalog(current.flock).put(entry); // Validate slug/quota before staging.
    signal.throwIfAborted();
    const staged = z
      .object({
        bodyDocId: z.literal(entry.bodyDocId),
        status: z.enum(['staged', 'active']),
      })
      .parse(
        await cloud('stageDocument', {
          ownerUserId: userId,
          shortcutId: entry.id,
          bodyDocId: entry.bodyDocId,
          visibility: entry.visibility,
        }),
      );
    if (staged.status === 'staged') {
      const stream = getShortcutBodyStreamId(entry.bodyDocId);
      const client = await clientFor(
        stream,
        access.grant(
          stream,
          { kind: 'body', bodyDocId: entry.bodyDocId },
          true,
        ),
      );
      const created = await client.create({
        contentType: 'application/octet-stream',
      });
      if (!created.ok) throw new Error('shortcut_write_unknown');
      const doc = new LoroDoc();
      // A publication forks the previous body; ancestry never leaks across visibility.
      new PromptShortcutDocument(doc).save(value, []);
      const append = await client.append({
        part: {
          contentType: 'application/octet-stream',
          body: encodeFrame(doc.export({ mode: 'snapshot' })),
        },
      });
      if (!append.ok) throw new Error('shortcut_write_unknown');
      signal.throwIfAborted();
      await cloud('activateDocument', {
        bodyDocId: entry.bodyDocId,
        previousBodyDocId: base?.bodyDocId ?? null,
        previousRevision: base?.revision ?? null,
        revision: entry.revision,
        slug: entry.slug,
        indexBytes: new TextEncoder().encode(JSON.stringify(entry)).length,
      });
    }
  }
  const published = await access.read(entry);
  if (JSON.stringify(published) !== JSON.stringify(value))
    throw new Error('shortcut_changed');
  const { flock, client } = await access.index(userId, entry.visibility, true);
  await access.authorized(entry);
  const version = flock.version();
  new PromptShortcutCatalog(flock).put(entry);
  signal.throwIfAborted();
  const saved = await client.append({
    part: {
      contentType: 'application/octet-stream',
      body: encodeFrame(
        new TextEncoder().encode(JSON.stringify(flock.exportJson(version))),
      ),
    },
  });
  if (!saved.ok) throw new Error('shortcut_write_unknown');
  return entry;
}

export async function expandShortcuts(
  text: string,
  list: () => Promise<PromptShortcutIndexEntry[]>,
  read: (
    entry: PromptShortcutIndexEntry,
  ) => Promise<{ prompt: string; scope: object; mentions: unknown[] }>,
  expandRest: (text: string) => Promise<string> = async (text) => text,
) {
  const pattern = /(^|\s)\/shortcut:([a-z0-9][a-z0-9-]{0,39})(?=\s|$)/g;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return expandRest(text);
  const entries = await list().catch(() => {
    throw new Error('shortcut_unavailable');
  });
  let result = '',
    offset = 0;
  for (const match of matches) {
    const candidates = entries.filter((entry) => entry.slug === match[2]);
    if (!candidates.length) throw new Error('shortcut_unavailable');
    if (candidates.length !== 1 || !simpleShortcut(candidates[0]))
      throw new Error('shortcut_unavailable');
    const value = await read(candidates[0]).catch(() => {
      throw new Error('shortcut_unavailable');
    });
    if (!simpleShortcut(value)) throw new Error('shortcut_unavailable');
    result +=
      (await expandRest(text.slice(offset, match.index))) +
      match[1] +
      value.prompt;
    offset = match.index! + match[0].length;
  }
  return result + (await expandRest(text.slice(offset)));
}
