import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getWorkspaceFlockDocId,
  WorkspaceCatalogError,
  type WorkspaceId,
  type WorkspaceCatalogReader,
  type WorkspaceCatalogCommands,
  type WorkspaceCatalogRoleLookup,
} from '@lody/shared';
import { isLocalUserId, isLocalWorkspaceId } from '@lody/shared/platform-kind';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { createNativeWorkspaceCatalogOwner } from '@lody/shared/node/native-workspace-catalog';
import { rendererWfBindingKey } from '@lody/shared/renderer-room-migration';
import { NativeRepoMigrationJournal } from './native-repo-migration';
import { toShared } from '@/platform/process-options';
import { getCliNodeExecutable } from '../managed-daemon-release';

/** Rechecked by already-open legacy command owners before authoring or upload. */
export function isLegacyLocalWorkspaceCatalogCurrent(
  accountId: string,
  workspaceId: WorkspaceId
): boolean {
  if (!isLocalUserId(accountId) || !isLocalWorkspaceId(workspaceId)) return true;
  const dataRoot = getLodyDataDir('local');
  const main = join(dataRoot, 'native-repo', 'renderer-wf-owners.sqlite3');
  if (existsSync(main)) {
    const database = new Database(main, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      if (
        database.prepare('SELECT owner FROM renderer_wf_owners WHERE binding = ?').get(
          rendererWfBindingKey({
            accountId,
            workspaceId,
            roomId: getWorkspaceFlockDocId(workspaceId),
            contentMode: 'plaintext',
          })
        )
      )
        return false;
    } finally {
      database.close();
    }
  }
  const selected = resolveLocalIndependentRepo({
    platform: 'local',
    accountId,
    workspaceId,
    dataRoot,
  });
  const journal = join(selected.directory, 'routes.sqlite3');
  if (!existsSync(journal)) return true;
  const database = new Database(journal, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    return database.transaction(() => {
      const key = JSON.stringify({ kind: 'flock', id: getWorkspaceFlockDocId(workspaceId) });
      const binding = JSON.stringify([accountId, workspaceId]);
      if (
        database
          .prepare('SELECT 1 FROM native_room_maintenance WHERE binding = ? AND room_key = ?')
          .get(binding, key)
      )
        return false;
      const row = database
        .prepare('SELECT stage FROM native_room_migrations WHERE binding = ? AND room_key = ?')
        .get(binding, key) as { stage: string } | undefined;
      if (!row || row.stage === 'legacy') return true;
      if (!['frozen', 'verified', 'native'].includes(row.stage))
        throw new Error('Unsupported native catalog stage');
      return false;
    })();
  } finally {
    database.close();
  }
}

/** Local Node owner selected by persistent routing, including one-shot readers. */
export class NativeLocalWorkspaceCatalogLegacy {
  readonly catalog: WorkspaceCatalogReader & WorkspaceCatalogCommands & WorkspaceCatalogRoleLookup;
  private readonly journal: NativeRepoMigrationJournal;
  private readonly host: IndependentNativeRepoHostLegacy;
  private readonly native;
  private closed = false;
  private closing: Promise<void> | undefined;
  readonly roomId: string;
  private readonly binding: string;
  private readonly selected;

  constructor(
    private readonly options: {
      accountId: string;
      workspaceId: WorkspaceId;
      dataRoot: string;
      launch?: { executable: string; entry: string };
    }
  ) {
    this.selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
    this.binding = JSON.stringify([options.accountId, options.workspaceId]);
    this.roomId = getWorkspaceFlockDocId(options.workspaceId);
    this.journal = new NativeRepoMigrationJournal(join(this.selected.directory, 'routes.sqlite3'));
    this.host = new IndependentNativeRepoHostLegacy(
      {
        dataDir: this.selected.dataDir,
        binding: this.selected.binding,
        ...(options.launch ?? {
          executable: getCliNodeExecutable(),
          entry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
        }),
      },
      toShared()
    );
    this.native = createNativeWorkspaceCatalogOwner({
      namespace: options.workspaceId,
      binding: { accountId: options.accountId, workspaceId: options.workspaceId },
      getClient: async () => {
        this.requireNative();
        this.assertStorage();
        return this.host.client();
      },
      authorize: () => this.isNative(),
      // This factory is a trusted CLI owner. This port is never returned over IPC.
      authorizeRoleLookup: () => this.isNative(),
      authority: { current: () => this.isNative(), subscribe: () => () => {} },
      confirmUpload: async () => this.requireNative(),
    });
    this.catalog = this.native;
  }

  private rendererOwner(): 'legacy' | 'frozen' | 'native' {
    const file = join(this.options.dataRoot, 'native-repo', 'renderer-wf-owners.sqlite3');
    if (!existsSync(file)) return 'legacy';
    const database = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const key = rendererWfBindingKey({
        accountId: this.options.accountId,
        workspaceId: this.options.workspaceId,
        roomId: this.roomId,
        contentMode: 'plaintext',
      });
      const row = database
        .prepare('SELECT owner FROM renderer_wf_owners WHERE binding = ?')
        .get(key) as { owner: string } | undefined;
      if (!row) return 'legacy';
      if (row.owner === 'native' || row.owner === 'frozen') return row.owner;
      throw new Error('Unsupported renderer catalog owner');
    } finally {
      database.close();
    }
  }

  private isNative(): boolean {
    if (this.closed) return false;
    const room = { kind: 'flock' as const, id: this.roomId };
    const allowed =
      this.rendererOwner() !== 'frozen' &&
      !this.journal.isMaintained(this.binding, room) &&
      this.journal.route(this.binding, room).owner === 'native';
    if (allowed) this.assertStorage();
    return allowed;
  }
  private requireNative(): void {
    if (!this.isNative())
      throw new WorkspaceCatalogError('restart_required', 'Workspace catalog migration is pending');
  }
  private assertStorage(): void {
    const file = join(
      this.selected.dataDir,
      'namespaces',
      'ns_' + Buffer.from(this.options.workspaceId).toString('hex') + '.sqlite3'
    );
    if (!existsSync(file))
      throw new Error('Native workspace catalog recovery required: storage is missing');
    const database = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      database.transaction(() => {
        const schema = database
          .prepare("SELECT v FROM v2_meta WHERE k = 'schema_version'")
          .get() as { v: number } | undefined;
        const row = database
          .prepare('SELECT encryption FROM v2_rooms WHERE room_kind = 2 AND room_id = ?')
          .get(this.roomId) as { encryption: number } | undefined;
        if (schema?.v !== 1 || !row || row.encryption !== 0)
          throw new Error(
            'Native workspace catalog recovery required: room is absent, protected, or unsupported'
          );
      })();
    } finally {
      database.close();
    }
  }
  ownsRoom(id: string): boolean {
    return id === this.roomId;
  }
  hasSelection(): boolean {
    const room = { kind: 'flock' as const, id: this.roomId };
    return (
      this.journal.isMaintained(this.binding, room) ||
      this.journal.route(this.binding, room).owner !== 'legacy'
    );
  }
  async ready(): Promise<boolean> {
    if (!this.isNative()) return false;
    await this.catalog.read({
      accountId: this.options.accountId,
      workspaceId: this.options.workspaceId,
    });
    return this.isNative();
  }
  hasPersisted(): boolean {
    if (!this.isNative()) return false;
    this.assertStorage();
    return true;
  }
  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const first = await Promise.allSettled([this.native.close(), this.host.close()]);
      const failures: unknown[] = first[1].status === 'rejected' ? [first[1].reason] : [];
      if (first[0].status === 'rejected') {
        // A terminal transport proves old SDK subscription handles retired.
        try {
          await this.native.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native workspace catalog release failed');
      this.journal.close();
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}

export async function openNativeLocalWorkspaceCatalogLegacy(options: {
  accountId: string;
  workspaceId: WorkspaceId;
  encrypted: boolean;
  cloud: boolean;
}): Promise<NativeLocalWorkspaceCatalogLegacy | null> {
  if (!isLocalUserId(options.accountId) || !isLocalWorkspaceId(options.workspaceId)) return null;
  const dataRoot = getLodyDataDir('local');
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options, dataRoot });
  const mainFile = join(dataRoot, 'native-repo', 'renderer-wf-owners.sqlite3');
  let mainSelected = false;
  if (existsSync(mainFile)) {
    const database = new Database(mainFile, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const row = database.prepare('SELECT owner FROM renderer_wf_owners WHERE binding = ?').get(
        rendererWfBindingKey({
          accountId: options.accountId,
          workspaceId: options.workspaceId,
          roomId: getWorkspaceFlockDocId(options.workspaceId),
          contentMode: 'plaintext',
        })
      ) as { owner: string } | undefined;
      if (row && row.owner !== 'frozen' && row.owner !== 'native')
        throw new Error('Unsupported renderer catalog owner');
      mainSelected = !!row;
    } finally {
      database.close();
    }
  }
  const journalFile = join(selected.directory, 'routes.sqlite3');
  if (!mainSelected && !existsSync(journalFile)) return null;
  await mkdir(selected.directory, { recursive: true, mode: 0o700 });
  const owner = new NativeLocalWorkspaceCatalogLegacy({ ...options, dataRoot });
  // A FI/FIS journal alone does not select the workspace catalog.
  if (!mainSelected && !owner.hasSelection()) {
    await owner.close();
    return null;
  }
  if (options.encrypted || options.cloud) {
    await owner.close();
    throw new Error('Local native catalog cannot acquire cloud or protected content');
  }
  return owner;
}
