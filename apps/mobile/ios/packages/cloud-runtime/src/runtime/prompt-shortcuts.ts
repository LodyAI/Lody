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
  type PromptShortcut,
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

type Row = z.infer<typeof directorySchema>[number];
type Grant = { token: string; gatewayBaseUrl: string; expiresIn: number };

/**
 * What this runtime remembers for one workspace and account, so a shortcut opens without
 * network round trips. Mobile trades freshness for speed here: the access directory is
 * reused for `DIRECTORY_TTL` (saves and explicit refreshes re-read it), stream grants until
 * shortly before they expire, and a body for as long as its exact index entry is listed. A
 * body document is immutable once published (every save writes a new `bodyDocId`), so a
 * cached body is the one a fresh read would return; only a revocation can go unseen, and
 * only until the next directory read.
 */
type ShortcutScope = {
  key: string;
  directory?: { rows: Row[]; at: number };
  directoryPending?: Promise<Row[]>;
  grants: Map<string, { value: Promise<Grant>; until: number }>;
  bodies: Map<string, { entry: string; value: PromptShortcut }>;
  reads: Map<string, Promise<PromptShortcut>>;
  prefetch: PromptShortcutIndexEntry[];
  prefetching: boolean;
};
const DIRECTORY_TTL = 30_000;
const BODY_LIMIT = 500;
const PREFETCH_LIMIT = 100;
let currentScope: ShortcutScope | undefined;

function scopeFor(workspaceId: string, userId: string) {
  const key = `${workspaceId}:${userId}`;
  if (currentScope?.key !== key)
    currentScope = {
      key,
      grants: new Map(),
      bodies: new Map(),
      reads: new Map(),
      prefetch: [],
      prefetching: false,
    };
  return currentScope;
}

/** Drops every remembered shortcut read (a new account or workspace). */
export function forgetShortcuts() {
  currentScope = undefined;
  listings.clear();
}

export function shortcutAccess(
  workspaceId: string,
  userId: string,
  cloud: Cloud,
  signal: AbortSignal,
) {
  const scope = scopeFor(workspaceId, userId);
  const live = () => currentScope === scope;
  /** The rows this account may read; `fresh` skips the recent copy (writes, refresh). */
  const directory = async (fresh = false) => {
    const cached = scope.directory;
    if (!fresh && cached && Date.now() - cached.at < DIRECTORY_TTL)
      return cached.rows;
    if (!fresh && scope.directoryPending) return scope.directoryPending;
    const pending = cloud('listAccessibleDocuments', {})
      .then((value) => {
        const rows = directorySchema
          .parse(value)
          .filter(
            (row) =>
              !row.deleted &&
              (row.visibility === 'workspace' || row.ownerUserId === userId),
          );
        if (live()) scope.directory = { rows, at: Date.now() };
        return rows;
      })
      .finally(() => {
        if (scope.directoryPending === pending)
          scope.directoryPending = undefined;
      });
    scope.directoryPending = pending;
    const rows = await pending;
    signal.throwIfAborted();
    return rows;
  };
  const authorized = async (entry: PromptShortcutIndexEntry, fresh = false) => {
    if (
      entry.workspaceId !== workspaceId ||
      !(await directory(fresh)).some(
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
  // A grant serves every request of this runtime until shortly before it expires. The
  // fetch is shared, so it never observes one caller's abort signal.
  const grant =
    (streamId: string, target: object, write: boolean) => async () => {
      const key = `${write}:${streamId}`;
      const cached = scope.grants.get(key);
      if (cached && cached.until > Date.now()) return cached.value;
      const value = fetchGrant(streamId, target, write);
      const slot = { value, until: Date.now() + 30000 };
      scope.grants.set(key, slot);
      try {
        const resolved = await value;
        slot.until =
          Date.now() + Math.max(0, resolved.expiresIn * 1000 - 30000);
        return resolved;
      } catch (error) {
        if (scope.grants.get(key) === slot) scope.grants.delete(key);
        throw error;
      }
    };
  const fetchGrant = async (
    streamId: string,
    target: object,
    write: boolean,
  ): Promise<Grant> =>
    z
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
    return openSettings(stream, getGrant, signal, { cached: !write });
  };
  const listed = (entry: PromptShortcutIndexEntry, rows: Row[]) =>
    rows.some(
      (row) =>
        row.shortcutId === entry.id &&
        row.bodyDocId === entry.bodyDocId &&
        row.revision === entry.revision,
    );
  const domain = async (row: Row, rows: Row[]) => {
    const { flock } = await index(row.ownerUserId, row.visibility);
    return new PromptShortcutCatalog(flock)
      .list()
      .filter(
        (entry) =>
          entry.workspaceId === workspaceId &&
          entry.ownerUserId === row.ownerUserId &&
          entry.visibility === row.visibility &&
          listed(entry, rows),
      );
  };
  const domains = (rows: Row[]) => [
    ...new Map(
      rows.map((row) => [`${row.ownerUserId}:${row.visibility}`, row]),
    ).values(),
  ];
  const byName = (a: PromptShortcutIndexEntry, b: PromptShortcutIndexEntry) =>
    a.name.localeCompare(b.name);
  /** Send-time expansion: every directory row must have landed in its owner's index. */
  const list = async () => {
    const rows = await directory();
    const entries = (
      await Promise.all(domains(rows).map((row) => domain(row, rows)))
    ).flat();
    if (rows.some((row) => !entries.some((entry) => listed(entry, [row]))))
      throw new Error('shortcut_index_pending');
    return entries.sort(byName);
  };
  /**
   * Mention discovery: everything readable now. One owner's index that fails to read, or a
   * row whose index has not landed yet, leaves the rest listed and marks the result
   * incomplete instead of hiding every shortcut. Send-time expansion keeps the strict `list`;
   * a listed row is only a display, and reading its body re-checks the directory.
   */
  const listAvailable = async (fresh = false) => {
    const rows = await directory(fresh);
    let incomplete = false;
    const entries = (
      await Promise.all(
        domains(rows).map((row) =>
          domain(row, rows).catch(() => {
            signal.throwIfAborted();
            incomplete = true;
            return [];
          }),
        ),
      )
    ).flat();
    if (rows.some((row) => !entries.some((entry) => listed(entry, [row]))))
      incomplete = true;
    prefetch(entries);
    return { entries: entries.sort(byName), incomplete };
  };
  const remember = (entry: PromptShortcutIndexEntry, value: PromptShortcut) => {
    if (!live()) return;
    scope.bodies.delete(entry.bodyDocId);
    scope.bodies.set(entry.bodyDocId, { entry: JSON.stringify(entry), value });
    while (scope.bodies.size > BODY_LIMIT)
      scope.bodies.delete(scope.bodies.keys().next().value!);
  };
  const cachedBody = (entry: PromptShortcutIndexEntry) => {
    const hit = scope.bodies.get(entry.bodyDocId);
    return hit?.entry === JSON.stringify(entry) ? hit.value : undefined;
  };
  /** The body for an authorized entry: remembered, joined in flight, or downloaded once. */
  const body = (entry: PromptShortcutIndexEntry) => {
    const hit = cachedBody(entry);
    if (hit) return Promise.resolve(hit);
    const key = JSON.stringify(entry);
    let pending = scope.reads.get(key);
    if (!pending) {
      pending = download(entry, AbortSignal.timeout(30000))
        .then((value) => {
          remember(entry, value);
          return value;
        })
        .finally(() => {
          if (scope.reads.get(key) === pending) scope.reads.delete(key);
        });
      scope.reads.set(key, pending);
    }
    return pending;
  };
  const download = async (
    entry: PromptShortcutIndexEntry,
    signal: AbortSignal,
  ) => {
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
    return value;
  };
  /** `fresh` re-reads the directory first; saves use it, opening and sending do not. */
  const read = async (entry: PromptShortcutIndexEntry, fresh = false) => {
    await authorized(entry, fresh);
    const value = await body(entry);
    signal.throwIfAborted();
    return value;
  };
  /**
   * Listed bodies download in the background, one at a time, so opening or choosing a
   * shortcut usually needs no network. Best effort: a failure only leaves a later read to
   * download it; a foreground read of the same body joins the download in flight.
   */
  const prefetch = (entries: PromptShortcutIndexEntry[]) => {
    if (!live()) return;
    scope.prefetch = entries
      .filter((entry) => !cachedBody(entry))
      .slice(0, PREFETCH_LIMIT);
    if (scope.prefetching) return;
    scope.prefetching = true;
    void (async () => {
      try {
        for (let next; live() && (next = scope.prefetch.shift());)
          await body(next).catch(() => undefined);
      } finally {
        scope.prefetching = false;
      }
    })();
  };
  return {
    list,
    listAvailable,
    read,
    authorized,
    index,
    grant,
    directory,
  };
}

type ShortcutListing = {
  entries: PromptShortcutIndexEntry[];
  incomplete: boolean;
};
const listings = new Map<
  string,
  { value?: ShortcutListing; pending?: Promise<ShortcutListing> }
>();

/**
 * The shortcuts a composer lists, per workspace and account. Reading them takes several
 * round trips (directory, a grant and a read per owner's index), so the last listing answers
 * at once while a fresh one is read for the next composer; only the first read is awaited.
 * Rows only display: choosing one reads its body and sending re-checks the directory.
 */
export async function listedShortcuts(
  workspaceId: string,
  userId: string,
  cloud: Cloud,
): Promise<ShortcutListing> {
  const key = `${workspaceId}:${userId}`;
  for (const other of listings.keys())
    if (other !== key) listings.delete(other);
  const slot = listings.get(key) ?? {};
  listings.set(key, slot);
  slot.pending ??= shortcutAccess(
    workspaceId,
    userId,
    cloud,
    AbortSignal.timeout(30000),
  )
    .listAvailable()
    .then((value) => {
      if (listings.get(key) === slot) slot.value = value;
      return value;
    })
    .finally(() => {
      slot.pending = undefined;
    });
  const pending = slot.pending;
  if (slot.value) {
    pending.catch(() => {});
    return slot.value;
  }
  return pending.catch(() => ({ entries: [], incomplete: true }));
}

export async function promptShortcuts(
  request: ShortcutRequest,
  userId: string,
  cloud: Cloud,
  signal: AbortSignal,
) {
  if (!userId) throw new Error('shortcut_unavailable');
  const access = shortcutAccess(request.workspaceId, userId, cloud, signal);
  // Settings and the composer's body read list what is readable now; one owner's index that
  // has not landed hides only its own rows. Send-time expansion keeps the strict listing.
  if (request.action === 'list')
    return (await access.listAvailable(request.fresh === true)).entries;
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
  const active = (await access.directory(true)).find(
    (row) => row.shortcutId === value.id,
  );
  const alreadyActive =
    active?.bodyDocId === entry.bodyDocId && active.revision === entry.revision;
  if (!alreadyActive) {
    if (base) await access.read(base, true);
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
  const published = await access.read(entry, true);
  if (JSON.stringify(published) !== JSON.stringify(value))
    throw new Error('shortcut_changed');
  const { flock, client } = await access.index(userId, entry.visibility, true);
  await access.authorized(entry, true);
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
  // The next composer lists the saved shortcut rather than the earlier listing.
  listings.clear();
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
