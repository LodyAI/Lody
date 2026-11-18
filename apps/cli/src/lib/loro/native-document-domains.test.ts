import { openNativeLocalDocumentDomainsLegacy } from './native-local-document-domains';
import { NativeDocumentDomainsMainLegacy } from '../../../../../apps/electron/src/main/services/native-document-domains';
import {
  createNativeDocumentDomainClient,
  type NativeDocumentDomainTransport,
} from '../../../../../packages/components/src/providers/native-document-domain-ipc';
import { createNativeDocumentDomains } from '@lody/shared/node/native-document-domains';
import { ScheduleRepository, buildScheduleRegistryRow } from '@lody/shared';
import { readNativeFlockSnapshot } from './native-repo-migration';
import { createNativeWorkspaceDirectory } from '@lody/shared/node/native-workspace-directory';
import { createNativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta';
import { createLegacyWorkspaceDirectory } from '@lody/shared/workspace-directory';
import { LoroRepo } from 'loro-repo';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDocumentManager } from './doc';
import { getLogger } from '../../utils/logger';
import {
  executeScheduleCommand,
  type ScheduleCommandContext,
} from '../schedules/schedule-command-service';
import { createNativeScheduleRegistry } from '@lody/shared/node/native-schedule-registry';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  reserveNativeSessionMetadata,
  calculateNativeSessionCreationIntentSha256,
  assertNativeSessionMetadataReservation,
} from '../../../../../packages/shared/src/node/native-session-meta-reservation';
import { projectWorkspaceMetaPublicSnapshot } from '@lody/shared/native-workspace-meta-ipc';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { build } from 'esbuild';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import {
  exportNativeFlockRaw,
  requireNativeFlockEntries,
} from '../../../../../packages/shared/src/node/native-repo-flock-entries';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { connectEngine, readEngineEndpoint } from '@loro-dev/loro-repo-client/node';
import {
  META_ROOM,
  LODY_PREVIEW_COMMENT_DOC_SCHEMA,
  LODY_SCHEDULE_DOC_SCHEMA,
  type RepoClient,
} from '@loro-dev/loro-repo-client';
import {
  createPreviewVisualComment,
  getPreviewCommentRoomId,
  getScheduleRegistryFlockDocId,
  getScheduleRoomId,
  scheduleRegistryKeys,
  type SessionId,
  type WorkspaceId,
  type MinimalVisualAnnotationAnchor,
  type ScheduleSaveInput,
} from '@lody/shared';
import {
  NativeLoroDocumentMigration,
  type NativeLoroDocumentManifest,
} from './native-loro-document-migration';
import { createNativePreviewComments } from './native-preview-comments';
import {
  createNativeScheduleDefinition,
  createNativeScheduleDefinitionRegistry,
} from './native-schedule-definition';

const sdkCompatibility = await loadNativeRepoSdkCompatibility(import.meta.url);
const namespace = 'native-small-domains';
const sessionId = 'synthetic-session' as SessionId;
const workspaceId = 'synthetic-workspace' as WorkspaceId;
const pcRoom = { kind: 'loro_doc' as const, id: getPreviewCommentRoomId(sessionId) };
const scheduleRoom = { kind: 'loro_doc' as const, id: getScheduleRoomId('synthetic-schedule') };
const srRoom = { kind: 'flock' as const, id: getScheduleRegistryFlockDocId(workspaceId) };
const anchor = (): MinimalVisualAnnotationAnchor => ({
  version: 1,
  page: {
    url: '/synthetic',
    pathname: '/synthetic',
    viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  },
  click: { clientX: 1, clientY: 1, pageX: 1, pageY: 1, viewportXRatio: 0.01, viewportYRatio: 0.01 },
  target: {
    tag: 'button',
    attributes: {},
    rect: { x: 0, y: 0, width: 10, height: 10 },
    rectRatio: { x: 0, y: 0, width: 0.1, height: 0.1 },
    selector: 'button',
  },
  context: { ancestors: [] },
});
const comment = (id: string) =>
  createPreviewVisualComment({
    id,
    turnId: 'turn',
    body: `Synthetic ${id}`,
    anchor: anchor(),
    authorId: 'owner',
    createdAt: 1,
  });
const save = (): ScheduleSaveInput => ({
  scheduleId: 'synthetic-schedule',
  actorId: 'owner',
  now: 1,
  activityId: 'create',
  activationId: 'activation',
  create: true,
  draft: {
    title: ' Synthetic schedule ',
    prompt: 'Synthetic prompt',
    machineId: 'machine',
    trigger: { kind: 'interval', everyMs: 60000, anchorAt: '2026-01-01T00:00:00Z' },
    misfirePolicy: { kind: 'skip' },
    overlapPolicy: 'queue_one',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
  },
});

describe.skipIf(process.platform === 'win32')(
  'native preview comments and schedule definitions',
  () => {
    let directory: string;
    let fixtureRoot: string;
    let engine: IndependentNativeRepoHostLegacy;
    let compiledDirectory: string;
    let client: RepoClient;
    let rival: RepoClient;
    const docs: LoroDoc[] = [];
    const journals: NativeLoroDocumentMigration[] = [];
    const extraHosts: IndependentNativeRepoHostLegacy[] = [];
    const options = () => ({ client, namespace, writer: 'owner:synthetic', assertAccess() {} });
    const exported = async (room: typeof pcRoom) => {
      const doc = new LoroDoc();
      docs.push(doc);
      doc.import((await client.exportLoroRaw(namespace, room)).bytes);
      return doc;
    };
    const registry = () =>
      createNativeScheduleDefinitionRegistry({ ...options(), workspaceId, flush: async () => {} });
    const schedule = (extra: Partial<Parameters<typeof createNativeScheduleDefinition>[0]> = {}) =>
      createNativeScheduleDefinition({
        ...options(),
        scheduleId: 'synthetic-schedule',
        registry: registry(),
        flushDefinition: async () => {},
        ...extra,
      });
    beforeEach(async () => {
      client = undefined!;
      rival = undefined!;
      engine = undefined!;
      fixtureRoot = undefined!;
      compiledDirectory = undefined!;
      fixtureRoot = await mkdtemp(join(tmpdir(), 'lody-native-small-domains-'));
      directory = join(fixtureRoot, 'data');
      const cache = join(import.meta.dirname, '../../..', 'node_modules/.cache');
      await mkdir(cache, { recursive: true });
      compiledDirectory = await mkdtemp(join(cache, 'native-small-domains-'));
      const entry = join(compiledDirectory, 'native-repo-independent-host.js');
      await build({
        entryPoints: {
          'native-repo-independent-host': join(
            import.meta.dirname,
            'native-repo-independent-host-entry.ts'
          ),
          'native-repo-independent-engine': join(
            import.meta.dirname,
            'native-repo-independent-engine-entry.ts'
          ),
        },
        outdir: compiledDirectory,
        bundle: true,
        platform: 'node',
        format: 'esm',
        banner: {
          js: "import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url);",
        },
        plugins: [
          {
            name: 'shared-host-source',
            setup(builder) {
              builder.onResolve({ filter: /^@lody\/shared\/node\// }, (args) => ({
                path: join(
                  import.meta.dirname,
                  '../../../../../packages/shared/src/node',
                  `${args.path.split('/').at(-1)}.ts`
                ),
              }));
            },
          },
        ],
      });
      engine = new IndependentNativeRepoHostLegacy({
        dataDir: directory,
        binding: 'synthetic-small-domains',
        entry,
        executable: process.execPath,
        ...(sdkCompatibility ? { requiredSdkArtifactId: sdkCompatibility.artifactId } : {}),
      });
      client = await engine.client();
      const endpoint = await readEngineEndpoint(directory);
      expect(endpoint.pid).toBeGreaterThan(0);
      expect(endpoint.pid).not.toBe(process.pid);
      const report = process.report.getReport() as { sharedObjects?: string[] };
      expect(
        report.sharedObjects?.filter((path) => /loro-repo-engine.*\.node$/.test(path))
      ).toEqual([]);
      rival = await connectEngine(directory, { autoReconnect: false });
      await client.createRoom(namespace, pcRoom, 'plaintext', {
        docSchema: LODY_PREVIEW_COMMENT_DOC_SCHEMA,
      });
      await client.createRoom(namespace, scheduleRoom, 'plaintext', {
        docSchema: LODY_SCHEDULE_DOC_SCHEMA,
      });
      await client.createRoom(namespace, srRoom, 'plaintext');
    });
    afterEach(async () => {
      journals.splice(0).forEach((journal) => journal.close());
      const clients = await Promise.allSettled([client?.close(), rival?.close()]);
      const extra = await Promise.allSettled(extraHosts.splice(0).map((host) => host.close()));
      await engine?.close();
      for (const result of extra) if (result.status === 'rejected') throw result.reason;
      for (const result of clients) if (result.status === 'rejected') throw result.reason;
      docs.splice(0).forEach((doc) => doc.free());
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
      if (compiledDirectory) await rm(compiledDirectory, { recursive: true, force: true });
    });

    it('roundtrips preview domain mutations idempotently while preserving Map/Text IDs and opaque peer fields', async () => {
      const preview = createNativePreviewComments({ ...options(), sessionId });
      await preview.mutatePreviewVisualComments(sessionId, {
        kind: 'create',
        comment: comment('first'),
      });
      const first = await exported(pcRoom);
      const stored = (
        (first.getMap('turns').get('turn') as LoroMap).get('comments') as LoroList
      ).get(0) as LoroMap;
      const id = stored.id;
      // Import synthetic old Text plus unknown fields; writes must only touch their owned scalars.
      stored.set('futureField', { retained: true });
      stored.delete('body');
      stored.setContainer('body', new LoroText()).insert(0, 'Synthetic first');
      first.getMap('futureRoot').set('retained', true);
      first.commit();
      await client.importLoroRaw(namespace, pcRoom, first.export({ mode: 'update' }));
      await preview.mutatePreviewVisualComments(sessionId, {
        kind: 'resolve',
        commentId: 'first',
        resolvedAt: 2,
        resolvedBy: 'owner',
      });
      await preview.mutatePreviewVisualComments(sessionId, {
        kind: 'mark-submitted',
        commentIds: ['first'],
        submittedAt: 3,
        submittedMessageId: 'message',
      });
      const checkpoint = (await client.exportLoroRaw(namespace, pcRoom)).roomTxId;
      expect(
        await preview.mutatePreviewVisualComments(sessionId, {
          kind: 'mark-submitted',
          commentIds: ['first'],
          submittedAt: 3,
          submittedMessageId: 'message',
        })
      ).toBe(0);
      expect((await client.exportLoroRaw(namespace, pcRoom)).roomTxId).toBe(checkpoint);
      const after = await exported(pcRoom);
      const next = ((after.getMap('turns').get('turn') as LoroMap).get('comments') as LoroList).get(
        0
      ) as LoroMap;
      expect(next.id).toBe(id);
      expect(next.get('body')).toBeInstanceOf(LoroText);
      expect(next.toJSON()).toMatchObject({
        status: 'submitted',
        futureField: { retained: true },
        resolvedAt: 2,
      });
      expect(after.getMap('futureRoot').toJSON()).toEqual({ retained: true });
      await expect(
        preview.mutatePreviewVisualComments(sessionId, {
          kind: 'create',
          comment: comment('first'),
        })
      ).rejects.toThrow('preview_comment_id_conflict');
      expect((await preview.read()).turns.turn?.comments).toHaveLength(1);
    });

    it('keeps multi-comment preflight atomic, rechecks a peer insertion after CAS, and stops callbacks on local release', async () => {
      const preview = createNativePreviewComments({ ...options(), sessionId });
      await preview.mutatePreviewVisualComments(sessionId, {
        kind: 'create',
        comment: comment('first'),
      });
      let raced = false;
      const guarded = createNativePreviewComments({
        ...options(),
        sessionId,
        client: new Proxy(client, {
          get(target, key) {
            if (key === 'applyDocPatch')
              return async (...args: Parameters<RepoClient['applyDocPatch']>) => {
                if (!raced) {
                  raced = true;
                  await createNativePreviewComments({
                    ...options(),
                    client: rival,
                    sessionId,
                  }).mutatePreviewVisualComments(sessionId, {
                    kind: 'create',
                    comment: comment('peer'),
                  });
                }
                return target.applyDocPatch(...args);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      });
      await guarded.mutatePreviewVisualComments(sessionId, {
        kind: 'resolve',
        commentId: 'first',
        resolvedAt: 2,
        resolvedBy: 'owner',
      });
      const before = await preview.read();
      await expect(
        preview.mutatePreviewVisualComments(sessionId, {
          kind: 'mark-submitted',
          commentIds: ['first', 'missing'],
          submittedAt: 3,
        })
      ).rejects.toThrow('preview_comment_not_found');
      expect(await preview.read()).toEqual(before);
      const publications: unknown[] = [];
      const observation = await preview.observe(
        (value) => publications.push(value),
        (error) => {
          throw error;
        }
      );
      expect(publications).toHaveLength(1);
      observation.close();
      await preview.mutatePreviewVisualComments(sessionId, {
        kind: 'unresolve',
        commentId: 'first',
        updatedAt: 4,
      });
      expect(publications).toHaveLength(1);
      expect((await preview.read()).turns.turn?.comments.map((value) => value.id)).toEqual([
        'peer',
        'first',
      ]);
    });

    it('refuses a legacy inline comment update before changing its representation or data', async () => {
      const doc = new LoroDoc();
      docs.push(doc);
      doc.getMap('meta').set('sessionId', sessionId);
      const turn = doc.getMap('turns').setContainer('turn', new LoroMap());
      turn.set('turnId', 'turn');
      turn.setContainer('comments', new LoroList()).push(comment('inline') as never);
      doc.commit();
      await client.importLoroRaw(namespace, pcRoom, doc.export({ mode: 'snapshot' }));
      const before = await client.exportLoroRaw(namespace, pcRoom);
      await expect(
        createNativePreviewComments({ ...options(), sessionId }).mutatePreviewVisualComments(
          sessionId,
          { kind: 'resolve', commentId: 'inline', resolvedAt: 2, resolvedBy: 'owner' }
        )
      ).rejects.toMatchObject({ issues: [{ code: 'unsupported_atomic_object_replacement' }] });
      expect((await client.exportLoroRaw(namespace, pcRoom)).roomTxId).toBe(before.roomTxId);
      const after = await exported(pcRoom);
      expect(
        ((after.getMap('turns').get('turn') as LoroMap).get('comments') as LoroList).get(0)
      ).toMatchObject({ id: 'inline', status: 'completed' });
    });

    it('persists a schedule definition before publishing SR, retaining identities, unknown roots and pause replay guards', async () => {
      const events: string[] = [];
      const actual = registry();
      const adapter = schedule({
        flushDefinition: async () => {
          events.push('definition-durable');
        },
        registry: {
          ...actual,
          async publish(row) {
            events.push('registry-publish');
            await actual.publish(row);
          },
          async flush() {
            events.push('registry-durable');
          },
        },
      });
      const created = await adapter.save(save());
      expect(created.definition.title).toBe('Synthetic schedule');
      expect(events).toEqual(['definition-durable', 'registry-publish', 'registry-durable']);
      const first = await exported(scheduleRoom);
      const id = first.getMap('definition').id;
      const activityId = (first.getList('timeline').get(0) as LoroMap).id;
      first.getMap('futureRoot').set('retained', true);
      first.commit();
      await client.importLoroRaw(namespace, scheduleRoom, first.export({ mode: 'update' }));
      await adapter.save({
        ...save(),
        create: false,
        activityId: 'edit',
        activationId: 'edited',
        now: 2,
        draft: { ...save().draft, prompt: 'Updated prompt' },
      });
      await adapter.setEnabled({
        scheduleId: 'synthetic-schedule',
        enabled: false,
        actorId: 'owner',
        now: 3,
        activationId: 'paused',
        requestId: 'pause',
      });
      await adapter.setEnabled({
        scheduleId: 'synthetic-schedule',
        enabled: true,
        actorId: 'owner',
        now: 4,
        activationId: 'resumed',
        requestId: 'resume',
      });
      await adapter.setEnabled({
        scheduleId: 'synthetic-schedule',
        enabled: false,
        actorId: 'owner',
        now: 3,
        activationId: 'paused',
        requestId: 'pause',
      });
      expect((await adapter.read())?.definition).toMatchObject({
        enabled: true,
        activationId: 'resumed',
      });
      const after = await exported(scheduleRoom);
      expect(after.getMap('definition').id).toBe(id);
      expect((after.getList('timeline').get(0) as LoroMap).id).toBe(activityId);
      expect(after.getMap('futureRoot').toJSON()).toEqual({ retained: true });
      expect(after.getText('prompt').toString()).toBe('Updated prompt');
    });

    it('uses the common whole-SR planner for runtime idempotency, opaque preservation, manual requests and CAS tombstone races', async () => {
      await schedule().save(save());
      const port = createNativeScheduleRegistry({
        ...options(),
        workspaceId,
        getClient: async () => client,
        flush: async () => {},
        authority: { current: () => true, subscribe: () => () => {} },
      });
      const row = (await port.read()).schedules[0];
      if (!row) throw new Error('Missing fixture schedule');
      await rival.flockBatch(namespace, srRoom, [
        {
          op: 'put',
          key: scheduleRegistryKeys.schedule(row.scheduleId),
          value: {
            ...((
              await client.flockGet(
                namespace,
                srRoom,
                scheduleRegistryKeys.schedule(row.scheduleId)
              )
            ).value as Record<string, import('@loro-dev/loro-repo-client').JsonValue>),
            opaqueFuture: { retained: true },
          },
        },
      ]);
      await port.execute({ kind: 'publish', row: { ...row, title: 'Updated' } });
      expect(
        (await client.flockGet(namespace, srRoom, scheduleRegistryKeys.schedule(row.scheduleId)))
          .value
      ).toMatchObject({ opaqueFuture: { retained: true }, title: 'Updated' });
      const runtime = {
        scheduleId: row.scheduleId,
        machineId: row.machineId,
        activationId: row.activationId,
        observedDefinitionFingerprint: row.definitionFingerprint,
        updatedAt: 2,
        lastDispatch: { scheduledFor: 1, dispatchedAt: 2, sessionId: 'synthetic' },
      };
      await port.execute({ kind: 'put-runtime', runtime });
      const tx = (await client.flockScan(namespace, srRoom)).roomTxId;
      expect(
        await port.execute({
          kind: 'put-runtime',
          runtime: { ...runtime, updatedAt: 3, lastDispatch: undefined },
        })
      ).toEqual({ changed: false });
      expect((await client.flockScan(namespace, srRoom)).roomTxId).toBe(tx);
      const request = {
        scheduleId: row.scheduleId,
        actorId: row.ownerId,
        activationId: row.activationId,
        manualRunId: 'manual',
        requestedAt: 3,
      };
      await port.execute({ kind: 'request-run', request });
      expect(
        await port.execute({ kind: 'request-run', request: { ...request, requestedAt: 4 } })
      ).toEqual({ changed: false });
      await expect(
        port.execute({
          kind: 'request-run',
          request: { ...request, manualRunId: 'wrong-owner', actorId: 'other' },
        })
      ).rejects.toThrow('binding');
      let ready!: () => void;
      const observed = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const observation = await port.observe(
        (snapshot) => {
          if (snapshot.synced && snapshot.manuals.length === 1) ready();
        },
        (error) => {
          throw error;
        }
      );
      await observed;
      const batch = client.flockBatch.bind(client);
      let first = true;
      client.flockBatch = async (...args: Parameters<typeof client.flockBatch>) => {
        if (first) {
          first = false;
          await rival.flockBatch(namespace, srRoom, [
            {
              op: 'put',
              key: scheduleRegistryKeys.tombstone(row.scheduleId),
              value: { deletedAt: 5, actorId: row.ownerId },
            },
          ]);
        }
        return batch(...args);
      };
      try {
        await expect(
          port.execute({ kind: 'publish', row: { ...row, title: 'Must not revive' } })
        ).rejects.toThrow('deleted');
      } finally {
        client.flockBatch = batch;
        await observation.close();
      }
      expect((await port.read()).schedules).toEqual([]);
      const subscribe = client.flockSubscribe.bind(client);
      let acquired!: () => void;
      let finish!: () => void;
      const acquiredHandle = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      client.flockSubscribe = async (...args: Parameters<typeof client.flockSubscribe>) => {
        const handle = await subscribe(...args);
        const unsubscribe = handle.unsubscribe.bind(handle);
        handle.unsubscribe = async () => {
          await unsubscribe();
          throw new Error('Synthetic SR late release ACK loss');
        };
        acquired();
        await gate;
        return handle;
      };
      const late = port.observe(
        () => {},
        () => {}
      );
      const lateRejected = expect(late).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      await acquiredHandle;
      const closing = port.close();
      const closingRejected = expect(closing).rejects.toThrow('cleanup unconfirmed');
      finish();
      await Promise.all([lateRejected, closingRejected]);
      await expect(port.close()).rejects.toThrow('cleanup unconfirmed');
      await client.close();
      await port.close();
      expect(
        (await rival.flockGet(namespace, srRoom, scheduleRegistryKeys.tombstone(row.scheduleId)))
          .found
      ).toBe(true);
      expect(
        (await rival.flockGet(namespace, srRoom, scheduleRegistryKeys.schedule(row.scheduleId)))
          .value
      ).toMatchObject({ title: 'Updated', opaqueFuture: { retained: true } });
    });

    it('routes the real CLI list and manager SR readiness through the native port without an old SR or Meta fallback', async () => {
      await schedule().save(save());
      const registry = createNativeScheduleRegistry({
        ...options(),
        workspaceId,
        getClient: async () => client,
        flush: async () => {},
        authority: { current: () => true, subscribe: () => () => {} },
      });
      const repo = await LoroRepo.create({});
      const manager = new LoroDocumentManager({
        repo,
        workspaceId,
        userId: 'owner',
        metaSub: null,
        logger: getLogger('native-sr-manager-test'),
        scheduleRegistry: registry,
        scheduleRegistryOwnership: 'native',
      });
      const open = repo.openFlockDoc.bind(repo);
      vi.spyOn(repo, 'openFlockDoc').mockImplementation((id) => {
        if (id === srRoom.id) throw new Error('Forbidden old SR replica');
        return open(id);
      });
      vi.spyOn(repo, 'getDocMeta').mockRejectedValue(new Error('Forbidden old Meta fallback'));
      try {
        const result = await executeScheduleCommand(
          {
            manager,
            workspace: { id: workspaceId, contentMode: 'plaintext' },
            auth: { userId: 'owner', machineId: 'machine' },
            localOnly: true,
          } as unknown as ScheduleCommandContext,
          { action: 'list', limit: 20 }
        );
        expect(result).toMatchObject({
          matched: 1,
          schedules: [{ scheduleId: 'synthetic-schedule' }],
        });
        await manager.holdCatalogFlockDoc(srRoom.id);
        expect(await manager.catalogBaselineReady(srRoom.id, 1)).toBe(true);
        await manager.syncFlockDocOrThrow(srRoom.id);
        expect(manager.ownsNativeFlockRoom(srRoom.id)).toBe(true);
        expect(manager.ownsNativeFlockRoom(`${workspaceId}:mf:other`)).toBe(false);
      } finally {
        await registry.close();
        await manager.cleanUp({ preserveSessionStatus: true });
      }
    });

    it('reserves a pristine new Session in one Meta CAS, reconciles unknown ACKs by reading, and rejects every legacy register remnant', async () => {
      await client.createRoom(namespace, META_ROOM);
      if (!sdkCompatibility?.flockStateEntries) {
        expect(() =>
          createNativeWorkspaceMeta({
            binding: { accountId: 'synthetic', workspaceId: namespace },
            generation: 'unavailable',
            client,
            sdkCompatibility,
            sdkArtifactId: undefined,
            assertCurrent() {},
          })
        ).toThrow('unavailable');
        return;
      }
      const binding = { accountId: 'synthetic', workspaceId: namespace };
      const artifact = (await engine.leaseInfo(client)).sdkArtifactId;
      const owners: ReturnType<typeof createNativeWorkspaceMeta>[] = [];
      const makeOwner = (borrowed = client) => {
        const owner = createNativeWorkspaceMeta({
          binding,
          generation: randomUUID(),
          client: borrowed,
          sdkCompatibility,
          sdkArtifactId: artifact,
          assertCurrent() {},
        });
        owners.push(owner);
        return owner;
      };
      const owner = makeOwner(),
        peer = makeOwner(rival);
      const absent = () => ({
        sources: [
          { sourceId: 'renderer-idb', present: false },
          { sourceId: 'daemon-sqlite', present: false },
        ],
        assertCurrent() {},
      });
      const intent = (
        sessionId = randomUUID(),
        title = 'Synthetic new Session',
        reservationId = randomUUID()
      ) => {
        const patch = {
          id: sessionId,
          machineId: 'synthetic-machine',
          userId: binding.accountId,
          createdAt: '2026-11-18T00:00:00.000Z',
          cliType: 'builtin',
          agentType: 'claude',
          historyBackend: 'loro',
          title,
        };
        return {
          sessionId,
          reservationId,
          patch,
          creationIntentSha256: calculateNativeSessionCreationIntentSha256({
            binding,
            sessionId,
            patch,
          }),
          actorId: binding.accountId,
          machineId: 'synthetic-machine',
          assertCurrent() {},
          absenceWitness: absent,
        };
      };
      try {
        const a = intent(),
          b = intent(a.sessionId, 'Competing creator');
        const first = reserveNativeSessionMetadata({ owner, ...a }),
          second = reserveNativeSessionMetadata({ owner: peer, ...b });
        const outcomes = await Promise.allSettled([
          first.reserveMetadata(),
          second.reserveMetadata(),
        ]);
        expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
        const winner = outcomes[0]!.status === 'fulfilled' ? a : b;
        const winnerPort = outcomes[0]!.status === 'fulfilled' ? first : second;
        await winnerPort.assertReservation(winner.reservationId);
        const stored = await owner.document(`session-${a.sessionId}`).read();
        expect(stored).toMatchObject({
          ...winner.patch,
          nativeSessionCreation: {
            version: 1,
            reservationId: winner.reservationId,
            creationIntentSha256: winner.creationIntentSha256,
          },
        });
        const publicSnapshot = JSON.stringify(
          projectWorkspaceMetaPublicSnapshot(await owner.externalMetadata.read(), () => false)
        );
        expect(publicSnapshot).not.toContain(winner.reservationId);
        expect(publicSnapshot).not.toContain(winner.creationIntentSha256);
        expect(() =>
          reserveNativeSessionMetadata({ owner, ...intent(), creationIntentSha256: '0'.repeat(64) })
        ).toThrow('invalid_intent');
        for (const family of ['e', 'm', 'f', 'ld', 'ts']) {
          const next = intent(),
            key =
              family === 'e'
                ? [family, `session-${next.sessionId}`]
                : [family, `session-${next.sessionId}`, 'opaque'];
          await rival.flockBatch(namespace, META_ROOM, [
            { op: 'put', key, value: 'legacy' },
            { op: 'delete', key },
          ]);
          const before = (await rival.flockScan(namespace, META_ROOM)).roomTxId;
          await expect(
            reserveNativeSessionMetadata({ owner, ...next }).reserveMetadata()
          ).rejects.toThrow('conflict');
          expect((await rival.flockScan(namespace, META_ROOM)).roomTxId).toBe(before);
        }
        const noWitness = reserveNativeSessionMetadata({
          owner,
          ...intent(),
          absenceWitness: () => ({
            sources: [{ sourceId: 'existing-old-body', present: true }],
            assertCurrent() {},
          }),
        });
        await expect(noWitness.reserveMetadata()).rejects.toThrow('absence_required');
        expect(owner.isWriteBlocked()).toBe(false);
        const uncertain = intent(),
          unknownPort = reserveNativeSessionMetadata({ owner, ...uncertain });
        const actualWrite = client.flockBatch.bind(client),
          lost = new Error('Synthetic reservation ACK lost');
        const spy = vi.spyOn(client, 'flockBatch').mockImplementationOnce(async (...args) => {
          await actualWrite(...args);
          throw lost;
        });
        await expect(unknownPort.reserveMetadata()).rejects.toBe(lost);
        spy.mockRestore();
        expect(owner.isWriteBlocked()).toBe(true);
        const acceptedHead = (await rival.flockScan(namespace, META_ROOM)).roomTxId;
        await unknownPort.assertReservation(uncertain.reservationId);
        expect((await rival.flockScan(namespace, META_ROOM)).roomTxId).toBe(acceptedHead);
        await owner.close();
        const fresh = makeOwner();
        const reconciled = reserveNativeSessionMetadata({
          owner: fresh,
          ...uncertain,
          absenceWitness: () => {
            throw new Error('A matching receipt must not re-author');
          },
        });
        await reconciled.reserveMetadata();
        await reconciled.assertReservation(uncertain.reservationId);
        expect((await rival.flockScan(namespace, META_ROOM)).roomTxId).toBe(acceptedHead);
        await fresh
          .document(`session-${uncertain.sessionId}`)
          .patch({ title: 'Edited after reservation' });
        await reconciled.assertReservation(uncertain.reservationId);
        const editedHead = (await rival.flockScan(namespace, META_ROOM)).roomTxId;
        await assertNativeSessionMetadataReservation({
          owner: fresh,
          sessionId: uncertain.sessionId,
          reservationId: uncertain.reservationId,
          creationIntentSha256: uncertain.creationIntentSha256,
          actorId: binding.accountId,
          machineId: 'synthetic-machine',
          assertCurrent() {},
        });
        await expect(
          assertNativeSessionMetadataReservation({
            owner: fresh,
            sessionId: uncertain.sessionId,
            reservationId: randomUUID(),
            creationIntentSha256: uncertain.creationIntentSha256,
            actorId: binding.accountId,
            machineId: 'synthetic-machine',
            assertCurrent() {},
          })
        ).rejects.toThrow('conflict');
        expect((await rival.flockScan(namespace, META_ROOM)).roomTxId).toBe(editedHead);
      } finally {
        const closed = await Promise.allSettled(owners.map((owner) => owner.close()));
        const errors = closed
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => item.reason);
        if (errors.length)
          throw new AggregateError(errors, 'Synthetic reservation owner release failed');
      }
    });

    it('owns the complete Meta adapter and Session facet without implicit restore or unknown write replay', async () => {
      await client.createRoom(namespace, META_ROOM);
      if (!sdkCompatibility?.flockStateEntries) {
        expect(() =>
          createNativeWorkspaceMeta({
            binding: { accountId: 'synthetic', workspaceId: namespace },
            generation: 'g1',
            client,
            sdkCompatibility,
            sdkArtifactId: undefined,
            assertCurrent() {},
          })
        ).toThrow('unavailable');
        return;
      }
      const binary = new Flock('synthetic-meta-source');
      binary.put(['e', 'session-synthetic'], true);
      binary.put(['m', 'session-synthetic'], {
        title: 'Legacy',
        hidden: 'inline',
        inlineOnly: 'remove me',
        future: { retained: true },
      });
      binary.put(['m', 'session-synthetic', 'hidden'], 'old leaf');
      binary.delete(['m', 'session-synthetic', 'hidden']);
      await client.importRoomState(namespace, META_ROOM, {
        snapshot: binary.exportFile(),
        enqueueOutbox: false,
      });
      await rival.flockBatch(namespace, META_ROOM, [
        { op: 'put', key: ['m', 'session-synthetic', 'unsafe'], value: 9223372036854775806n },
        { op: 'put', key: ['m', 'session-synthetic', 'bytes'], value: new Uint8Array([0, 255]) },
        { op: 'put', key: ['opaque', 9223372036854775805n], value: 'preserve' },
      ]);
      const owner = createNativeWorkspaceMeta({
        binding: { accountId: 'synthetic', workspaceId: namespace },
        generation: 'g1',
        client,
        sdkCompatibility,
        sdkArtifactId: (await engine.leaseInfo(client)).sdkArtifactId,
        assertCurrent() {},
      });
      const updates: number[] = [];
      const subscription = await owner.externalMetadata.open((update) =>
        updates.push(update.snapshot.revision)
      );
      const session = owner.document('session-synthetic');
      expect(await session.read()).toMatchObject({
        title: 'Legacy',
        hidden: null,
        unsafe: 9223372036854775806n,
        bytes: new Uint8Array([0, 255]),
      });
      await session.patch({
        title: 'Native',
        hidden: undefined,
        inlineOnly: undefined,
        nullable: null,
      });
      await session.flush();
      const patchedEntries = await requireNativeFlockEntries(client, {
        compatibility: sdkCompatibility,
        sdkArtifactId: (await engine.leaseInfo(client)).sdkArtifactId,
      }).scan(namespace, META_ROOM);
      expect(
        patchedEntries.entries.find(
          (row) =>
            row.key[0] === 'm' && row.key[1] === 'session-synthetic' && row.key[2] === 'inlineOnly'
        )
      ).toMatchObject({ deleted: true, value: null });
      expect(await session.read()).toMatchObject({
        title: 'Native',
        hidden: null,
        inlineOnly: null,
        nullable: null,
        future: { retained: true },
      });
      await expect(owner.document('missing').patch({ title: 'Cannot create' })).rejects.toThrow(
        'not active'
      );
      await owner.externalMetadata.commit({ kind: 'delete-doc', docId: 'session-synthetic' });
      await owner.externalMetadata.commit({ kind: 'ensure-doc', docId: 'session-synthetic' });
      await owner.externalMetadata.commit({
        kind: 'upsert-doc',
        docId: 'session-synthetic',
        patch: { title: 'Still deleted' },
      });
      expect(await session.read()).toBeUndefined();
      await owner.externalMetadata.commit({ kind: 'restore-doc', docId: 'missing' });
      expect(
        (await owner.externalMetadata.read()).docs.some((row) => row.docId === 'missing')
      ).toBe(false);
      await owner.externalMetadata.commit({ kind: 'restore-doc', docId: 'session-synthetic' });
      expect(await session.read()).toMatchObject({
        title: 'Still deleted',
        unsafe: 9223372036854775806n,
      });
      await owner.externalMetadata.commit({
        kind: 'ensure-flock',
        flockDocId: 'body',
        expiresAtMs: 100,
      });
      await owner.externalMetadata.commit({
        kind: 'ensure-flock',
        flockDocId: 'body',
        expiresAtMs: 50,
      });
      expect((await owner.externalMetadata.read()).flockDocs).toEqual([
        { flockDocId: 'body', deleted: false, expiresAtMs: 100 },
      ]);
      await session.patch({ latestUserMsgId: 'turn-before-race' });
      const beforeCas = client.flockBatch.bind(client);
      const conflict = vi.spyOn(client, 'flockBatch').mockImplementationOnce(async (...args) => {
        await rival.flockBatch(namespace, META_ROOM, [
          {
            op: 'put',
            key: ['m', 'session-synthetic', 'latestUserMsgId'],
            value: 'turn-newer-peer',
          },
        ]);
        return beforeCas(...args);
      });
      await session.update((current) =>
        current.latestUserMsgId === 'turn-before-race'
          ? { activationReceipt: 'must-not-overwrite' }
          : undefined
      );
      conflict.mockRestore();
      expect(await session.read()).toMatchObject({ latestUserMsgId: 'turn-newer-peer' });
      expect((await session.read())?.activationReceipt).toBeUndefined();
      const beforeAuthorizationCas = client.flockBatch.bind(client);
      let authorizedPeerHead = 0;
      const authorizationRace = vi
        .spyOn(client, 'flockBatch')
        .mockImplementationOnce(async (...args) => {
          const ack = await rival.flockBatch(namespace, META_ROOM, [
            { op: 'put', key: ['e', 'session-authorized'], value: true },
            { op: 'put', key: ['m', 'session-authorized', 'machineId'], value: 'foreign-machine' },
          ]);
          authorizedPeerHead = ack.roomTxId;
          return beforeAuthorizationCas(...args);
        });
      await expect(
        owner.commitAuthorized(
          {
            kind: 'upsert-doc',
            docId: 'session-authorized',
            patch: { machineId: 'local-machine', title: 'Must not take over' },
          },
          (current) => {
            const existing = current.docs.find((row) => row.docId === 'session-authorized');
            if (existing && existing.meta.machineId !== 'local-machine')
              throw new Error('Synthetic foreign Meta owner');
          }
        )
      ).rejects.toThrow('foreign Meta owner');
      authorizationRace.mockRestore();
      expect(await owner.document('session-authorized').read()).toEqual({
        machineId: 'foreign-machine',
      });
      const authorizationState = await (
        await import('@lody/shared/node/native-repo-flock-entries')
      )
        .requireNativeFlockEntries(client, {
          compatibility: sdkCompatibility,
          sdkArtifactId: (await engine.leaseInfo(client)).sdkArtifactId,
        })
        .scan(namespace, META_ROOM);
      expect(authorizationState.roomTxId).toBe(authorizedPeerHead);
      await owner.externalMetadata.commit({ kind: 'purge-doc', docId: 'session-synthetic' });
      expect(await session.read()).toBeUndefined();
      const port = (
        await import('@lody/shared/node/native-repo-flock-entries')
      ).requireNativeFlockEntries(client, {
        compatibility: sdkCompatibility,
        sdkArtifactId: (await engine.leaseInfo(client)).sdkArtifactId,
      });
      const rows = (await port.scan(namespace, META_ROOM)).entries;
      expect(rows.find((row) => row.key[0] === 'opaque')?.value).toBe('preserve');
      expect(
        rows.filter((row) => row.key[1] === 'session-synthetic').every((row) => row.deleted)
      ).toBe(true);
      expect(
        updates.every((revision, index) => index === 0 || revision > updates[index - 1]!)
      ).toBe(true);
      subscription.unsubscribe();
      const original = client.flockBatch.bind(client);
      expect(owner.isWriteBlocked()).toBe(false);
      const lost = new Error('Synthetic accepted Meta write ACK lost');
      vi.spyOn(client, 'flockBatch').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw lost;
      });
      await expect(
        owner.externalMetadata.commit({ kind: 'ensure-doc', docId: 'unknown-ack' })
      ).rejects.toBe(lost);
      expect(owner.isWriteBlocked()).toBe(true);
      const accepted = (await port.scan(namespace, META_ROOM)).roomTxId;
      await expect(
        owner.externalMetadata.commit({
          kind: 'upsert-doc',
          docId: 'unknown-ack',
          patch: { title: 'Do not replay' },
        })
      ).rejects.toBe(lost);
      await expect(owner.externalMetadata.flush()).rejects.toBe(lost);
      expect((await port.scan(namespace, META_ROOM)).roomTxId).toBe(accepted);
      expect(
        (await owner.externalMetadata.read()).docs.find((row) => row.docId === 'unknown-ack')
      ).toMatchObject({ deleted: false });
      await owner.close();
      expect(
        (await rival.flockScan(namespace, META_ROOM)).entries.some(
          (row) => row.key[1] === 'unknown-ack'
        )
      ).toBe(true);
    });

    it(
      sdkCompatibility?.flockStateEntries
        ? 'reads complete inline and tombstone Meta without rewriting raw state and observes changes and authority'
        : 'refuses native Meta on the actual unavailable SDK without touching legacy state',
      async () => {
        const legacy = await LoroRepo.create({});
        const meta = legacy.getMeta();
        meta.put(['e', 'session-inline'], true);
        meta.put(['m', 'session-inline'], {
          title: 'Old inline',
          future: { retained: true },
          removedLegacy: 'must stay removed',
        });
        meta.put(['m', 'session-inline', 'removedLegacy'], 'temporary');
        meta.delete(['m', 'session-inline', 'removedLegacy']);
        meta.put(['m', 'session-inline', 'title'], 'Leaf override');
        meta.put(['m', 'session-inline', 'removed'], null);
        meta.put(['e', 'session-deleted'], false);
        meta.put(['m', 'session-deleted', 'title'], 'Deleted');
        meta.put(['e', 'schedule-orphan'], true);
        meta.put(['e', 'tombstone-only'], true);
        meta.put(['m', 'tombstone-only', 'removed'], 'old');
        meta.delete(['m', 'tombstone-only', 'removed']);
        meta.commit();
        const old = createLegacyWorkspaceDirectory(legacy);
        await client.createRoom(namespace, META_ROOM);
        await client.importRoomState(namespace, META_ROOM, {
          snapshot: meta.exportFile(),
          enqueueOutbox: false,
        });
        let allowed = true;
        let synced = false;
        let generation = 'first';
        const authorityListeners = new Set<() => void>();
        const directoryPort = createNativeWorkspaceDirectory({
          namespace,
          getClient: async () => client,
          sdkCompatibility,
          getClientArtifactId: async (expected) => (await engine.leaseInfo(expected)).sdkArtifactId,
          assertAccess() {
            if (!allowed) throw new Error('Meta access denied');
          },
          authority: {
            get: () => ({ synced, generation }),
            subscribe(listener) {
              authorityListeners.add(listener);
              return () => {
                authorityListeners.delete(listener);
              };
            },
          },
        });
        const createRoom = vi
          .spyOn(client, 'createRoom')
          .mockRejectedValue(new Error('Directory cannot ensure rooms'));
        const exportRaw = vi
          .spyOn(client, 'exportLoroRaw')
          .mockRejectedValue(new Error('Directory cannot open document bodies'));
        const errors: unknown[] = [];
        const events: import('@lody/shared/workspace-directory').WorkspaceDirectoryChange[] = [];
        let changed!: () => void;
        const nextChange = () =>
          new Promise<void>((resolve) => {
            changed = resolve;
          });
        let observation: Awaited<ReturnType<typeof directoryPort.observe>> | undefined;
        try {
          if (!sdkCompatibility?.flockStateEntries) {
            await expect(directoryPort.listEntries()).rejects.toMatchObject({
              code: 'unavailable',
            });
            await expect(directoryPort.observe(() => {})).rejects.toMatchObject({
              code: 'unavailable',
            });
            expect(meta.getEntry(['m', 'session-inline', 'removedLegacy'])).toBeDefined();
            return;
          }
          expect(await directoryPort.listActiveIds()).toEqual(await old.listActiveIds());
          await client.compactRoom(namespace, META_ROOM);
          const rawBefore = readNativeFlockSnapshot({
            dataDir: directory,
            namespace,
            room: { kind: 'meta', id: 'meta' },
          });
          expect((await old.listEntries())[0]?.meta.removedLegacy).toBeNull();
          const preserved = Flock.strictFromFile(rawBefore.bytes);
          expect(preserved.getEntry(['m', 'session-inline', 'removedLegacy'])).toEqual(
            meta.getEntry(['m', 'session-inline', 'removedLegacy'])
          );
          expect(preserved.getEntry(['m', 'session-inline'])).toEqual(
            meta.getEntry(['m', 'session-inline'])
          );
          expect(preserved.getEntry(['m', 'tombstone-only', 'removed'])).toEqual(
            meta.getEntry(['m', 'tombstone-only', 'removed'])
          );

          expect(await directoryPort.listEntries()).toEqual(await old.listEntries());
          expect(await directoryPort.getEntry('session-inline')).toMatchObject({
            meta: { removedLegacy: null, title: 'Leaf override' },
          });
          expect(await directoryPort.getEntry('tombstone-only')).toMatchObject({
            meta: { removed: null },
          });
          const rawAfter = readNativeFlockSnapshot({
            dataDir: directory,
            namespace,
            room: { kind: 'meta', id: 'meta' },
          });
          expect(rawAfter.bytes).toEqual(rawBefore.bytes);
          expect(rawAfter.sha256).toBe(rawBefore.sha256);
          expect(await directoryPort.listEntries()).toEqual(await old.listEntries());
          expect(await directoryPort.getEntry('session-inline')).toMatchObject({
            docId: 'session-inline',
            exists: true,
            meta: { title: 'Leaf override', removed: null, future: { retained: true } },
          });
          expect(await directoryPort.getEntry('session-deleted')).toMatchObject({ deleted: true });
          expect(await directoryPort.getEntry('missing')).toBeUndefined();
          // These writes remain in the native local log after the compacted base.
          // Directory reads must include that overlay and preserve wire-only values.
          await rival.flockBatch(namespace, META_ROOM, [
            { op: 'put', key: ['m', 'session-inline', 'exact'], value: 9007199254740993n },
            {
              op: 'put',
              key: ['m', 'session-inline', 'bytes'],
              value: new Uint8Array([0, 255, 128]),
            },
            { op: 'put', key: ['future', 9007199254740995n], value: { retained: true } },
          ]);
          expect(() =>
            readNativeFlockSnapshot({
              dataDir: directory,
              namespace,
              room: { kind: 'meta', id: 'meta' },
            })
          ).toThrow('not fully compacted');
          const completeBefore = await exportNativeFlockRaw(
            client,
            {
              compatibility: sdkCompatibility,
              sdkArtifactId: (await engine.leaseInfo(client)).sdkArtifactId,
            },
            namespace,
            META_ROOM
          );
          expect(await directoryPort.getEntry('session-inline')).toMatchObject({
            meta: {
              exact: 9007199254740993n,
              bytes: new Uint8Array([0, 255, 128]),
              removedLegacy: null,
            },
          });
          const completeAfter = await exportNativeFlockRaw(
            client,
            {
              compatibility: sdkCompatibility,
              sdkArtifactId: (await engine.leaseInfo(client)).sdkArtifactId,
            },
            namespace,
            META_ROOM
          );
          expect(completeAfter).toEqual(completeBefore);

          observation = await directoryPort.observe(
            (event) => {
              events.push(event);
              if (event.kind === 'doc-metadata' && event.patch.title === 'New title') changed();
            },
            (error) => errors.push(error)
          );
          expect(events[0]).toMatchObject({ kind: 'snapshot-reset' });
          expect(directoryPort.authority?.get().synced).toBe(false);
          synced = true;
          for (const listener of authorityListeners) listener();
          expect(directoryPort.authority?.get()).toEqual({ synced: true, generation: 'first' });
          const observed = nextChange();
          await rival.flockBatch(namespace, META_ROOM, [
            {
              op: 'put',
              key: ['m', 'session-inline'],
              value: {
                title: 'New inline title',
                future: { retained: true },
                removedLegacy: 'must not revive',
              },
            },
          ]);
          await rival.repoMeta(namespace).setDocMeta('session-inline', 'title', 'New title');
          await observed;
          expect(await directoryPort.getEntry('session-inline')).toMatchObject({
            meta: { title: 'New title', removedLegacy: null, exact: 9007199254740993n },
          });
          expect(
            events
              .filter((event) => event.kind === 'doc-metadata')
              .every(
                (event) => !('removedLegacy' in event.patch) || event.patch.removedLegacy === null
              )
          ).toBe(true);
          allowed = false;
          await expect(directoryPort.listActiveIds()).rejects.toThrow('access denied');
          allowed = true;
          await client.close();
          expect(directoryPort.authority?.get().synced).toBe(false);
          expect(errors).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: 'restart_required' })])
          );
          await observation.unsubscribe();
          observation = undefined;
          client = await engine.client();
          generation = 'second';
          observation = await directoryPort.observe(
            (event) => events.push(event),
            (error) => errors.push(error)
          );
          expect(events.at(-1)).toMatchObject({
            kind: 'snapshot-reset',
            entries: expect.arrayContaining([
              expect.objectContaining({
                docId: 'session-inline',
                meta: expect.objectContaining({ title: 'New title' }),
              }),
            ]),
          });
          expect(directoryPort.authority?.get()).toEqual({ synced: true, generation: 'second' });
        } finally {
          await observation?.unsubscribe();
          await directoryPort.close();
          createRoom.mockRestore();
          exportRaw.mockRestore();
          await legacy.destroy();
        }
      }
    );

    it('leaves an unpublished orphan after failed definition durability, supports explicit replay, and never revives a tombstone', async () => {
      let fail = true;
      const adapter = schedule({
        flushDefinition: async () => {
          if (fail) throw new Error('synthetic disk barrier failure');
        },
      });
      await expect(adapter.save(save())).rejects.toThrow('synthetic disk barrier failure');
      expect((await adapter.read())?.definition.scheduleId).toBe('synthetic-schedule');
      expect((await registry().read('synthetic-schedule')).row).toBeUndefined();
      fail = false;
      await adapter.save(save());
      await expect(
        adapter.save({ ...save(), create: false, actorId: 'other', activityId: 'forbidden' })
      ).rejects.toThrow('Only the Schedule owner');
      await rival.flockBatch(namespace, srRoom, [
        {
          op: 'put',
          key: scheduleRegistryKeys.tombstone('synthetic-schedule'),
          value: { deletedAt: 10, actorId: 'owner' },
        },
      ]);
      await expect(adapter.save(save())).rejects.toThrow('Schedule was deleted');
      expect((await registry().read('synthetic-schedule')).deleted).toBe(true);
    });
    const manifest = (): NativeLoroDocumentManifest => ({
      migrationId: 'synthetic-migration',
      binding: 'account/workspace',
      namespace,
      roomId: pcRoom.id,
      family: 'preview_comments',
      targetGeneration: 'synthetic-engine',
      sourceIds: ['old-profile'],
    });
    const journal = (selectedClient = client) => {
      const instance = new NativeLoroDocumentMigration(
        join(directory, 'single-doc-migration.sqlite'),
        {
          client: selectedClient,
          assertAccess(value) {
            if (
              value.binding !== 'account/workspace' ||
              value.targetGeneration !== 'synthetic-engine'
            )
              throw new Error('Synthetic owner binding changed');
          },
        }
      );
      journals.push(instance);
      return instance;
    };
    const frozenSource = () => {
      const doc = new LoroDoc();
      docs.push(doc);
      doc.getMap('meta').set('sessionId', sessionId);
      const turn = doc.getMap('turns').setContainer('turn', new LoroMap());
      turn.set('turnId', 'turn');
      const stored = turn.setContainer('comments', new LoroList()).pushContainer(new LoroMap());
      for (const [key, value] of Object.entries(comment('old')))
        if (value !== undefined) stored.set(key, value as never);
      stored.set('futureField', { preserved: true });
      doc.commit();
      return { doc, bytes: doc.export({ mode: 'snapshot' }), commentId: stored.id };
    };

    it('migrates frozen binary/CIDs, persists the selected owner across restart, and rolls back only after reading flushed legacy bytes', async () => {
      const source = frozenSource();
      let controller = journal();
      await controller.migrate(manifest(), {
        async drainLegacy() {
          expect(controller.route(manifest().binding, pcRoom.id)).toBe('frozen');
          return [{ sourceId: 'old-profile', bytes: source.bytes }];
        },
      });
      controller.close();
      controller = journal();
      expect(controller.route(manifest().binding, pcRoom.id)).toBe('native');
      const after = await exported(pcRoom);
      expect(
        (
          ((after.getMap('turns').get('turn') as LoroMap).get('comments') as LoroList).get(
            0
          ) as LoroMap
        ).id
      ).toBe(source.commentId);
      await createNativePreviewComments({ ...options(), sessionId }).mutatePreviewVisualComments(
        sessionId,
        { kind: 'resolve', commentId: 'old', resolvedAt: 2, resolvedBy: 'owner' }
      );
      await controller.rollback(manifest(), {
        async drainNative() {
          expect(controller.route(manifest().binding, pcRoom.id)).toBe('frozen');
        },
        async mergeAndFlushLegacy(bytes) {
          source.doc.import(bytes);
          const persistedPath = join(directory, 'legacy-persisted.loro');
          await writeFile(persistedPath, source.doc.export({ mode: 'snapshot' }));
          return [{ sourceId: 'old-profile', bytes: await readFile(persistedPath) }];
        },
      });
      expect(controller.route(manifest().binding, pcRoom.id)).toBe('legacy');
      expect(source.doc.toJSON()).toMatchObject({
        turns: { turn: { comments: [{ resolvedAt: 2, futureField: { preserved: true } }] } },
      });
    });

    it('retains the durable fence after lost import ACK, rejects changed frozen sources and resumes the exact inventory', async () => {
      const source = frozenSource();
      let lose = true;
      const lossy = new Proxy(client, {
        get(target, key) {
          if (key === 'importRoomState')
            return async (...args: Parameters<RepoClient['importRoomState']>) => {
              const result = await target.importRoomState(...args);
              if (lose) {
                lose = false;
                throw new Error('synthetic lost migration ACK');
              }
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      let controller = journal(lossy);
      await expect(
        controller.migrate(manifest(), {
          drainLegacy: async () => [{ sourceId: 'old-profile', bytes: source.bytes }],
        })
      ).rejects.toThrow('synthetic lost migration ACK');
      controller.close();
      controller = journal();
      expect(controller.route(manifest().binding, pcRoom.id)).toBe('frozen');
      source.doc.getMap('futureRoot').set('late', true);
      source.doc.commit();
      await expect(
        controller.migrate(manifest(), {
          drainLegacy: async () => [
            { sourceId: 'old-profile', bytes: source.doc.export({ mode: 'snapshot' }) },
          ],
        })
      ).rejects.toThrow('Frozen Loro source bytes changed');
      await controller.migrate(manifest(), {
        drainLegacy: async () => [{ sourceId: 'old-profile', bytes: source.bytes }],
      });
      expect(controller.route(manifest().binding, pcRoom.id)).toBe('native');
    });

    it('requires every old owner to persist the native causal state and fences a target that changes during rollback', async () => {
      const source = frozenSource();
      const controller = journal();
      await controller.migrate(manifest(), {
        drainLegacy: async () => [{ sourceId: 'old-profile', bytes: source.bytes }],
      });
      await createNativePreviewComments({ ...options(), sessionId }).mutatePreviewVisualComments(
        sessionId,
        { kind: 'resolve', commentId: 'old', resolvedAt: 2, resolvedBy: 'owner' }
      );
      await expect(
        controller.rollback(manifest(), {
          drainNative: async () => {},
          mergeAndFlushLegacy: async () => [{ sourceId: 'old-profile', bytes: source.bytes }],
        })
      ).rejects.toThrow('Each persisted legacy owner');
      expect(controller.route(manifest().binding, pcRoom.id)).toBe('frozen');
      await expect(
        controller.rollback(manifest(), {
          drainNative: async () => {},
          async mergeAndFlushLegacy(bytes) {
            source.doc.import(bytes);
            await rival.applyDocPatch(namespace, pcRoom, [
              { op: 'set', path: ['meta', 'syntheticLatePeer'], value: true },
            ]);
            return [{ sourceId: 'old-profile', bytes: source.doc.export({ mode: 'snapshot' }) }];
          },
        })
      ).rejects.toThrow('Native document changed during frozen rollback');
      expect(controller.route(manifest().binding, pcRoom.id)).toBe('frozen');
      await controller.rollback(manifest(), {
        drainNative: async () => {},
        async mergeAndFlushLegacy(bytes) {
          source.doc.import(bytes);
          return [{ sourceId: 'old-profile', bytes: source.doc.export({ mode: 'snapshot' }) }];
        },
      });
      expect(controller.route(manifest().binding, pcRoom.id)).toBe('legacy');
      expect(source.doc.getMap('meta').get('syntheticLatePeer')).toBe(true);
    });

    it('rejects unrelated target operations and separately authorized Shortcut manifests before import', async () => {
      const source = frozenSource();
      const controller = journal();
      await rival.applyDocPatch(namespace, pcRoom, [
        { op: 'set', path: ['meta', 'unrelated'], value: true },
      ]);
      const checkpoint = (await client.exportLoroRaw(namespace, pcRoom)).roomTxId;
      await expect(
        controller.migrate(manifest(), {
          drainLegacy: async () => [{ sourceId: 'old-profile', bytes: source.bytes }],
        })
      ).rejects.toThrow('operations outside');
      expect((await client.exportLoroRaw(namespace, pcRoom)).roomTxId).toBe(checkpoint);
      await expect(
        controller.migrate(
          { ...manifest(), roomId: 'prompt-shortcut-independent' },
          { drainLegacy: async () => [] }
        )
      ).rejects.toThrow('Invalid single-document family');
      expect(controller.route(manifest().binding, 'prompt-shortcut-independent')).toBe('legacy');
    });

    it('does not enable legacy writers when only one of two persisted old owners has native changes', async () => {
      const source = frozenSource();
      const controller = journal();
      const selected = { ...manifest(), sourceIds: ['old-a', 'old-b'] };
      await controller.migrate(selected, {
        drainLegacy: async () =>
          selected.sourceIds.map((sourceId) => ({ sourceId, bytes: source.bytes })),
      });
      await createNativePreviewComments({ ...options(), sessionId }).mutatePreviewVisualComments(
        sessionId,
        { kind: 'resolve', commentId: 'old', resolvedAt: 2, resolvedBy: 'owner' }
      );
      await expect(
        controller.rollback(selected, {
          drainNative: async () => {},
          mergeAndFlushLegacy: async (native) => [
            { sourceId: 'old-a', bytes: native },
            { sourceId: 'old-b', bytes: source.bytes },
          ],
        })
      ).rejects.toThrow('Each persisted legacy owner');
      expect(controller.route(selected.binding, pcRoom.id)).toBe('frozen');
    });

    it('routes actual ScheduleRepository and preview authors through persisted whole-document ownership without opening legacy Docs', async () => {
      if (!sdkCompatibility) throw new Error('This lane requires the explicit local SDK proof');
      const absentRoot = join(fixtureRoot, 'positive-legacy-leaf-default');
      expect(
        await openNativeLocalDocumentDomainsLegacy({
          accountId: 'local:leaf-default',
          workspaceId: 'lw_leaf_default' as WorkspaceId,
          encrypted: false,
          cloud: false,
          dataRoot: absentRoot,
          metadata: undefined,
          registry: createNativeScheduleRegistry({
            ...options(),
            workspaceId: 'lw_leaf_default' as WorkspaceId,
            getClient: async () => client,
            flush: async () => {},
          }),
        })
      ).toBeNull();
      await expect(readFile(join(absentRoot, 'native-repo'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const accountId = 'small-domain-account';
      const selectedWorkspace = namespace as WorkspaceId;
      const journalPath = join(directory, 'actual-small-document-routes.sqlite3');
      const selectedBinding = JSON.stringify([accountId, selectedWorkspace]);
      const selected = new NativeLoroDocumentMigration(journalPath, { client, assertAccess() {} });
      journals.push(selected);
      const source = frozenSource();
      const manifestFor = (family: 'preview_comments' | 'schedule_definition', roomId: string) => ({
        migrationId: `actual-${family}`,
        binding: selectedBinding,
        namespace,
        roomId,
        family,
        targetGeneration: 'synthetic-generation',
        sourceIds: ['legacy-binary'],
      });
      await selected.migrate(manifestFor('preview_comments', pcRoom.id), {
        drainLegacy: async () => [{ sourceId: 'legacy-binary', bytes: source.bytes }],
      });
      // A real saved definition supplies full causal binary and the original SR gate.
      const saved = await schedule().save(save());
      await client.createRoom(
        namespace,
        { kind: 'flock', id: getScheduleRegistryFlockDocId(selectedWorkspace) },
        'plaintext'
      );
      const selectedRegistry = createNativeScheduleDefinitionRegistry({
        ...options(),
        workspaceId: selectedWorkspace,
        flush: async () => {},
      });
      await selectedRegistry.publish(buildScheduleRegistryRow(saved));
      const definitionBytes = (await client.exportLoroRaw(namespace, scheduleRoom)).bytes;
      await selected.migrate(manifestFor('schedule_definition', scheduleRoom.id), {
        drainLegacy: async () => [{ sourceId: 'legacy-binary', bytes: definitionBytes }],
      });
      let authorized = true;
      const domains = createNativeDocumentDomains({
        accountId,
        workspaceId: selectedWorkspace,
        journalPath,
        dataDir: directory,
        compatibility: sdkCompatibility,
        writer: 'actual-small-doc-domain',
        registry: selectedRegistry,
        assertCurrent() {},
        authorize: async () => {
          if (!authorized) throw new Error('Metadata access revoked');
        },
        getClient: async () => ({
          client,
          generation: 'synthetic-generation',
          sdkArtifactId: sdkCompatibility.artifactId,
        }),
        flushDefinition: async () => {},
      });
      try {
        expect(await domains.definitions.resolve('positively-legacy')).toBeUndefined();
        const deniedOldDoc = async () => {
          throw new Error('Retired legacy Doc must never open');
        };
        const repository = new ScheduleRepository(
          { openPersistedDoc: deniedOldDoc, openFlockDoc: deniedOldDoc, flush: deniedOldDoc },
          selectedWorkspace,
          {
            registry: createNativeScheduleRegistry({
              ...options(),
              getClient: async () => client,
              workspaceId: selectedWorkspace,
              flush: async () => {},
            }),
            definitions: domains.definitions,
          }
        );
        const renamed = await repository.save({
          ...save(),
          create: false,
          activityId: 'actual-edit',
          now: 2,
          draft: { ...save().draft, title: 'Actual native definition' },
        });
        expect(renamed.definition.title).toBe('Actual native definition');
        expect((await repository.read(save().scheduleId))?.definition.title).toBe(
          'Actual native definition'
        );
        await repository.setEnabled({
          scheduleId: save().scheduleId,
          actorId: 'owner',
          enabled: false,
          now: 3,
          activationId: 'paused',
          requestId: 'pause',
        });
        expect((await repository.read(save().scheduleId))?.definition.enabled).toBe(false);
        const preview = await domains.preview(sessionId);
        expect(preview).toBeDefined();
        await preview!.mutatePreviewVisualComments(sessionId, {
          kind: 'resolve',
          commentId: 'old',
          resolvedAt: 4,
          resolvedBy: 'owner',
        });
        expect((await preview!.read()).turns.turn?.comments[0]?.resolvedAt).toBe(4);
        let receive: (value: unknown) => void = () => {};
        const main = new NativeDocumentDomainsMainLegacy({
          async acquire(_window, _registration, target) {
            if (!authorized) throw new Error('Metadata access revoked');
            if (target.domain === 'preview_comments') {
              const port = await domains.preview(target.id as SessionId);
              if (!port) throw new Error('Not selected native');
              return {
                domain: 'preview_comments',
                port,
                actorId: 'owner',
                generation: 'domain-generation',
                assertCurrent() {
                  if (!authorized) throw new Error('Metadata access revoked');
                },
              };
            }
            const port = await domains.schedule(target.id);
            if (!port) throw new Error('Not selected native');
            return {
              domain: 'schedule_definition',
              port,
              actorId: 'owner',
              machineId: 'machine',
              generation: 'domain-generation',
              assertCurrent() {
                if (!authorized) throw new Error('Metadata access revoked');
              },
            };
          },
          send(_window, event) {
            receive(event);
          },
        });
        const transport: NativeDocumentDomainTransport = {
          readNativeDocumentDomain: (request) => main.read(17, request),
          executeNativeDocumentDomain: (request) => main.execute(17, request),
          observeNativeDocumentDomain: (request) => main.observe(17, request),
          unobserveNativeDocumentDomain: (request) => main.unsubscribe(17, request),
          cancelNativeDocumentDomain: (request) => main.cancel(17, request),
        };
        const registrationId = randomUUID();
        const renderer = createNativeDocumentDomainClient({
          registrationId,
          target: { domain: 'preview_comments', id: sessionId },
          transport,
          listen(listener) {
            receive = listener;
            return () => {
              receive = () => {};
            };
          },
        });
        try {
          expect(JSON.stringify(await renderer.preview.read())).not.toContain('futureField');
          let observed!: () => void;
          const updated = new Promise<void>((resolve) => {
            observed = resolve;
          });
          const lease = await renderer.observe(
            (snapshot) => {
              if (
                snapshot.domain === 'preview_comments' &&
                snapshot.value.turns.turn?.comments[0]?.resolvedAt === 7
              )
                observed();
            },
            (error) => {
              throw error;
            }
          );
          await renderer.preview.mutatePreviewVisualComments(sessionId, {
            kind: 'resolve',
            commentId: 'old',
            resolvedAt: 7,
            resolvedBy: 'owner',
          });
          await updated;
          const head = (await client.readDoc(namespace, pcRoom)).roomTxId;
          await expect(
            renderer.preview.mutatePreviewVisualComments(sessionId, {
              kind: 'resolve',
              commentId: 'old',
              resolvedAt: 8,
              resolvedBy: 'forged-user',
            })
          ).rejects.toMatchObject({ code: 'access_denied' });
          await expect(
            main.execute(17, {
              registrationId,
              requestId: randomUUID(),
              target: { domain: 'preview_comments', id: sessionId },
              expectedGeneration: 'stale-generation',
              command: {
                kind: 'preview-mutate',
                mutation: { kind: 'unresolve', commentId: 'old', updatedAt: 8 },
              },
            })
          ).rejects.toMatchObject({ code: 'restart_required' });
          expect((await client.readDoc(namespace, pcRoom)).roomTxId).toBe(head);
          await lease.close();
          const rendererDefinition = createNativeDocumentDomainClient({
            registrationId,
            target: { domain: 'schedule_definition', id: save().scheduleId },
            transport,
            listen(listener) {
              receive = listener;
              return () => {
                receive = () => {};
              };
            },
          });
          try {
            const persisted = await rendererDefinition.definition.save({
              ...save(),
              actorId: 'forged-renderer-actor',
              create: false,
              activityId: 'finite-save',
              draft: { ...save().draft, title: 'Finite renderer definition' },
            });
            expect(persisted.definition).toMatchObject({
              ownerId: 'owner',
              machineId: 'machine',
              title: 'Finite renderer definition',
            });
            const scheduleHead = (await client.readDoc(namespace, scheduleRoom)).roomTxId;
            await expect(
              rendererDefinition.definition.save({
                ...save(),
                create: false,
                activityId: 'forbidden-rebind',
                draft: { ...save().draft, machineId: 'another-machine' },
              })
            ).rejects.toMatchObject({ code: 'access_denied' });
            expect((await client.readDoc(namespace, scheduleRoom)).roomTxId).toBe(scheduleHead);
          } finally {
            await rendererDefinition.close();
          }
          const canceledRequest = {
            registrationId,
            requestId: randomUUID(),
            target: { domain: 'preview_comments' as const, id: sessionId },
          };
          await main.cancel(17, canceledRequest);
          await expect(main.observe(17, canceledRequest)).rejects.toMatchObject({
            code: 'access_denied',
          });
          // A lost unsubscribe ACK retains its exact SDK lease. Data access by
          // another client remains usable; only transport loss proves cleanup.
          const originalSubscribe = client.subscribeDoc.bind(client);
          const failure = vi.spyOn(client, 'subscribeDoc').mockImplementation(async (...args) => {
            const handle = await originalSubscribe(...args);
            const release = handle.unsubscribe.bind(handle);
            handle.unsubscribe = async () => {
              await release();
              throw new Error('Synthetic unsubscribe ACK lost');
            };
            return handle;
          });
          const retained = createNativeDocumentDomainClient({
            registrationId,
            target: { domain: 'preview_comments', id: sessionId },
            transport,
            listen(listener) {
              receive = listener;
              return () => {
                receive = () => {};
              };
            },
          });
          try {
            await retained.observe(
              () => {},
              () => {}
            );
            await expect(retained.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
            expect((await rival.readDoc(namespace, pcRoom)).roomTxId).toBe(head);
            await client.close();
            await retained.retryCleanup();
          } finally {
            failure.mockRestore();
            await retained.retryCleanup();
          }
        } finally {
          await renderer.close();
          await main.close();
        }
        // This independent comment owner never asks which history backend the
        // parent Session uses; a Roost body grants no authoring rights here.
        authorized = false;
        await expect(
          preview!.mutatePreviewVisualComments(sessionId, {
            kind: 'unresolve',
            commentId: 'old',
            updatedAt: 5,
          })
        ).rejects.toThrow('Metadata access revoked');
        await expect(repository.read(save().scheduleId)).rejects.toThrow('Metadata access revoked');
      } finally {
        await domains.close();
      }
    });

    it('keeps exact i64, binary and unknown nested Schedule and inline comment values while real domain commands edit known fields', async () => {
      if (!sdkCompatibility?.setValue || !sdkCompatibility.losslessWireI64)
        throw new Error('Explicit lossless local SDK proof required');
      const withMessage = {
        ...save(),
        draft: {
          ...save().draft,
          prompt: 'Synthetic complete message',
          trigger: { kind: 'once' as const, at: '2026-01-01T00:00:00Z' },
          destination: { kind: 'existing_session' as const, sessionId },
          message: { inputBlocks: [{ type: 'text' as const, text: 'Synthetic complete message' }] },
        },
      };
      const original = await schedule().save(withMessage);
      const beforeInvalid = (await client.readDoc(namespace, scheduleRoom)).roomTxId;
      await expect(
        schedule().save({
          ...withMessage,
          create: false,
          activityId: 'invalid-message',
          draft: { ...withMessage.draft, prompt: 'Mismatch' },
        })
      ).rejects.toThrow('does not match');
      expect((await client.readDoc(namespace, scheduleRoom)).roomTxId).toBe(beforeInvalid);
      await client.applyDocPatch(
        namespace,
        scheduleRoom,
        [
          {
            op: 'set_value',
            path: ['definition', 'agent'],
            value: { ...original.definition.agent, futureInteger: 9007199254740993n },
          },
          {
            op: 'set_value',
            path: ['definition', 'retryPolicy'],
            value: { ...original.definition.retryPolicy, futureBytes: Uint8Array.of(3, 4) },
          },
          { op: 'set', path: ['futureRoot'], value: { retained: true } },
          {
            op: 'arr_splice',
            path: ['timeline'],
            at: 1,
            del: 0,
            items: [{ ...original.timeline[0], futureTimeline: { retained: true } }],
          },
        ] as never,
        { docSchema: LODY_SCHEDULE_DOC_SCHEMA }
      );
      const definition = createNativeScheduleDefinition({
        ...options(),
        compatibility: sdkCompatibility,
        scheduleId: save().scheduleId,
        registry: registry(),
        flushDefinition: async () => {},
      });
      const edited = await definition.save({
        ...withMessage,
        create: false,
        activityId: 'opaque-edit',
        draft: { ...withMessage.draft, title: 'Known title changed' },
      });
      expect(edited.definition.title).toBe('Known title changed');
      const saved = (await client.readDoc(namespace, scheduleRoom)).value as unknown as {
        definition: { agent: { futureInteger: bigint }; retryPolicy: { futureBytes: Uint8Array } };
        futureRoot: unknown;
      };
      expect(saved.definition.agent.futureInteger).toBe(9007199254740993n);
      expect(saved.definition.retryPolicy.futureBytes).toEqual(Uint8Array.of(3, 4));
      expect(saved.futureRoot).toEqual({ retained: true });
      const timeline = (await client.readDoc(namespace, scheduleRoom, ['timeline']))
        .value as unknown[];
      expect(timeline).toHaveLength(3);
      expect(timeline[1]).toMatchObject({
        id: original.timeline[0]!.id,
        futureTimeline: { retained: true },
      });
      expect((await definition.read())?.timeline).toHaveLength(2);
      const preview = createNativePreviewComments({
        ...options(),
        compatibility: sdkCompatibility,
        sessionId,
      });
      await preview.mutatePreviewVisualComments(sessionId, {
        kind: 'create',
        comment: comment('inline'),
      });
      const literal = {
        ...comment('inline'),
        futureInteger: 9007199254740993n,
        futureBytes: Uint8Array.of(7, 8),
      };
      await client.applyDocPatch(
        namespace,
        pcRoom,
        [{ op: 'set_value', path: ['turns', 'turn', 'comments', 0], value: literal }] as never,
        { docSchema: LODY_PREVIEW_COMMENT_DOC_SCHEMA }
      );
      await preview.mutatePreviewVisualComments(sessionId, {
        kind: 'resolve',
        commentId: 'inline',
        resolvedAt: 9,
        resolvedBy: 'owner',
      });
      const read = (await client.readDoc(namespace, pcRoom, ['turns', 'turn', 'comments', 0]))
        .value;
      expect(read).toEqual({ ...literal, resolvedAt: 9, resolvedBy: 'owner', updatedAt: 9 });
    });
    it('creates leaf bodies only after complete absence and trusted Meta reservation, then recovers a lost commit ACK without reauthoring', async () => {
      if (!sdkCompatibility?.flockStateEntries) {
        expect(() =>
          requireNativeFlockEntries(client, {
            compatibility: sdkCompatibility,
            sdkArtifactId: undefined,
          })
        ).toThrow();
        return;
      }
      const { documentDomainMigrationScope } =
        await import('@lody/shared/renderer-document-domain-migration');
      const { reserveNativeDocumentDomainMetadata } =
        await import('../../../../../packages/shared/src/node/native-document-domain-meta-reservation');
      const { readNativeDocumentDomainRoute } =
        await import('@lody/shared/node/native-document-domains');
      await client.createRoom(namespace, META_ROOM, 'plaintext');
      const binding = { accountId: 'local:leaf-fixture', workspaceId: namespace };
      const metadata = createNativeWorkspaceMeta({
        binding,
        generation: 'leaf-meta-owner',
        client,
        sdkCompatibility,
        sdkArtifactId: (await engine.leaseInfo(client)).sdkArtifactId,
        assertCurrent() {},
      });
      const journalPath = join(fixtureRoot, 'new-leaf-routes.sqlite3');
      const kernel = new NativeLoroDocumentMigration(journalPath, { client, assertAccess() {} });
      journals.push(kernel);
      const scope = documentDomainMigrationScope({ domain: 'preview_comments', id: 'new-leaf' });
      await metadata.externalMetadata.commit({
        kind: 'upsert-doc',
        docId: 'session-new-leaf',
        patch: { id: scope.id, userId: binding.accountId, machineId: 'machine' },
      });
      let absent = true;
      const witness = () => ({
        sources: [
          { sourceId: 'renderer:one', present: !absent },
          { sourceId: 'renderer:absent', present: false },
          { sourceId: 'cli:sqlite', present: false },
        ],
        assertCurrent() {},
      });
      const intent = {
        scope,
        actorId: binding.accountId,
        machineId: 'machine',
        createdAt: '2026-11-18T00:00:00.000Z',
        initial: { meta: { sessionId: scope.id }, turns: {} },
      };
      const reservationId = randomUUID();
      const reservation = reserveNativeDocumentDomainMetadata({
        owner: metadata,
        intent,
        reservationId,
        assertCurrent() {},
        absenceWitness: witness,
        authorize(snapshot) {
          if (!snapshot.docs.some((row) => row.docId === 'session-new-leaf' && !row.deleted))
            throw new Error('Parent Session required');
        },
      });
      const manifest = {
        migrationId: reservationId,
        binding: JSON.stringify([binding.accountId, binding.workspaceId]),
        namespace,
        roomId: scope.roomId,
        family: scope.domain,
        targetGeneration: 'leaf-schema-v1',
        creationIntentSha256: reservation.creationIntentSha256,
      };
      const ports = {
        initial: intent.initial,
        drainLegacy: async () => witness(),
        reserveMetadata: reservation.reserveMetadata,
        assertReservation: reservation.assertReservation,
      };
      try {
        absent = false;
        await expect(kernel.createLeaf(manifest, ports)).rejects.toThrow('complete legacy absence');
        expect((await metadata.readDocumentCreationState(scope.roomId)).pristine).toBe(true);
        absent = true;
        const original = client.applyDocPatch.bind(client);
        let committedHead = 0;
        const lost = vi.spyOn(client, 'applyDocPatch').mockImplementationOnce(async (...args) => {
          const ack = await original(...args);
          committedHead = ack.roomTxId;
          throw new Error('Synthetic committed leaf ACK lost');
        });
        await expect(kernel.createLeaf(manifest, ports)).rejects.toThrow('ACK lost');
        lost.mockRestore();
        expect(kernel.route(manifest.binding, scope.roomId)).toBe('frozen');
        expect(committedHead).toBeGreaterThan(0);
        await kernel.createLeaf(manifest, ports);
        expect(
          (await client.readDoc(namespace, { kind: 'loro_doc', id: scope.roomId }, [])).roomTxId
        ).toBe(committedHead);
        expect(
          readNativeDocumentDomainRoute(
            {
              accountId: binding.accountId,
              workspaceId: namespace as WorkspaceId,
              journalPath,
              dataDir: directory,
            },
            scope.domain,
            scope.id
          )
        ).toBe('native');
        expect(kernel.archivedSources({ ...manifest, sourceIds: [], origin: 'created' })).toEqual(
          witness()
            .sources.map((source) => ({
              sourceId: source.sourceId,
              present: false,
              bytes: new Uint8Array(),
            }))
            .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
        );
        const wrong = reserveNativeDocumentDomainMetadata({
          owner: metadata,
          intent: { ...intent, createdAt: '2026-11-19T00:00:00.000Z' },
          reservationId: randomUUID(),
          assertCurrent() {},
          absenceWitness: witness,
          authorize() {},
        });
        await expect(wrong.reserveMetadata()).rejects.toThrow('pristine absence');
      } finally {
        await metadata.close();
      }
    });
    it('runs the actual leaf migration driver across two renderer windows, readonly SQLite and the same independent native owner', async () => {
      if (!sdkCompatibility?.flockStateEntries) {
        expect(() =>
          requireNativeFlockEntries(client, {
            compatibility: sdkCompatibility,
            sdkArtifactId: undefined,
          })
        ).toThrow();
        return;
      }
      const { createRequire } = await import('node:module');
      const require = createRequire(
        join(import.meta.dirname, '../../../../../packages/components/package.json')
      );
      const { IDBFactory } = require('fake-indexeddb') as {
        IDBFactory: new () => globalThis.IDBFactory;
      };
      const { IndexedDBStorageAdaptor } = await import('loro-repo/storage/indexeddb');
      const { createCliSqliteRepoStore } = await import('./sqlite-repo-store');
      const { createRepoWithNativeWorkspaceMetaLegacy } =
        await import('./native-workspace-meta-owner');
      const { assertMainNativeDocumentDomainMigrationAuthority } =
        await import('../../../../../apps/electron/src/main/services/native-document-domain-migration-authority');
      const { RendererDocumentDomainFreeze } =
        await import('../../../../../packages/components/src/providers/renderer-document-domain-migration');
      const { RendererDocumentDomainMigrationMainLegacy } =
        await import('../../../../../apps/electron/src/main/services/renderer-document-domain-migration');
      const { NativeDocumentDomainMigrationLegacy } =
        await import('../../../../../apps/electron/src/main/services/native-document-domain-migration');
      const { NativeDocumentDomainDrainLegacy } = await import('./native-document-domain-drain');
      const { readFrozenLegacyLoroDocumentSqlite } =
        await import('@lody/shared/node/legacy-loro-document-source');
      const { readNativeDocumentDomainRoute } =
        await import('@lody/shared/node/native-document-domains');
      const { resolveLocalIndependentRepo } =
        await import('@lody/shared/node/native-repo-independent-paths');
      const { documentDomainMigrationScope } =
        await import('@lody/shared/renderer-document-domain-migration');
      const priorE2E = process.env.LODY_E2E;
      process.env.LODY_E2E = '1';
      const dataRoot = join(fixtureRoot, 'driver-profile'),
        accountId = 'local:driver-fixture',
        workspace = 'lw_leaf_driver' as WorkspaceId;
      const binding = { accountId, workspaceId: workspace, contentMode: 'plaintext' as const };
      const selected = resolveLocalIndependentRepo({ platform: 'local', dataRoot, ...binding });
      const launch = {
        executable: process.execPath,
        entry: join(compiledDirectory, 'native-repo-independent-host.js'),
      };
      const host = new IndependentNativeRepoHostLegacy({
        ...launch,
        dataDir: selected.dataDir,
        binding: selected.binding,
        requiredSdkArtifactId: sdkCompatibility.artifactId,
      });
      extraHosts.push(host);
      const native = await host.client(),
        info = await host.leaseInfo(native);
      await native.createRoom(workspace, META_ROOM, 'plaintext');
      const metadata = createNativeWorkspaceMeta({
        binding: { accountId, workspaceId: workspace },
        generation: 'actual-leaf-meta',
        client: native,
        sdkCompatibility,
        sdkArtifactId: info.sdkArtifactId,
        assertCurrent() {},
      });
      const dbPath = join(dataRoot, 'loro-repo', workspace, 'repo.sqlite3');
      await mkdir(join(dataRoot, 'loro-repo', workspace), { recursive: true });
      const sqlite = await createCliSqliteRepoStore(
        workspace,
        undefined,
        join(dataRoot, 'loro-repo', workspace)
      );
      const repo = await createRepoWithNativeWorkspaceMetaLegacy(
        { storageAdapter: sqlite.storageAdapter },
        { externalMetadata: metadata.externalMetadata }
      );
      const directoryReader = createNativeWorkspaceDirectory({
        namespace: workspace,
        getClient: async () => native,
        sdkCompatibility,
        getClientArtifactId: async () => info.sdkArtifactId,
        assertAccess() {
          metadata.assertCurrent();
        },
        authority: {
          get: () => ({
            synced: native.connectionState === 'connected',
            generation: metadata.generation,
          }),
          subscribe: (listener) => native.onConnectionStateChange(() => listener()),
        },
      });
      await directoryReader.listEntries();
      const priorDataRoot = process.env.LODY_DATA_DIR;
      process.env.LODY_DATA_DIR = dataRoot;
      const manager = new LoroDocumentManager({
        repo,
        workspaceId: workspace,
        userId: accountId,
        metaSub: null,
        sqliteRepoStore: sqlite,
        logger: getLogger('leaf-driver-manager'),
        workspaceDirectory: directoryReader,
        nativeWorkspaceMetaOwner: {
          metadata,
          directory: directoryReader,
          externalMetadata: metadata.externalMetadata,
          close: async () => {},
        } as never,
      });
      await manager.registerMachine('machine' as never, { name: 'Synthetic machine' });
      const scope = documentDomainMigrationScope({ domain: 'preview_comments', id: 'old-preview' }),
        old = await repo.openPersistedDoc(scope.roomId);
      old.doc.getMap('meta').set('sessionId', scope.id);
      old.doc.getMap('future').set('opaque', { preserved: true });
      old.doc.commit();
      await repo.persistDocNow(scope.roomId, old.doc);
      await repo.flush();
      await native.createRoom(workspace, META_ROOM, 'plaintext');
      for (const id of ['old-preview', 'new-preview'])
        await metadata.externalMetadata.commit({
          kind: 'upsert-doc',
          docId: `session-${id}`,
          patch: { id, userId: accountId, machineId: 'machine', historyBackend: 'roost' },
        });
      await metadata.externalMetadata.commit({
        kind: 'upsert-doc',
        docId: scope.roomId,
        patch: { id: scope.id, userId: accountId, machineId: 'machine' },
      });
      const idb = new IDBFactory(),
        storages: InstanceType<typeof IndexedDBStorageAdaptor>[] = [],
        rendererRepos: LoroRepo[] = [];
      let failGlobalMetadataFlush = false;
      const rendererExternalMetadata = {
        ...metadata.externalMetadata,
        async flush() {
          if (failGlobalMetadataFlush)
            throw new Error('Synthetic unrelated global Meta flush failure');
          return metadata.externalMetadata.flush();
        },
      };
      const { drainLegacyDocumentDomainStore, notifyDocumentDomainEpoch } =
        await import('../../../../../packages/components/src/providers/document-domain-store-lifecycle');
      const rendererDocuments = new Map<number, Map<string, LoroDoc>>();
      const flushControl = await createRepoWithNativeWorkspaceMetaLegacy(
        {},
        { externalMetadata: rendererExternalMetadata }
      );
      let flushControlFailed = false;
      const originalIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
      for (const suffix of ['', ':other-window']) {
        Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: idb });
        const storage = new IndexedDBStorageAdaptor({
          dbName: `lody-loro-repo-db-${workspace}${suffix}`,
        });
        storages.push(storage);
        if (originalIdb) Object.defineProperty(globalThis, 'indexedDB', originalIdb);
        else Reflect.deleteProperty(globalThis, 'indexedDB');
        rendererRepos.push(
          await createRepoWithNativeWorkspaceMetaLegacy(
            { storageAdapter: storage },
            { externalMetadata: rendererExternalMetadata }
          )
        );
      }
      const rendererDoc = await rendererRepos[0]!.openPersistedDoc(scope.roomId);
      rendererDoc.doc.import(old.doc.export({ mode: 'snapshot' }));
      rendererDoc.doc.getText('futureText').insert(0, 'renderer-only');
      rendererDoc.doc.commit();
      rendererDocuments.set(1, new Map([[scope.roomId, rendererDoc.doc]]));
      await rendererRepos[0]!.persistDocNow(scope.roomId, rendererDoc.doc);
      const journalPath = join(selected.directory, 'document-routes.sqlite3');
      const route = (target: typeof scope) =>
        readNativeDocumentDomainRoute(
          { accountId, workspaceId: workspace, journalPath, dataDir: selected.dataDir },
          target.domain,
          target.id
        );
      const source = (target: typeof scope) =>
        readFrozenLegacyLoroDocumentSqlite({
          path: dbPath,
          roomId: target.roomId,
          sourceId: `cli-sqlite:loro-doc-layout1:${workspace}:${target.roomId}`,
        });
      const registrations = new Map([
          [1, randomUUID()],
          [2, randomUUID()],
        ]),
        gates = new Map<number, InstanceType<typeof RendererDocumentDomainFreeze>>();
      let windows!: InstanceType<typeof RendererDocumentDomainMigrationMainLegacy>;
      const epochs = new Map(
        [...registrations.keys()].map((window) => [window, new Map<string, number>()])
      );
      const epochEvents: string[] = [];
      const notify = (window: number, target: typeof scope) =>
        notifyDocumentDomainEpoch(
          target,
          epochs.get(window)!,
          new Map([
            [
              scope.roomId,
              new Set([
                () => epochEvents.push(`${window}:${epochs.get(window)!.get(scope.roomId)}`),
              ]),
            ],
          ])
        );
      for (const window of registrations.keys())
        gates.set(
          window,
          new RendererDocumentDomainFreeze({
            indexedDB: idb,
            beginFreeze: (target) => notify(window, target),
            published: (target) => notify(window, target),
            async drainLegacy(target) {
              const legacy = rendererRepos[window - 1]!;
              await drainLegacyDocumentDomainStore(
                undefined,
                rendererDocuments.get(window)?.get(target.roomId),
                {
                  detach: async () => {},
                  persist: (doc) => legacy.persistDocNow(target.roomId, doc),
                  unload: () => legacy.unloadDoc(target.roomId),
                  async releaseMaterializedLegacy() {
                    throw new Error(
                      'No materialized legacy store may release a pending native cache'
                    );
                  },
                  forgetLegacy() {
                    rendererDocuments.get(window)?.delete(target.roomId);
                  },
                }
              );
            },
          })
        );
      windows = new RendererDocumentDomainMigrationMainLegacy({
        binding,
        metadataGeneration: metadata.generation,
        databasePath: join(selected.directory, 'leaf-window-fences.sqlite3'),
        creationEnabled: true,
        admit(window, reg) {
          if (registrations.get(window) !== reg) throw new Error('Wrong window');
        },
        registeredWindowIds: () => [...registrations.keys()],
        send(window, message) {
          void gates
            .get(window)!
            .handle(message)
            .then(
              (ack) => windows.acknowledge(window, ack),
              () =>
                windows.acknowledge(window, {
                  ...message,
                  failure: message.phase === 'capture' ? 'capture_failed' : 'drain_failed',
                })
            );
        },
        readCommittedOwner: route,
        assertMetadataCurrent() {
          metadata.assertCurrent();
        },
        authorize: (target) =>
          assertMainNativeDocumentDomainMigrationAuthority({
            metadata,
            scope: target,
            actorId: accountId,
            machineId: 'machine',
            creationEnabled: true,
          }),
      });
      for (const [window, reg] of registrations) {
        gates.get(window)!.bind(windows.register(window, reg));
        windows.ready(window, reg);
      }
      await native.createRoom(
        workspace,
        { kind: 'flock', id: getScheduleRegistryFlockDocId(workspace) },
        'plaintext'
      );
      const nativeRegistry = createNativeScheduleRegistry({
        workspaceId: workspace,
        namespace: workspace,
        writer: 'driver-registry',
        getClient: async () => native,
        assertAccess() {
          metadata.assertCurrent();
        },
        flush: async () => {},
      });
      const { createScheduleDefinitionRegistryAdapter } =
        await import('@lody/shared/node/native-schedule-definition');
      const definitionRegistry = createScheduleDefinitionRegistryAdapter(nativeRegistry, () =>
        metadata.assertCurrent()
      );
      const driver = new NativeDocumentDomainMigrationLegacy({
        binding,
        dataRoot,
        compatibility: sdkCompatibility,
        launch,
        renderer: windows,
        getClient: async () => ({
          client: native,
          generation: `${info.engineRunId}:${info.clientGeneration}`,
          sdkArtifactId: info.sdkArtifactId!,
        }),
        control: (request) => manager.handleNativeDocumentDomainMigrationControl(request),
        async authorize(target) {
          const own = await metadata.document(target.metadataDocId).read();
          if (!own) throw new Error('Meta required');
        },
        assertCurrent() {
          metadata.assertCurrent();
        },
        creation: {
          metadata,
          actorId: accountId,
          machineId: 'machine',
          registry: definitionRegistry,
          authorize(target, snapshot) {
            if (
              target.parentMetadataDocId &&
              !snapshot.docs.some(
                (row) =>
                  row.docId === target.parentMetadataDocId &&
                  !row.deleted &&
                  row.meta.userId === accountId &&
                  row.meta.machineId === 'machine'
              )
            )
              throw new Error('Parent required');
          },
        },
      });
      try {
        failGlobalMetadataFlush = true;
        await expect(flushControl.flush()).rejects.toThrow('unrelated global Meta flush failure');
        flushControlFailed = true;
        await driver.migrate({ domain: scope.domain, id: scope.id });
        expect(route(scope)).toBe('native');
        expect([...epochs.values()].map((window) => window.get(scope.roomId))).toEqual([2, 2]);
        expect(epochEvents).toEqual(['1:1', '2:1', '1:2', '2:2']);
        const merged = (await native.readDoc(workspace, { kind: 'loro_doc', id: scope.roomId }, []))
          .value;
        expect(merged).toMatchObject({
          meta: { sessionId: scope.id },
          future: { opaque: { preserved: true } },
          futureText: 'renderer-only',
        });
        expect(source(scope).snapshot).toEqual(
          readFrozenLegacyLoroDocumentSqlite({
            path: dbPath,
            roomId: scope.roomId,
            sourceId: source(scope).sourceId,
          }).snapshot
        );
        const fresh = documentDomainMigrationScope({
          domain: 'preview_comments',
          id: 'new-preview',
        });
        await driver.ensurePreview(fresh.id as SessionId);
        expect(route(fresh)).toBe('native');
        expect(source(fresh).present).toBe(false);
        const head = (await native.readDoc(workspace, { kind: 'loro_doc', id: fresh.roomId }, []))
          .roomTxId;
        await driver.ensurePreview(fresh.id as SessionId);
        expect(
          (await native.readDoc(workspace, { kind: 'loro_doc', id: fresh.roomId }, [])).roomTxId
        ).toBe(head);
        expect(gates.get(1)!.owner(scope.roomId)).toBe('native');
        expect(gates.get(2)!.owner(fresh.roomId)).toBe('native');
        expect(gates.get(1)!.shouldRoute('session-new-preview')).toBe(true);
        const scheduleScope = documentDomainMigrationScope({
          domain: 'schedule_definition',
          id: 'new-schedule',
        });
        const scheduleInput = {
          scheduleId: scheduleScope.id,
          draft: {
            ...save().draft,
            trigger: { kind: 'once' as const, at: '2026-11-19T00:00:00.000Z' },
            destination: { kind: 'existing_session' as const, sessionId: 'new-preview' },
            misfirePolicy: { kind: 'run_once' as const },
            message: { inputBlocks: [{ type: 'text' as const, text: 'Synthetic prompt' }] },
          },
          now: 1,
          activityId: 'created',
          activationId: 'activation',
        };
        await driver.createSchedule(scheduleInput);
        expect(route(scheduleScope)).toBe('native');
        expect([...epochs.values()].map((window) => window.get(scheduleScope.roomId))).toEqual([
          2, 2,
        ]);
        expect(source(scheduleScope).present).toBe(false);
        expect((await nativeRegistry.read()).schedules).toMatchObject([
          { scheduleId: scheduleScope.id, ownerId: accountId, machineId: 'machine' },
        ]);
        const savedDefinition = await native.readDoc(
          workspace,
          { kind: 'loro_doc', id: scheduleScope.roomId },
          []
        );
        expect(savedDefinition.value).toMatchObject({
          definition: { scheduleId: scheduleScope.id, ownerId: accountId, machineId: 'machine' },
          prompt: 'Synthetic prompt',
        });
        await driver.createSchedule(scheduleInput);
        expect(
          (await native.readDoc(workspace, { kind: 'loro_doc', id: scheduleScope.roomId }, []))
            .roomTxId
        ).toBe(savedDefinition.roomTxId);
      } finally {
        failGlobalMetadataFlush = false;
        if (flushControlFailed) {
          await expect(flushControl.destroy()).rejects.toThrow(
            'unrelated global Meta flush failure'
          );
          expect(flushControl.destroyed).toBe(true);
        } else await flushControl.destroy();
        await driver.close();
        await windows.close();
        await manager.cleanUp({ preserveSessionStatus: true });
        if (priorDataRoot === undefined) delete process.env.LODY_DATA_DIR;
        else process.env.LODY_DATA_DIR = priorDataRoot;
        await directoryReader.close();
        for (const legacy of rendererRepos) await legacy.destroy();
        for (const storage of storages) await storage.close();
        await repo.destroy();

        await nativeRegistry.close();
        await metadata.close();
        await host.close();
        if (priorE2E === undefined) delete process.env.LODY_E2E;
        else process.env.LODY_E2E = priorE2E;
      }
    });
    it('retires a terminal native scheduled message durably and reconciles lost deletion ACK without opening or deleting the legacy body', async () => {
      if (!sdkCompatibility?.setValue) {
        expect(sdkCompatibility).toBeUndefined();
        return;
      }
      const selectedWorkspace = namespace as WorkspaceId,
        accountId = 'owner';
      await client.createRoom(
        namespace,
        { kind: 'flock', id: getScheduleRegistryFlockDocId(selectedWorkspace) },
        'plaintext'
      );
      const wholeRegistry = createNativeScheduleRegistry({
        ...options(),
        workspaceId: selectedWorkspace,
        getClient: async () => client,
        flush: async () => {},
      });
      const { createScheduleDefinitionRegistryAdapter } =
        await import('@lody/shared/node/native-schedule-definition');
      const adapter = createScheduleDefinitionRegistryAdapter(wholeRegistry, () => {});
      const input = {
        ...save(),
        draft: {
          ...save().draft,
          trigger: { kind: 'once' as const, at: '2026-01-01T00:00:00Z' },
          destination: { kind: 'existing_session' as const, sessionId },
          message: { inputBlocks: [{ type: 'text' as const, text: 'Synthetic prompt' }] },
        },
      };
      const definition = createNativeScheduleDefinition({
        ...options(),
        scheduleId: input.scheduleId,
        registry: adapter,
        flushDefinition: async () => {},
      });
      const saved = await definition.save(input),
        row = buildScheduleRegistryRow(saved);
      const binary = (await client.exportLoroRaw(namespace, scheduleRoom)).bytes.slice();
      const journalPath = join(fixtureRoot, 'retention-routes.sqlite3'),
        binding = JSON.stringify([accountId, selectedWorkspace]);
      const kernel = new NativeLoroDocumentMigration(journalPath, { client, assertAccess() {} });
      journals.push(kernel);
      await kernel.migrate(
        {
          migrationId: 'retention-existing',
          binding,
          namespace,
          roomId: scheduleRoom.id,
          family: 'schedule_definition',
          targetGeneration: 'retention-schema-v1',
          sourceIds: ['legacy-source'],
        },
        { drainLegacy: async () => [{ sourceId: 'legacy-source', bytes: binary }] }
      );
      const makeOwner = () =>
        createNativeDocumentDomains({
          accountId,
          workspaceId: selectedWorkspace,
          journalPath,
          dataDir: directory,
          compatibility: sdkCompatibility,
          writer: 'retention:synthetic',
          registry: adapter,
          assertCurrent() {},
          async authorize() {},
          getClient: async () => ({
            client,
            generation: 'retention-generation',
            sdkArtifactId: sdkCompatibility.artifactId,
          }),
          flushDefinition: async () => {},
        });
      let owner = makeOwner();
      const forbidden = async () => {
        throw new Error('Retired legacy body must remain untouched');
      };
      const repository = () =>
        new ScheduleRepository(
          {
            openPersistedDoc: forbidden,
            openFlockDoc: forbidden,
            purgeDoc: forbidden,
            flush: async () => {},
          },
          selectedWorkspace,
          { registry: wholeRegistry, definitions: owner.definitions }
        );
      const runtime = {
        scheduleId: row.scheduleId,
        machineId: row.machineId,
        activationId: row.activationId,
        observedDefinitionFingerprint: row.definitionFingerprint,
        updatedAt: 10,
        messageState: 'pending' as const,
      };
      try {
        await wholeRegistry.execute({ kind: 'put-runtime', runtime });
        const head = (await client.readDoc(namespace, scheduleRoom)).roomTxId;
        expect(
          await repository().pruneExpiredMessages({
            now: 100,
            ownerId: 'owner',
            machineId: 'machine',
            retentionMs: 20,
          })
        ).toEqual([]);
        expect((await client.readDoc(namespace, scheduleRoom)).roomTxId).toBe(head);
        await wholeRegistry.execute({
          kind: 'put-runtime',
          runtime: { ...runtime, messageState: 'sent', updatedAt: 20 },
        });
        const original = client.deleteRoom.bind(client);
        const lost = vi.spyOn(client, 'deleteRoom').mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new Error('Synthetic durable delete ACK lost');
        });
        expect(
          await repository().pruneExpiredMessages({
            now: 100,
            ownerId: 'owner',
            machineId: 'machine',
            retentionMs: 20,
          })
        ).toEqual([]);
        lost.mockRestore();
        expect((await wholeRegistry.read()).tombstones).toMatchObject([
          { scheduleId: row.scheduleId, actorId: 'owner' },
        ]);
        expect(
          (await wholeRegistry.exportRows()).some(
            (entry) => entry.key[0] === 'schedule' && entry.key[1] === row.scheduleId
          )
        ).toBe(true);
        await expect(client.readDoc(namespace, scheduleRoom)).rejects.toMatchObject({
          code: 'room_not_found',
        });
        // A late writer may report a later terminal runtime after the execution
        // fence. The original durable retention reservation still owns cleanup.
        await wholeRegistry.execute({
          kind: 'put-runtime',
          runtime: { ...runtime, messageState: 'sent', updatedAt: 30 },
        });
        await owner.close();
        owner = makeOwner();
        const noReplay = vi
          .spyOn(client, 'deleteRoom')
          .mockRejectedValue(new Error('Unknown deletion cannot replay'));
        expect(
          await repository().pruneExpiredMessages({
            now: 200,
            ownerId: 'owner',
            machineId: 'machine',
            retentionMs: 20,
          })
        ).toEqual([]);
        noReplay.mockRestore();
        expect(
          (await wholeRegistry.exportRows())
            .filter((entry) => entry.key[1] === row.scheduleId)
            .map((entry) => entry.key[0])
        ).toEqual(['tombstone']);
        expect(await (await owner.definitions.resolve(row.scheduleId))!.read()).toBeNull();
        await expect(
          (await owner.definitions.resolve(row.scheduleId))!.save(input)
        ).rejects.toThrow('permanently retired');
        expect(
          kernel.archivedSources({
            migrationId: 'retention-existing',
            binding,
            namespace,
            roomId: scheduleRoom.id,
            family: 'schedule_definition',
            targetGeneration: 'retention-schema-v1',
            sourceIds: ['legacy-source'],
          })![0]!.bytes
        ).toEqual(binary);
        expect(kernel.route(binding, scheduleRoom.id)).toBe('native');
      } finally {
        await owner.close();
        await wholeRegistry.close();
      }
    });
  }
);
