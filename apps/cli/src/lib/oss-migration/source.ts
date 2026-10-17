import { WorkspaceRepoLegacy } from '@lody/shared/workspace-data/repo-legacy';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';

import {
  getMachineRoomId,
  isSessionDocRoomId,
  buildScheduleRegistryRow,
  ScheduleDefinitionSchema,
  SESSION_FILE_MAX_SIZE_BYTES,
  type MachineId,
} from '@lody/shared';
import { validateHistoricalAttachments } from './attachments';
import {
  catalogSchema,
  documentSchema,
  hashBytes,
  journalSchema,
  manifestSchema,
  prepareDocument,
  rowSchema,
  safeId,
  type Journal,
  type Manifest,
} from './model';

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export function sourceDocumentPath(directory: string, id: string): string {
  return path.join(directory, `${safeId.parse(id)}.loro`);
}
export function preparedDocumentPath(directory: string, id: string): string {
  return path.join(directory, `${safeId.parse(id)}.prepared.loro`);
}
export async function loadSourceCatalog(sourcePath: string) {
  const catalog = catalogSchema.parse(
    await readJson(path.join(sourcePath, 'workspace-catalog.json'))
  );
  const active = catalog.workspaces.filter((w) => w.state === 'active');
  if (active.length !== 1 || !active[0]?.workspaceId.startsWith('lw_'))
    throw new Error('Expected exactly one active OSS workspace (lw_).');
  return { catalog, workspace: active[0] };
}

export async function freezeSource(
  input: Omit<Manifest, 'version' | 'documents' | 'flocks' | 'machineMeta' | 'createdAt'>,
  directory: string
): Promise<Manifest> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const sourceDb = path.join(
    input.sourcePath,
    'loro-repo',
    safeId.parse(input.sourceWorkspaceId),
    'repo.sqlite3'
  );
  const backup = path.join(directory, `source-${randomUUID()}.sqlite3`);
  const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backup);
    await fs.chmod(backup, 0o600);
  } finally {
    source.close();
  }
  const store = new SqliteRepoStore({ path: backup });
  const repo = await WorkspaceRepoLegacy.create({
    storageAdapter: store.storage,
  });
  try {
    const scheduleRows = new Map<string, ReturnType<typeof buildScheduleRegistryRow>>();
    const manifest: Manifest = {
      ...input,
      version: 2,
      documents: [],
      flocks: [],
      machineMeta: {},
      createdAt: new Date().toISOString(),
    };
    for (const entry of await repo.listDoc()) {
      if (entry.deleted) continue;
      if (entry.docId.startsWith('machine-')) {
        if (entry.docId !== getMachineRoomId(input.sourceMachineId as MachineId))
          throw new Error('OSS snapshot contains another machine.');
        manifest.machineMeta = entry.meta;
        continue;
      }
      if (
        !isSessionDocRoomId(entry.docId) &&
        !/^(schedule|task|preview-comment)-/.test(entry.docId)
      )
        throw new Error(`Unsupported document kind: ${entry.docId}`);
      if (entry.meta.historyBackend && entry.meta.historyBackend !== 'loro')
        throw new Error(
          `Cannot yet migrate ${entry.meta.historyBackend} history (${entry.docId}). Nothing has been uploaded.`
        );
      const doc = await store.storage.loadDoc(entry.docId);
      if (!doc)
        throw new Error(
          `Missing document body: ${entry.docId}. Open OSS and let local sync finish before closing it.`
        );
      const bytes = doc.export({ mode: 'snapshot' });
      const record = documentSchema.parse({
        id: entry.docId,
        meta: entry.meta,
        sha256: hashBytes(bytes),
      });
      const prepared = prepareDocument(bytes, record, manifest); // Validate every body before any upload.
      if (entry.docId.startsWith('schedule-')) {
        const definition = ScheduleDefinitionSchema.parse(prepared.getMap('definition').toJSON());
        scheduleRows.set(
          definition.scheduleId,
          buildScheduleRegistryRow({
            definition,
            prompt: prepared.getText('prompt').toString(),
            timeline: [],
          })
        );
      }
      await fs.writeFile(sourceDocumentPath(directory, entry.docId), bytes, { mode: 0o600 });
      manifest.documents.push(record);
      if (isSessionDocRoomId(entry.docId)) {
        const sessionId = safeId.parse(entry.docId.slice('session-'.length));
        await validateHistoricalAttachments(doc, sessionId, input.sourceMachineId, async (key) => {
          const destination = path.join(directory, 'blobs', key);
          await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          const handle = await fs.open(
            path.join(input.sourcePath, 'session-files', input.sourceWorkspaceId, key),
            constants.O_RDONLY | constants.O_NOFOLLOW
          );
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > SESSION_FILE_MAX_SIZE_BYTES)
              throw new Error(`Invalid attachment: ${key}`);
            const blobBytes = await handle.readFile();
            await fs.writeFile(destination, blobBytes, { mode: 0o600 });
            return blobBytes;
          } finally {
            await handle.close();
          }
        });
      }
    }
    for (const entry of await repo.listFlockDoc()) {
      if (entry.deleted) continue;
      const prefix = `${input.sourceWorkspaceId}:`;
      if (!entry.flockDocId.startsWith(prefix))
        throw new Error(`Foreign Flock document: ${entry.flockDocId}`);
      const suffix = entry.flockDocId.slice(prefix.length);
      // Transient Code Collab indexes are regenerated from local evidence, not durable history.
      if (/^(fi|fis):/.test(suffix)) continue;
      const flock = await store.storage.loadFlockDoc?.(entry.flockDocId);
      if (!flock) throw new Error(`Missing Flock body: ${entry.flockDocId}`);
      let targetSuffix = suffix;
      if (suffix.startsWith('mf:')) {
        if (suffix !== `mf:${input.sourceMachineId}`) throw new Error('Foreign machine Flock');
        targetSuffix = `mf:${input.targetMachineId}`;
      } else if (!['sr', 'ti', 'wf:workspace'].includes(suffix))
        throw new Error(`Unsupported Flock kind: ${suffix}`);
      const rows: Manifest['flocks'][number]['rows'] = [];
      for (const row of flock.scan({ includeRaw: false })) {
        if (row.value === undefined) continue;
        const parsed = rowSchema.parse(row);
        const family = parsed.key[0];
        if (
          suffix.startsWith('mf:') &&
          !['localProject', 'agentConfig', 'agentConfigIndex', 'sessionLaunchConfig'].includes(
            String(family)
          )
        )
          continue;
        if (suffix === 'wf:workspace') continue; // Target workspace configuration wins.
        if (suffix === 'sr' && family !== 'schedule') continue; // Never carry requests/leases.
        let value = parsed.value;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          value = { ...value };
          if ('machineId' in value) value.machineId = input.targetMachineId;
          if (value.userId === input.sourceUserId) value.userId = input.targetUserId;
          if (value.ownerId === input.sourceUserId) value.ownerId = input.targetUserId;
          if (suffix === 'sr') {
            const scheduleRow = scheduleRows.get(String(parsed.key[1]));
            if (!scheduleRow) throw new Error('Schedule index has no complete document');
            value = JSON.parse(JSON.stringify(scheduleRow));
          }
        }
        rows.push({ key: parsed.key, value });
      }
      if (rows.length)
        manifest.flocks.push({ id: `${input.targetWorkspaceId}:${targetSuffix}`, rows });
    }
    const result = manifestSchema.parse(manifest);
    await atomicJson(path.join(directory, 'manifest.json'), result);
    return result;
  } finally {
    await repo.destroy();
    store.close();
  }
}

export async function loadJournal(directory: string, migrationId: string): Promise<Journal> {
  const file = path.join(directory, 'journal.json');
  const journal = (await exists(file))
    ? journalSchema.parse(await readJson(file))
    : {
        version: 2 as const,
        migrationId,
        prepared: {},
        reserved: [],
        published: [],
        attachments: {},
        complete: false,
      };
  if (journal.migrationId !== migrationId) throw new Error('Migration journal identity mismatch');
  return journal;
}
