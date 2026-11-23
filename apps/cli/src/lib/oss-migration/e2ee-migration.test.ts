import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { Effect, Result } from 'effect';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm';
import { StreamsCrdt, type CrdtAdapter, type JsonObject } from '@loro-dev/streams-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import {
  encodeStreamsRoomAdditionalData,
  type StreamsRoomIdentity,
} from 'loro-repo/transport/streams';
import { createSessionMirror } from '@lody/shared/session-mirror';
import {
  attachmentSha256,
  readEncryptedAttachment,
  createLoroStreamUrl,
  EncryptedAttachmentSchema,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { CloudE2eePort, LoroStreamsTokenProviderLegacy } from '@lody/platform';
import {
  Bytes,
  extendLedger,
  hashRecordBytes,
  prepareLedgerCommand,
  signLedgerRecord,
} from '@lody/e2ee-core/protocol';
import {
  cliE2eeIdentityDirectory,
  openCliE2eeWorkspaceLegacy,
  retainCliE2eeWorkspaceBinding,
} from '../e2ee/workspace-legacy';
import { execute, hex, noKeyring, page, setup } from '../../../tests/e2ee-runtime-helpers';
import { manifestSchema, hashBytes } from './model';
import { loadJournal, sourceDocumentPath } from './source';
import { migrateSnapshot, MigrationRuntime } from './engine';
import { openMigrationTarget } from './target';
import {
  collectAttachmentFiles,
  resolveArchivedAttachment,
  migrateAttachments,
} from './attachments';
import { SessionAttachmentTransfer } from '../session-attachment-transfer';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'e2ee-oss-migrate-'));
  directories.push(directory);
  return directory;
}

const tokens: LoroStreamsTokenProviderLegacy = {
  getToken: async () => 'device-token',
  getGatewayBaseUrl: () => 'https://streams.invalid',
  getShardHostSuffix: () => undefined,
  invalidate: () => {},
  createAuthCallback: () => async () => 'device-token',
  close: async () => {},
  retryCleanup: async () => {},
};

function encryptedServer() {
  const rooms = new Map<string, Uint8Array[]>();
  const uploads = new Map<string, Uint8Array>();
  const writes: { bucket: string; id: string; body: Uint8Array }[] = [];
  let loseResponse = false;
  let casConflict = false;
  let casConflicts = 0;
  const offset = (id: string) => String(rooms.get(id)?.length ?? 0).padStart(20, '0');
  const headers = (id: string) => ({
    'Content-Type': 'application/octet-stream',
    'Stream-Next-Offset': offset(id),
    'Stream-Up-To-Date': 'true',
    'Stream-Extensions': 'append-cas',
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === 'attachments.invalid') {
      expect(url.pathname).toContain('/session-encrypted-files/');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer attachment-token');
      const blob = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const fileId = `blob-${uploads.size}`;
      uploads.set(fileId, blob);
      return Response.json({
        file: {
          type: 'file',
          fileId,
          fileName: 'attachment.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: blob.length,
          sha256: attachmentSha256(blob),
          uploadedAt: 1,
          textPreview: false,
          transport: 'r2',
        },
      });
    }
    const parts = url.pathname.split('/');
    const bucket = parts[2] ?? '';
    const id = decodeURIComponent(parts[3] ?? '');
    expect(bucket).toBe('encrypted-content');
    if (!id) return Response.json({ extensions: ['append-cas'] });
    const append = async () => {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      for (let at = 0; at < body.length;) {
        const length = view.getUint32(at, false);
        at += 4;
        expect([...body.slice(at, at + 6)]).toEqual([76, 83, 67, 69, 2, 1]);
        at += length;
      }
      writes.push({ bucket, id, body });
      rooms.get(id)?.push(body);
    };
    if (init?.method === 'PUT') {
      const exists = rooms.has(id);
      if (!exists) {
        rooms.set(id, []);
        await append();
      }
      return new Response(null, { status: exists ? 200 : 201, headers: headers(id) });
    }
    if (!rooms.has(id)) return new Response(null, { status: 404 });
    if (init?.method === 'POST') {
      if (url.pathname.endsWith('/append-cas')) {
        if (casConflict) {
          casConflict = false;
          casConflicts++;
          return new Response(null, { status: 412, headers: headers(id) });
        }
        if (new Headers(init.headers).get('Stream-Expected-Offset') !== offset(id))
          return new Response(null, { status: 412, headers: headers(id) });
      }
      await append();
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost after append');
      }
      return new Response(null, {
        headers: { ...headers(id), 'Producer-Epoch': '0', 'Producer-Seq': '0' },
      });
    }
    if (url.pathname.endsWith('/bootstrap')) {
      const pieces: BlobPart[] = ['--test\r\nContent-Type: application/octet-stream\r\n\r\n'];
      for (const body of rooms.get(id) ?? [])
        pieces.push(
          '\r\n--test\r\nContent-Type: application/octet-stream\r\n\r\n',
          body.slice().buffer
        );
      pieces.push('\r\n--test--\r\n');
      return new Response(new Blob(pieces), {
        headers: {
          ...headers(id),
          'Content-Type': 'multipart/mixed; boundary=test',
          'Stream-Snapshot-Offset': '-1',
        },
      });
    }
    return new Response(null, { headers: headers(id) });
  });
  return {
    rooms,
    uploads,
    writes,
    loseAppendResponse: () => {
      loseResponse = true;
    },
    conflict: () => {
      casConflict = true;
    },
    conflicts: () => casConflicts,
  };
}

async function pairedMachine(
  kind:
    | 'active'
    | 'unpaired'
    | 'revoked'
    | 'guest'
    | 'removed'
    | 'missing-key'
    | 'foreign-account' = 'active'
) {
  const directory = await temporary();
  vi.stubEnv('LODY_DATA_DIR', path.join(directory, 'profile'));
  const guest = kind === 'guest' || kind === 'removed';
  const accountId = guest ? 'reader' : kind === 'foreign-account' ? 'foreign' : 'acct';
  const root = cliE2eeIdentityDirectory(accountId, 'cloud');
  const fixture = await execute(
    Effect.gen(function* () {
      const fixture = yield* setup(
        directory,
        guest ? 3 : 2,
        path.join(root, 'custody'),
        false,
        false,
        guest,
        true
      );
      const signingKey = guest
        ? hex(required(fixture.guestMachine).device.publicKey.toBytes())
        : [...fixture.current.inspectState().devices].find(
            ([, device]) => device.kind === 'machine'
          )?.[0];
      if (!signingKey) throw new Error('missing fixture device');
      if (kind === 'revoked' || kind === 'removed') {
        let view = fixture.current;
        if (kind === 'removed') {
          const declared = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(view, fixture.owner.publicKey, {
                _tag: 'DeclareCapabilities',
                capabilities: [1],
              })
            ),
            fixture.owner
          );
          fixture.records.push(declared);
          view = Result.getOrThrow(
            extendLedger(view, [declared], {
              length: fixture.records.length,
              head: hashRecordBytes(declared),
            })
          );
        }
        const membershipId = view.inspectState().devices.get(signingKey)?.membershipId;
        const record = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerCommand(
              view,
              fixture.owner.publicKey,
              kind === 'revoked'
                ? {
                    _tag: 'RevokeDevice',
                    target: Result.getOrThrow(
                      Bytes.signingPublicKey(Buffer.from(signingKey, 'hex'))
                    ),
                  }
                : { _tag: 'RemoveMember', membershipId: required(membershipId) }
            )
          ),
          fixture.owner
        );
        fixture.records.push(record);
      }
      return fixture;
    })
  );
  if (guest) {
    await fs.rm(path.join(root, 'custody'), { recursive: true });
    await fs.cp(path.join(directory, 'guest-machine'), path.join(root, 'custody'), {
      recursive: true,
    });
  }
  const signingKey = guest
    ? hex(required(fixture.guestMachine).device.publicKey.toBytes())
    : [...fixture.current.inspectState().devices].find(
        ([, device]) => device.kind === 'machine'
      )?.[0];
  if (!signingKey) throw new Error('missing fixture device');
  await retainCliE2eeWorkspaceBinding(accountId, {
    workspaceId: 'cloud',
    genesisHash: hex(fixture.genesis.toBytes()),
    genesisRecordHex: hex(fixture.genesisRecord),
  });
  if (kind !== 'unpaired')
    await fs.writeFile(
      path.join(root, 'activation.json'),
      JSON.stringify({ genesisHash: hex(fixture.genesis.toBytes()), signingPublicKey: signingKey })
    );
  const cloud = {
    getContentToken: async () => {
      throw new Error('unexpected account token request');
    },
    getHistory: async () => ({
      ...page(fixture.records),
      workspaceId: 'cloud',
      genesisHash: hex(fixture.genesis.toBytes()),
      position: `p1:cloud:${fixture.records.length}:offset-${fixture.records.length}:0`,
    }),
    mailboxCall: async (method: string, args: { slot?: object }) => {
      if (method === 'status') return { ...args.slot, revision: 0, status: 'EnvelopeStored' };
      if (method === 'fetch')
        return {
          items:
            kind === 'missing-key'
              ? []
              : [{ sender: fixture.sender, frameHex: hex(fixture.frame) }],
          next: null,
        };
      return null;
    },
  } as CloudE2eePort;
  return {
    directory,
    genesisHash: hex(fixture.genesis.toBytes()),
    open: () =>
      openCliE2eeWorkspaceLegacy({
        accountId,
        workspaceId: 'cloud',
        machineId: guest ? 'guest-machine' : 'machine',
        genesisHash: hex(fixture.genesis.toBytes()),
        keyring: noKeyring,
        onUnavailable: () => {},
        cloud,
      }),
  };
}

async function readRoom(
  host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>>,
  id: string,
  room: StreamsRoomIdentity,
  adapter: CrdtAdapter<JsonObject>
) {
  if (host.content.mode !== 'protected') throw new Error('protected fixture required');
  const content = host.content;
  const selection = content.resolve(room);
  if (selection.mode !== 'protected') throw new Error('protected room required');
  const provider = selection.config.provider;
  const stream = new StreamsCrdt({
    streamUrl: createLoroStreamUrl({
      baseUrl: 'https://streams.invalid',
      bucketId: 'encrypted-content',
      streamId: id,
    }),
    adapter,
    auth: async () => 'device-token',
    e2ee: {
      provider: {
        maxSealOverheadBytes: provider.maxSealOverheadBytes,
        seal: (input) =>
          provider.seal({
            ...input,
            additionalData: (header) =>
              encodeStreamsRoomAdditionalData(
                content.namespace,
                room,
                input.additionalData(header)
              ),
          }),
        open: (input) =>
          provider.open({
            ...input,
            additionalData: encodeStreamsRoomAdditionalData(
              content.namespace,
              room,
              input.additionalData
            ),
          }),
      },
    },
  });
  try {
    const result = await stream.catchup({ force: true });
    expect(result.ok).toBe(true);
  } finally {
    await stream.close();
  }
}

it.each(['unpaired', 'revoked', 'guest', 'removed', 'missing-key', 'foreign-account'] as const)(
  'refuses %s machines before any content or attachment upload',
  async (kind) => {
    const paired = await pairedMachine(kind);
    const wire = encryptedServer();
    let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    try {
      await expect(
        (async () => {
          host = await paired.open();
          await openMigrationTarget(tokens, 'cloud' as WorkspaceId, host.content, {
            authorize: host.authorizeImport,
            bucketId: () => 'encrypted-content',
          });
        })()
      ).rejects.toThrow();
      expect(wire.writes).toEqual([]);
      expect(wire.uploads.size).toBe(0);
    } finally {
      await host?.close();
    }
  }
);

it('encrypts frozen OSS history, attachments and CAS indexes, fences execution and resumes lost responses', async () => {
  const paired = await pairedMachine();
  const wire = encryptedServer();
  const host = await paired.open();

  const doc = new LoroDoc();
  const mirror = createSessionMirror({ doc, initialState: {} });
  const blob = new TextEncoder().encode('private attachment contents');
  const file = {
    type: 'file' as const,
    fileId: 'local-file',
    fileName: 'private.txt',
    mimeType: 'text/plain',
    sizeBytes: blob.length,
    sha256: hashBytes(blob),
    transport: 'local' as const,
    machineId: 'local-machine',
    uploadedAt: 1,
    textPreview: true,
  };
  mirror.historyWriter.update(() => [
    { id: 'u1', role: 'user', timestamp: '2026-11-23T00:00:00Z', items: [file], fileDiff: [] },
  ]);
  mirror.dispose();
  doc.commit();
  const queued = doc.getMovableList('mq').pushContainer(new LoroMap());
  queued.set('userTurnId', 'queued-u3');
  doc.commit();
  const source = doc.export({ mode: 'snapshot' });
  const schedule = new LoroDoc();
  schedule.getMap('definition').set('enabled', true);
  schedule.getMap('definition').set('activationId', 'source-activation');
  schedule.commit();
  const scheduleBytes = schedule.export({ mode: 'snapshot' });
  const manifest = manifestSchema.parse({
    version: 2,
    sourcePath: '/synthetic/source',
    sourceWorkspaceId: 'lw_oss',
    sourceMachineId: 'local-machine',
    sourceUserId: 'local:owner',
    sourceName: 'OSS',
    targetWorkspaceId: 'cloud',
    targetContentMode: 'protected',
    targetGenesisHash: paired.genesisHash,
    targetMachineId: 'machine',
    targetUserId: 'acct',
    deployment: 'https://cloud.invalid',
    migrationId: 'e'.repeat(32),
    createdAt: '2026-11-23T00:00:00Z',
    machineMeta: {},
    documents: [
      {
        id: 'session-one',
        sha256: hashBytes(source),
        meta: { latestUserMsgId: 'u1', processingUserMsgId: 'queued-u2', historyBackend: 'loro' },
      },
      { id: 'schedule-one', sha256: hashBytes(scheduleBytes), meta: {} },
    ],
    flocks: [
      {
        id: 'cloud:mf:machine',
        rows: [{ key: ['localProject', 'project'], value: { rootPath: '/synthetic/project' } }],
      },
    ],
  });
  const directory = path.join(paired.directory, 'snapshot');
  await fs.mkdir(path.join(directory, 'blobs', 'one'), { recursive: true });
  await fs.writeFile(path.join(directory, 'blobs', 'one', 'local-file'), blob);
  await fs.writeFile(sourceDocumentPath(directory, 'session-one'), source);
  await fs.writeFile(sourceDocumentPath(directory, 'schedule-one'), scheduleBytes);
  const transfer = new SessionAttachmentTransfer(
    'unused-account-token',
    'https://attachments.invalid',
    {
      token: async () => {
        await host.authorizeImport();
        return 'attachment-token';
      },
    }
  );
  const run = async () => {
    const target = await openMigrationTarget(tokens, 'cloud' as WorkspaceId, host.content, {
      authorize: host.authorizeImport,
      bucketId: () => 'encrypted-content',
    });
    try {
      await Effect.runPromise(
        migrateSnapshot(
          manifest,
          await loadJournal(directory, manifest.migrationId),
          directory
        ).pipe(Effect.provideService(MigrationRuntime, { target, transfer, progress: () => {} }))
      );
    } finally {
      await target.close();
    }
  };
  try {
    await expect(
      migrateAttachments(
        doc,
        'one',
        directory,
        manifest,
        await loadJournal(directory, manifest.migrationId),
        new SessionAttachmentTransfer('unused', 'https://attachments.invalid')
      )
    ).rejects.toThrow('protected attachment transfer before upload');
    expect(wire.writes).toEqual([]);
    expect(wire.uploads.size).toBe(0);
    wire.loseAppendResponse();
    await expect(run()).rejects.toThrow();
    expect(wire.uploads.size).toBe(1);
    wire.conflict();
    await run();
    expect(wire.conflicts()).toBe(1);
    const beforeRetry = wire.writes.length;
    await run();
    expect(wire.writes.length).toBe(beforeRetry);
    expect(wire.uploads.size).toBe(1);
    const imported = new LoroDoc();
    await readRoom(
      host,
      'cloud:s:one',
      { kind: 'doc', docId: 'session-one' },
      createLoroDocAdapter(imported)
    );
    expect(source.length).toBeGreaterThan(0);
    expect(doc.oplogVersion().compare(imported.oplogVersion())).toBe(-1);
    const reference = collectAttachmentFiles(imported)[0];
    expect(imported.getMovableList('mq').length).toBe(0);
    expect(reference?.transport).toBe('r2');
    expect(reference?.encryption).toBeDefined();
    expect(resolveArchivedAttachment(imported, file, 'one')).toMatchObject({
      encryption: reference?.encryption,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of readEncryptedAttachment({
      workspaceId: 'cloud',
      sessionId: 'one',
      encryption: EncryptedAttachmentSchema.parse(reference?.encryption),
      fetchPart: async (id) => new Response(wire.uploads.get(id)?.slice().buffer),
    }))
      chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(blob));
    expect(
      [...wire.uploads.values()].every(
        (ciphertext) => !Buffer.from(ciphertext).includes(Buffer.from(blob))
      )
    ).toBe(true);
    const meta = new Flock();
    await readRoom(host, 'cloud:meta', { kind: 'meta' }, createFlockAdapter(meta));
    expect(meta.get(['m', 'session-one', 'collaborationStopped'])).toBe(true);
    expect(meta.get(['m', 'session-one', 'latestUserMsgId'])).toBeUndefined();
    expect(meta.get(['m', 'session-one', 'importFence'])).toMatchObject({
      workspaceId: 'cloud',
      turnIds: ['u1', 'queued-u3', 'queued-u2'],
      queueItemIds: [queued.id],
      importedBy: 'acct',
    });
    const disabled = new LoroDoc();
    const { getLoroStreamIdForDocId } = await import('@lody/shared');
    await readRoom(
      host,
      getLoroStreamIdForDocId('cloud' as WorkspaceId, 'schedule-one'),
      { kind: 'doc', docId: 'schedule-one' },
      createLoroDocAdapter(disabled)
    );
    expect(disabled.getMap('definition').get('enabled')).toBe(false);
    expect(meta.get(['m', 'schedule-one', 'importFence'])).toEqual({
      workspaceId: 'cloud',
      activationId: 'source-activation',
    });
    const index = new Flock();
    await readRoom(
      host,
      'cloud:mf:machine',
      { kind: 'flock', flockDocId: 'cloud:mf:machine' },
      createFlockAdapter(index)
    );
    expect(index.get(['localProject', 'project'])).toEqual({ rootPath: '/synthetic/project' });
    for (const write of wire.writes) {
      expect(write.bucket).toBe('encrypted-content');
      expect(Buffer.from(write.body).includes(Buffer.from('private.txt'))).toBe(false);
      expect(Buffer.from(write.body).includes(Buffer.from('/synthetic/project'))).toBe(false);
    }
  } finally {
    await host.close();
  }
});

it.each(['roost', 'legacy-task', 'legacy-index', 'identity-change', 'mode-change'] as const)(
  'refuses %s migration before upload',
  async (kind) => {
    const paired = await pairedMachine();
    const wire = encryptedServer();
    const host = await paired.open();
    try {
      const target = await openMigrationTarget(tokens, 'cloud' as WorkspaceId, host.content, {
        authorize: host.authorizeImport,
        bucketId: () => 'encrypted-content',
      });
      try {
        const manifest = manifestSchema.parse({
          version: 2,
          sourcePath: '/synthetic',
          sourceWorkspaceId: 'lw_source',
          sourceMachineId: 'local-machine',
          sourceUserId: 'local:owner',
          sourceName: 'OSS',
          targetWorkspaceId: 'cloud',
          targetContentMode: 'protected',
          targetGenesisHash: paired.genesisHash,
          targetMachineId: 'machine',
          targetUserId: 'acct',
          deployment: 'https://cloud.invalid',
          migrationId: 'e'.repeat(32),
          createdAt: '2026-11-23T00:00:00Z',
          machineMeta: {},
          documents: [
            {
              id: kind === 'legacy-task' ? 'task-one' : 'session-one',
              meta: kind === 'roost' ? { historyBackend: 'roost' } : {},
              sha256: 'a'.repeat(64),
            },
          ],
          flocks: kind === 'legacy-index' ? [{ id: 'cloud:ti', rows: [] }] : [],
        });
        if (kind === 'identity-change') manifest.targetGenesisHash = '0'.repeat(64);
        if (kind === 'mode-change') manifest.targetContentMode = 'plaintext';
        await expect(target.preflight(manifest, [])).rejects.toThrow(
          /legacy task or Roost|room is unavailable|target.*changed/
        );
        expect(wire.writes).toEqual([]);
        expect(wire.uploads.size).toBe(0);
      } finally {
        await target.close();
      }
    } finally {
      await host.close();
    }
  }
);
