import {
  readNativeScheduleRetentions,
  purgeNativeScheduleDefinition,
} from './native-schedule-retention';
import type { ScheduleRetentionRequest } from '../schedule-registry-port';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { nativeLoroDocumentManifestSchema } from './native-loro-document-manifest';
import { NATIVE_REPO_MIGRATION_FORMAT } from './native-repo-migration-format';
import { join } from 'node:path';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import type { SessionId, WorkspaceId } from '../ids';
import type { ScheduleDefinitionResolver } from '../schedule-repository';
import { getScheduleRoomId } from '../schedule-registry';
import { getPreviewCommentRoomId } from '../preview-comment-types';
import { createNativePreviewComments } from './native-preview-comments';
import {
  createNativeScheduleDefinition,
  type NativeScheduleDefinitionRegistry,
} from './native-schedule-definition';
import type { NativeSessionSdkCompatibility } from './native-session-compatibility';

export type NativeDocumentDomainFamily = 'preview_comments' | 'schedule_definition';
export type NativeDocumentDomainBinding = {
  readonly accountId: string;
  readonly workspaceId: WorkspaceId;
  readonly journalPath: string;
  readonly dataDir: string;
};
/** Admission alone performs no host launch, database creation or legacy read. */
export function readNativeDocumentDomainRoute(
  binding: NativeDocumentDomainBinding,
  family: NativeDocumentDomainFamily,
  id: string
): 'legacy' | 'frozen' | 'native' {
  if (!id || id.length > 512) throw new Error('Invalid native document identity');
  const roomId =
    family === 'preview_comments'
      ? getPreviewCommentRoomId(id as SessionId)
      : getScheduleRoomId(id);
  if (!existsSync(binding.journalPath)) return 'legacy';
  const database = new DatabaseSync(binding.journalPath, { readOnly: true, timeout: 0 });
  try {
    const row = database
      .prepare(
        'SELECT manifest,stage,receipt FROM native_loro_document_migrations WHERE binding=? AND room_id=?'
      )
      .get(JSON.stringify([binding.accountId, binding.workspaceId]), roomId) as
      | { manifest: string; stage: string; receipt: string | null }
      | undefined;
    if (!row) return 'legacy';
    const manifest = nativeLoroDocumentManifestSchema.parse(JSON.parse(row.manifest));
    if (new Set(manifest.sourceIds).size !== manifest.sourceIds.length)
      throw new Error('Invalid native document source inventory');
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Reflect.get(manifest, 'binding') !==
        JSON.stringify([binding.accountId, binding.workspaceId]) ||
      Reflect.get(manifest, 'namespace') !== binding.workspaceId ||
      Reflect.get(manifest, 'roomId') !== roomId ||
      Reflect.get(manifest, 'family') !== family
    )
      throw new Error('Native document route binding changed');
    if (row.stage === 'native') {
      if (manifest.origin === 'created') {
        const receipt = z
          .object({
            packageVersion: z.literal(NATIVE_REPO_MIGRATION_FORMAT.packageVersion),
            sourceCommit: z.literal(NATIVE_REPO_MIGRATION_FORMAT.sourceCommit),
            sqliteSchema: z.literal(NATIVE_REPO_MIGRATION_FORMAT.sqliteSchema),
            kind: z.literal('created'),
            family: z.literal(family),
            reservationId: z.literal(manifest.migrationId),
            creationIntentSha256: z.literal(manifest.creationIntentSha256!),
            roomTxId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            version: z.record(
              z.string(),
              z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
            ),
            absence: z
              .array(z.object({ sourceId: z.string().min(1), absent: z.literal(true) }).strict())
              .min(1),
          })
          .strict()
          .parse(JSON.parse(row.receipt ?? 'null'));
        if (
          new Set(receipt.absence.map((source) => source.sourceId)).size !== receipt.absence.length
        )
          throw new Error('Invalid new leaf absence inventory');
        return 'native';
      }
      const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
      const receipt = z
        .object({
          packageVersion: z.literal(NATIVE_REPO_MIGRATION_FORMAT.packageVersion),
          sourceCommit: z.literal(NATIVE_REPO_MIGRATION_FORMAT.sourceCommit),
          sqliteSchema: z.literal(NATIVE_REPO_MIGRATION_FORMAT.sqliteSchema),
          roomTxId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          sha256,
          sources: z.array(
            z
              .object({ sourceId: z.string().min(1), sha256, present: z.literal(false).optional() })
              .strict()
          ),
        })
        .strict()
        .parse(JSON.parse(row.receipt ?? 'null'));
      if (
        receipt.sources.some(
          (source) =>
            source.present === false &&
            source.sha256 !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        )
      )
        throw new Error('Invalid native document absence receipt');
      if (
        receipt.sources.length !== manifest.sourceIds.length ||
        new Set(receipt.sources.map((source) => source.sourceId)).size !== receipt.sources.length ||
        receipt.sources.some((source) => !manifest.sourceIds.includes(source.sourceId))
      )
        throw new Error('Incomplete native document publication receipt');
      return 'native';
    }
    if (row.stage === 'legacy') return 'legacy';
    if (row.stage === 'frozen' || row.stage === 'rollback') return 'frozen';
    throw new Error('Unsupported native document route');
  } finally {
    database.close();
  }
}

type Observation = { close(): Promise<void>; retryCleanup(): Promise<void> };
export type NativeDocumentDomainOptions = NativeDocumentDomainBinding & {
  readonly compatibility: NativeSessionSdkCompatibility;
  readonly writer: string;
  readonly registry: NativeScheduleDefinitionRegistry;
  /** Trusted Meta owner checks exact active document identity and plaintext policy.
   * Preview comments are independent of the Session history backend, including Roost. */
  authorize(family: NativeDocumentDomainFamily, id: string): Promise<void>;
  assertCurrent(): void;
  getClient(): Promise<{
    readonly client: RepoClient;
    readonly generation: string;
    readonly sdkArtifactId: string;
  }>;
  flushDefinition(): Promise<void>;
};
/** Shared main/CLI definition owner. Only selected whole rooms are admitted; no
 * raw Flock, SDK handle, path or arbitrary patch is available to consumers. */
export function createNativeDocumentDomains(options: NativeDocumentDomainOptions) {
  let retired = false,
    closing: Promise<void> | undefined;
  const observers = new Set<Observation>();
  const pending = new Set<Promise<unknown>>();
  const roomJobs = new Map<string, Set<Promise<unknown>>>();
  const purges = new Map<string, Promise<void>>();
  const retention = (id: string) =>
    readNativeScheduleRetentions(
      options.journalPath,
      JSON.stringify([options.accountId, options.workspaceId])
    ).find((row) => row.scheduleId === id);
  const tracked = <A>(start: () => Promise<A>): Promise<A> => {
    if (retired) return Promise.reject(new Error('Native document owner is closed'));
    const work = Promise.resolve().then(start);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  let currentConnection:
    | { client: RepoClient; generation: string; epoch: number; detach(): void }
    | undefined;
  const assertRoute = (family: NativeDocumentDomainFamily, id: string) => {
    options.assertCurrent();
    if (
      retired ||
      (family === 'schedule_definition' && retention(id)) ||
      readNativeDocumentDomainRoute(options, family, id) !== 'native'
    )
      throw new Error('Native document restart required');
  };
  const storage = (family: NativeDocumentDomainFamily, id: string) => {
    const roomId =
      family === 'preview_comments'
        ? getPreviewCommentRoomId(id as SessionId)
        : getScheduleRoomId(id);
    const db = new DatabaseSync(
      join(
        options.dataDir,
        'namespaces',
        `ns_${Buffer.from(options.workspaceId).toString('hex')}.sqlite3`
      ),
      { readOnly: true, timeout: 0 }
    );
    try {
      const version = db.prepare("SELECT v FROM v2_meta WHERE k='schema_version'").get() as
        | { v?: unknown }
        | undefined;
      const room = db
        .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=1 AND room_id=?')
        .get(roomId) as { encryption?: unknown } | undefined;
      if (version?.v !== 1 || room?.encryption !== 0)
        throw new Error('Native document storage requires recovery');
    } finally {
      db.close();
    }
  };
  const acquire = async (family: NativeDocumentDomainFamily, id: string) => {
    options.assertCurrent();
    if (retired) throw new Error('Native document owner is closed');
    const route = readNativeDocumentDomainRoute(options, family, id);
    if (route === 'legacy') return undefined;
    assertRoute(family, id);
    storage(family, id);
    await options.authorize(family, id);
    assertRoute(family, id);
    const current = await options.getClient();
    assertRoute(family, id);
    if (!current.generation || current.sdkArtifactId !== options.compatibility.artifactId)
      throw new Error('Native document SDK generation changed');
    if (
      !currentConnection ||
      currentConnection.client !== current.client ||
      currentConnection.generation !== current.generation
    ) {
      currentConnection?.detach();
      const state = {
        client: current.client,
        generation: current.generation,
        epoch: 0,
        detach: () => {},
      };
      state.detach = current.client.onConnectionStateChange((connection) => {
        if (connection !== 'connected') state.epoch++;
      });
      currentConnection = state;
    }
    const connection = currentConnection,
      epoch = connection.epoch;
    const assertAccess = () => {
      assertRoute(family, id);
      if (
        currentConnection !== connection ||
        connection.epoch !== epoch ||
        current.client.connectionState !== 'connected'
      )
        throw new Error('Native document restart required');
    };
    return {
      client: current.client,
      namespace: options.workspaceId,
      writer: options.writer,
      compatibility: options.compatibility,
      assertAccess,
    };
  };
  const observe = async (start: () => Promise<Observation>) => {
    if (retired || observers.size >= 64)
      throw new Error('Native document observer capacity reached');
    const observation = await start();
    observers.add(observation);
    if (retired) {
      await observation.close();
      observers.delete(observation);
      throw new Error('Native document owner is closed');
    }
    const close = async () => {
      await observation.close();
      observers.delete(observation);
    };
    return { close, retryCleanup: close };
  };
  const authorized = async <A>(
    family: NativeDocumentDomainFamily,
    id: string,
    work: () => Promise<A>
  ) => {
    assertRoute(family, id);
    await options.authorize(family, id);
    assertRoute(family, id);
    const raw = tracked(work),
      room = `${family}:${id}`;
    const jobs = roomJobs.get(room) ?? new Set<Promise<unknown>>();
    jobs.add(raw);
    roomJobs.set(room, jobs);
    void raw
      .finally(() => {
        jobs.delete(raw);
        if (!jobs.size) roomJobs.delete(room);
      })
      .catch(() => {});
    return raw;
  };
  const purge = (id: string, input: ScheduleRetentionRequest): Promise<void> => {
    if (purges.has(id)) return purges.get(id)!;
    const raw = tracked(async () => {
      options.assertCurrent();
      if (input.actorId !== options.accountId)
        throw new Error('Native retention actor binding changed');
      if (readNativeDocumentDomainRoute(options, 'schedule_definition', id) !== 'native')
        throw new Error('Native retention ownership required');
      await options.authorize('schedule_definition', id);
      options.assertCurrent();
      const current = await options.getClient();
      if (
        current.sdkArtifactId !== options.compatibility.artifactId ||
        current.client.connectionState !== 'connected'
      )
        throw new Error('Native retention SDK generation changed');
      let connected = true;
      const detach = current.client.onConnectionStateChange((state) => {
        if (state !== 'connected') connected = false;
      });
      const check = () => {
        options.assertCurrent();
        if (retired || !connected || current.client.connectionState !== 'connected')
          throw new Error('Native retention owner retired');
      };
      try {
        await purgeNativeScheduleDefinition({
          journalPath: options.journalPath,
          binding: JSON.stringify([options.accountId, options.workspaceId]),
          scheduleId: id,
          input,
          registry: options.registry,
          namespace: options.workspaceId,
          getClient: async () => {
            check();
            return current.client;
          },
          assertCurrent: check,
          drain: async () => {
            await Promise.allSettled([...(roomJobs.get(`schedule_definition:${id}`) ?? [])]);
            check();
          },
        });
      } finally {
        detach();
      }
    });
    purges.set(id, raw);
    void raw
      .finally(() => {
        if (purges.get(id) === raw) purges.delete(id);
      })
      .catch(() => {});
    return raw;
  };
  const schedule = async (id: string) => {
    options.assertCurrent();
    if (retired) throw new Error('Native document owner retired');
    const retiredBody = retention(id);
    if (retiredBody) {
      if (readNativeDocumentDomainRoute(options, 'schedule_definition', id) !== 'native')
        throw new Error('Native retention route changed');
      const read = async () => {
        options.assertCurrent();
        if (!['deleted', 'complete'].includes(retention(id)?.stage ?? ''))
          throw new Error('Native retention incomplete');
        return null;
      };
      return {
        read,
        save: async (
          _input: Parameters<ReturnType<typeof createNativeScheduleDefinition>['save']>[0],
          _authorize?: Parameters<ReturnType<typeof createNativeScheduleDefinition>['save']>[1]
        ): Promise<import('../schedule-types').ScheduleDocument> => {
          throw new Error('Schedule permanently retired');
        },
        setEnabled: async (
          _input: Parameters<ReturnType<typeof createNativeScheduleDefinition>['setEnabled']>[0],
          _authorize?: Parameters<
            ReturnType<typeof createNativeScheduleDefinition>['setEnabled']
          >[1]
        ) => {
          throw new Error('Schedule permanently retired');
        },
        purge: (input: ScheduleRetentionRequest) => purge(id, input),
        async observe(
          listener: (value: import('../schedule-types').ScheduleDocument | null) => void,
          _error: (error: unknown) => void
        ) {
          await read();
          listener(null);
          return { close: async () => {}, retryCleanup: async () => {} };
        },
      };
    }
    const acquired = await tracked(() => acquire('schedule_definition', id));
    if (!acquired) return undefined;
    const port = createNativeScheduleDefinition({
      ...acquired,
      scheduleId: id,
      registry: options.registry,
      flushDefinition: options.flushDefinition,
    });
    return {
      ...port,
      purge: (input: ScheduleRetentionRequest) => purge(id, input),
      read: () => authorized('schedule_definition', id, () => port.read()),
      save: (input: Parameters<typeof port.save>[0], authorize?: Parameters<typeof port.save>[1]) =>
        authorized('schedule_definition', id, () => port.save(input, authorize)),
      setEnabled: (
        input: Parameters<typeof port.setEnabled>[0],
        authorize?: Parameters<typeof port.setEnabled>[1]
      ) => authorized('schedule_definition', id, () => port.setEnabled(input, authorize)),
      observe: (...args: Parameters<typeof port.observe>) =>
        authorized('schedule_definition', id, () => observe(() => port.observe(...args))),
    };
  };
  const definitions: ScheduleDefinitionResolver = {
    resolve: schedule,
    async recoverRetention(actorId, machineId) {
      const failures: unknown[] = [];
      for (const record of readNativeScheduleRetentions(
        options.journalPath,
        JSON.stringify([options.accountId, options.workspaceId])
      )) {
        if (
          record.stage !== 'complete' &&
          record.input.actorId === actorId &&
          record.input.machineId === machineId
        )
          try {
            await purge(record.scheduleId, record.input);
          } catch (error) {
            failures.push(error);
          }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native retention recovery incomplete');
    },
  };
  const close = (): Promise<void> => {
    retired = true;
    currentConnection?.detach();
    if (closing) return closing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draining = (async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(
        [...observers].map(async (observer) => {
          await observer.close();
          observers.delete(observer);
        })
      );
      const failed = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failed.length)
        throw new AggregateError(failed, 'Native document observer cleanup unconfirmed');
    })();
    const work = Promise.race([
      draining,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native document cleanup is unconfirmed')),
          10_000
        );
      }),
    ]).finally(() => clearTimeout(timer));
    closing = work;
    void work.catch(() => {
      if (closing === work) closing = undefined;
    });
    return work;
  };
  return {
    definitions,
    schedule,
    async preview(sessionId: SessionId) {
      const acquired = await tracked(() => acquire('preview_comments', sessionId));
      if (!acquired) return undefined;
      const port = createNativePreviewComments({ ...acquired, sessionId });
      return {
        ...port,
        read: () => authorized('preview_comments', sessionId, () => port.read()),
        mutatePreviewVisualComments: (
          ...args: Parameters<typeof port.mutatePreviewVisualComments>
        ) =>
          authorized('preview_comments', sessionId, () =>
            port.mutatePreviewVisualComments(...args)
          ),
        observe: (...args: Parameters<typeof port.observe>) =>
          authorized('preview_comments', sessionId, () => observe(() => port.observe(...args))),
      };
    },
    owns(family: NativeDocumentDomainFamily, id: string) {
      return readNativeDocumentDomainRoute(options, family, id) !== 'legacy';
    },
    close,
    retryCleanup: close,
  };
}
