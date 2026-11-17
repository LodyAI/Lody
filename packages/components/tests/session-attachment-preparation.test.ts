import { installAttachmentWorkspaceAccess } from '../src/lib/attachment-workspace-access';
import * as electronIpc from '../src/lib/electron-ipc-client';
import { acceptSessionUserTurn } from '../src/lib/session-send-admission';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { LoroDoc } from 'loro-crdt';
import {
  getSessionRoomId,
  getMachineRoomId,
  type MachineId,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { createConversationSession } from '../src/lib/conversation-view';
import { createSessionSendResources } from '../src/lib/session-send-resources';

import {
  clearSessionImageCache,
  peekSessionImageUrl,
  getSessionImageBlobUrl,
} from '../src/lib/session-image-cache';
import type { WorkspaceId } from '@lody/shared';
import { createWorkspacePendingSends } from '../src/providers/workspace-pending-sends';
import type { PendingSessionSend, PendingSessionSends } from '../src/lib/session-pending-sends';
import type { SessionSendRuntime } from '../src/lib/session-send-delivery';
import { encryptedDispatchSigner } from './helpers/encrypted-dispatch-signer';
import { initI18n } from '../src/i18n';

const upload = vi.hoisted(() => ({
  run: undefined as undefined | ((file: File, signal: AbortSignal) => Promise<unknown>),
}));
vi.mock('../src/lib/session-image-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/session-image-upload')>()),
  uploadSessionImage: (args: { file: File; signal: AbortSignal }) =>
    upload.run!(args.file, args.signal),
}));
const local = vi.hoisted(() => ({
  enabled: false,
  machineId: null as string | null,
  files: [] as string[],
  fail: false,
}));
vi.mock('../src/lib/electron', () => ({ isElectronRenderer: () => local.enabled }));

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.spyOn(electronIpc, 'getIpcServices').mockReturnValue({
    localProjects: {
      resolveLocalImage: async () => {
        throw new Error('Local image snapshot unavailable');
      },
      prepareLocalImage: async (args: {
        workspaceId: string;
        sessionId: string;
        machineId: string;
        imageId: string;
        fileName: string;
        mimeType: string;
        source: { bytes: ArrayBuffer };
      }) => {
        expect(args).not.toHaveProperty('turnId');
        if (local.fail) return { ok: false, error: 'Local handoff failed' };
        local.files.push(new TextDecoder().decode(args.source.bytes));
        return {
          ok: true,
          image: {
            imageId: args.imageId,
            localImageId: args.imageId,
            transport: 'local',
            machineId: args.machineId,
            storageSessionId: args.sessionId,
            fileName: args.fileName,
            mimeType: args.mimeType,
            sizeBytes: args.source.bytes.byteLength,
          },
        };
      },
    },
  } as never);
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  Object.assign(local, { enabled: false, machineId: null, files: [], fail: false });
  upload.run = undefined;
  clearSessionImageCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SESSION = 'session' as SessionId;
const MACHINE = 'machine' as MachineId;

/**
 * The real workspace pending queue over a runtime whose session documents are
 * real Loro docs: "written" means present in that document's history.
 */
function fixture(encrypted = false, token: string | null = 'token') {
  const sessions = new Map<SessionId, ReturnType<typeof createConversationSession>>();
  const docs: LoroDoc[] = [];
  const open = (sessionId: SessionId) => {
    let session = sessions.get(sessionId);
    if (!session) {
      const doc = new LoroDoc();
      docs.push(doc);
      session = createConversationSession(doc, { sessionId });
      sessions.set(sessionId, session);
    }
    return session;
  };
  const metas = new Map<string, Record<string, unknown>>([
    [getSessionRoomId(SESSION), { id: SESSION, machineId: MACHINE }],
    [getMachineRoomId(MACHINE), { protocolCapabilities: {} }],
  ]);
  const resources = createSessionSendResources({
    acquire: async (sessionId) => {
      const session = open(sessionId);
      return {
        sessionData: session.sessionData,
        getState: () => session.mirror.getState(),
        setState: session.mirror.setState.bind(session.mirror),
        waitUntilSynced: async () => {},
      } as never;
    },
    releaseRef: () => {},
  });
  const dispatched: string[] = [];
  const dispatchListeners = new Set<() => void>();
  const runtime = {
    contentMode: encrypted ? 'e2ee' : 'plaintext',
    sendResources: resources,
    repo: {
      getDocMeta: async (roomId: string) =>
        metas.has(roomId) ? { meta: metas.get(roomId) } : undefined,
      flush: async () => {},
    },
    writer: {
      upsertDocMeta: async (roomId: string, patch: Record<string, unknown>) => {
        metas.set(roomId, { ...metas.get(roomId), ...patch });
      },
      appendSessionTurn: async (sessionId: SessionId, entry: SessionHistory) => {
        await open(sessionId).sessionData.commands.appendTurn(entry);
      },
    },
    requestSessionDispatchTurn: async (_machine: MachineId, args: { userTurnId: string }) => {
      dispatched.push(args.userTurnId);
      for (const listener of dispatchListeners) listener();
      return { accepted: true };
    },
  } as unknown as SessionSendRuntime;
  const pending = createWorkspacePendingSends({
    runtime,
    ...(encrypted
      ? {
          localIdentity: {
            accountId: 'attachment-test-account',
            workspaceId: 'workspace',
            genesisHash: 'a'.repeat(64),
            signingPublicKey: 'b'.repeat(64),
          },
        }
      : {}),
    accountId: 'attachment-test-account',
    workspaceId: 'workspace',
    token: () => token,
    localMachineId: () => local.machineId as MachineId | null,
  });
  cleanup.push(async () => {
    await pending.dispose();
    await resources.dispose();
    for (const session of sessions.values()) session.dispose();
    for (const doc of docs) doc.free();
  });
  const turns = (sessionId = SESSION) => open(sessionId).historyWriter.readStored();
  /** Resolves once the written turn's best-effort delivery reached the machine. */
  const delivered = (id: string) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!dispatched.includes(id)) return;
        dispatchListeners.delete(check);
        resolve();
      };
      dispatchListeners.add(check);
      check();
    });
  return { runtime, pending, turns, metas, delivered };
}

function until(
  pending: PendingSessionSends,
  done: (sends: readonly PendingSessionSend[]) => boolean
) {
  return new Promise<readonly PendingSessionSend[]>((resolve) => {
    const listeners = new Set<() => void>();
    const check = () => {
      const sends = pending.getSnapshot();
      if (!done(sends)) return;
      for (const stop of listeners) stop();
      resolve(sends);
    };
    listeners.add(pending.subscribe(check));
    check();
  });
}
const failed = (pending: PendingSessionSends, id: string) =>
  until(pending, (sends) => Boolean(sends.find((send) => send.id === id)?.error)).then((sends) =>
    sends.find((send) => send.id === id)!
  );

const send = (id: string, names: string[], sessionId = SESSION) => ({
  id,
  sessionId,
  workspaceId: 'workspace',
  targetMachineId: MACHINE,
  entry: {
    id,
    role: 'user',
    userId: 'account',
    timestamp: '2026-01-01T00:00:00Z',
    items: [],
    fileDiff: [],
    inputConfig: {
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [{ type: 'text', text: `keep ${id}` }],
    },
  } as unknown as SessionHistory,
  delivery: { kind: 'dispatch' as const },
  attachments: names.map((name) => ({
    id: name,
    kind: 'image' as const,
    source: new Blob([name]),
    name,
    mimeType: 'image/png',
    lastModified: 1,
  })),
});
const ready = (file: File) => ({
  imageId: file.name,
  mimeType: 'image/png',
  fileName: file.name,
  sizeBytes: file.size,
});
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Upload canceled', 'AbortError')),
      { once: true }
    )
  );

it('holds an attachment send out of the document until it is ready, then writes final references', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  upload.run = async (file) => {
    started.resolve();
    await finish.promise;
    return ready(file);
  };
  f.pending.enqueue(send('message', ['image']));
  await started.promise;
  expect(f.turns()).toEqual([]);
  expect(f.pending.hasSession(SESSION)).toBe(true);
  finish.resolve();
  await f.delivered('message');
  expect(f.pending.getSnapshot()).toEqual([]);
  const cachedUrl = peekSessionImageUrl({
    workspaceId: 'workspace' as WorkspaceId,
    sessionId: SESSION,
    imageId: 'image',
  });
  expect(cachedUrl).toMatch(/^blob:/);
  expect(
    await getSessionImageBlobUrl({
      workspaceId: 'workspace' as WorkspaceId,
      sessionId: SESSION,
      imageId: 'image',
      token: 'token',
      variant: 'thumbnail',
      thumbnailWidth: 160,
    })
  ).toBe(cachedUrl);
  const [turn] = f.turns();
  expect(turn?.id).toBe('message');
  expect(turn?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'image', imageId: 'image' }),
      expect.objectContaining({ type: 'text', text: 'keep message' }),
    ])
  );
  expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBe('message');
});

it('preserves successful upload and publication when preview caching fails', async () => {
  const f = fixture();
  upload.run = async (file) => ready(file);
  const objectUrl = vi.spyOn(URL, 'createObjectURL').mockImplementationOnce(() => {
    throw new Error('Preview cache unavailable');
  });
  try {
    f.pending.enqueue(send('cached-failure', ['image']));
    await f.delivered('cached-failure');
    expect(f.pending.getSnapshot()).toEqual([]);
    expect(f.turns()[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', imageId: 'image' }),
        expect.objectContaining({ type: 'text', text: 'keep cached-failure' }),
      ])
    );
  } finally {
    objectUrl.mockRestore();
  }
});

it('keeps successful attachment receipts, blocks later sends, and retries only the failure', async () => {
  const f = fixture();
  const uploaded: string[] = [];
  let rejectSecond = true;
  upload.run = async (file) => {
    if (file.name === 'second' && rejectSecond) throw new Error('Upload failed');
    uploaded.push(file.name);
    return ready(file);
  };
  f.pending.enqueue(send('message', ['first', 'second']));
  f.pending.enqueue(send('after', []));
  const blocked = await failed(f.pending, 'message');
  expect(blocked.error).toBe('Upload failed');
  expect(blocked.attachments.map((item) => [item.name, !!item.ready, item.error])).toEqual([
    ['first', true, undefined],
    ['second', false, 'Upload failed'],
  ]);
  expect(f.pending.has('after')).toBe(true);
  expect(f.turns()).toEqual([]);

  rejectSecond = false;
  f.pending.retry('message');
  await f.delivered('after');
  expect(uploaded).toEqual(['first', 'second']);
  const turns = f.turns();
  expect(turns.map((turn) => turn.id)).toEqual(['message', 'after']);
  expect(turns[0]?.items).toHaveLength(3);
  expect(JSON.stringify(turns[0])).toContain('keep message');
});

it('drains one conversation in order while other conversations proceed', async () => {
  const f = fixture();
  const other = 'other' as SessionId;
  f.metas.set(getSessionRoomId(other), { id: other, machineId: MACHINE });
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  upload.run = async (file) => {
    started.resolve();
    await finish.promise;
    return ready(file);
  };
  f.pending.enqueue(send('first', ['image']));
  f.pending.enqueue(send('second', []));
  f.pending.enqueue(send('elsewhere', [], other));
  await started.promise;
  await f.delivered('elsewhere');
  expect(f.turns(other).map((turn) => turn.id)).toEqual(['elsewhere']);
  expect(f.turns()).toEqual([]);
  expect(f.pending.getSnapshot().map((item) => item.id)).toEqual(['first', 'second']);
  finish.resolve();
  await f.delivered('second');
  expect(f.turns().map((turn) => turn.id)).toEqual(['first', 'second']);
});

it('joins a late upload before cancel returns and never writes the canceled message', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  upload.run = async (file, signal) => {
    signal.addEventListener('abort', () => interrupted.resolve(), { once: true });
    started.resolve();
    await finish.promise;
    return ready(file);
  };
  f.pending.enqueue(send('canceled', ['late']));
  await started.promise;
  let canceled = false;
  const cancellation = f.pending.cancel('canceled').then(() => {
    canceled = true;
  });
  await interrupted.promise;
  expect(canceled).toBe(false);
  expect(f.pending.getSnapshot()).toEqual([]);
  finish.resolve();
  await cancellation;
  expect(f.turns()).toEqual([]);
  expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBeUndefined();
});

it('transfers a canceled first send creation to the next text message', async () => {
  const f = fixture();
  const created = 'created' as SessionId;
  const creation = { id: created, machineId: MACHINE, userId: 'account' } as SessionMeta;
  const started = Promise.withResolvers<void>();
  upload.run = async (_file, signal) => {
    started.resolve();
    return aborted(signal);
  };
  f.pending.enqueue({ ...send('first', ['image'], created), creation });
  f.pending.enqueue(send('next', [], created));
  await started.promise;
  expect(f.pending.hasPendingCreation(created)).toBe(true);
  await f.pending.cancel('first');
  await f.delivered('next');
  expect(f.turns(created).map((turn) => turn.id)).toEqual(['next']);
  expect(f.metas.get(getSessionRoomId(created))).toMatchObject({
    id: created,
    machineId: MACHINE,
    userId: 'account',
    latestUserMsgId: 'next',
  });
});

it('retains a failed same-machine image without attempting cloud fallback', async () => {
  Object.assign(local, { enabled: true, machineId: 'machine', fail: true });
  const f = fixture(false, null);
  upload.run = async (file) => ready(file);
  f.pending.enqueue(send('blocked', ['image.png']));
  await initI18n('en');
  const held = await failed(f.pending, 'blocked');
  expect(f.turns()).toEqual([]);
  // The row tells the sender which step failed and what to do, with the host's reason.
  expect(held.error).toBe(
    "Lody on this computer couldn't prepare this attachment (Local handoff failed). Make sure the local agent is running and up to date, then continue sending."
  );
  expect(held.attachments[0]?.error).toBe(held.error);
  expect(await held.attachments[0]?.source?.text()).toBe('image.png');
});
it('uses transfer for a different or unknown desktop local identity', async () => {
  for (const machineId of ['other', null]) {
    Object.assign(local, { enabled: true, machineId });
    const f = fixture();
    upload.run = async (file) => ready(file);
    f.pending.enqueue(send('remote-image', ['remote.png']));
    await f.delivered('remote-image');
    expect(local.files).toEqual([]);
    expect(f.turns()[0]?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image', imageId: 'remote.png' })])
    );
  }
});

it('admits an already prepared local file in an encrypted workspace without uploading it', async () => {
  const f = fixture();
  const entry = {
    id: 'prepared-local',
    role: 'user',
    userId: 'account',
    timestamp: '2026-10-27T00:00:00Z',
    items: [{ type: 'text', text: 'local file' }],
    fileDiff: [],
    // The composer always names its agent; a member host signs only such an input.
    inputConfig: {
      inputBlocks: [{ type: 'text', text: 'local file' }],
      cliType: 'builtin',
      agentType: 'codex',
    },
  };
  const signer = encryptedDispatchSigner();
  const file = {
    type: 'file',
    transport: 'local',
    fileId: '/local/private.txt',
    fileName: 'private.txt',
    mimeType: 'text/plain',
    sizeBytes: 7,
    sha256: 'a'.repeat(64),
    textPreview: false,
    uploadedAt: 1,
    machineId: MACHINE,
  };
  const result = await acceptSessionUserTurn(
    {
      ...f.runtime,
      workspaceId: 'workspace',
      contentMode: 'e2ee',
      prepareEncryptedDispatch: signer.prepareEncryptedDispatch,
    } as unknown as WorkspaceRuntime,
    SESSION,
    entry as SessionHistory,
    { kind: 'dispatch' },
    undefined,
    undefined,
    [{ id: 'local', kind: 'file', name: 'private.txt', ready: file }] as never
  );
  expect(result).toBe('written');
  expect(f.turns()[0]?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'file', transport: 'local', fileId: '/local/private.txt' }),
    ])
  );
  // The signed input carries the prepared file, so the machine runs what was signed.
  expect(signer.signed[0]?.inputConfig.inputBlocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'file', fileId: '/local/private.txt' }),
    ])
  );
});

it('rejects unprotected or mismatched prepared references and keeps the encrypted Roost fence', async () => {
  const f = fixture(true);
  const value = send('rejected', ['image.png']);
  expect(() => f.pending.enqueue({ ...value, historyBackend: 'roost' })).toThrow(
    'e2ee_feature_unavailable'
  );
  expect(() => f.pending.enqueue({ ...value, workspaceId: 'other' })).toThrow(
    'attachment_workspace_mismatch'
  );
  expect(() =>
    f.pending.enqueue({
      ...value,
      attachments: value.attachments.map((item) => ({
        ...item,
        ready: { type: 'image', ...ready(new File(['x'], 'image.png')) },
      })),
    })
  ).toThrow('e2ee_attachment_unprotected');
  expect(f.pending.getSnapshot()).toEqual([]);
  expect(f.turns()).toEqual([]);
});

it('refuses an unprotected preparation receipt without losing the draft source', async () => {
  const f = fixture(true);
  // An older/miswired preparation adapter returning a plaintext receipt must
  // never be enough to commit it into encrypted conversation content.
  upload.run = async (file) => ready(file);
  f.pending.enqueue(send('unprotected', ['image.png']));
  const held = await failed(f.pending, 'unprotected');
  expect(held.error).toBe('e2ee_attachment_unprotected');
  expect(await held.attachments[0]?.source?.text()).toBe('image.png');
  expect(f.turns()).toEqual([]);
  expect(local.files).toEqual([]);
});

it('keeps an unknown-mode text draft unconsumed across rejection and an explicit retry', async () => {
  const f = fixture();
  const mode = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  void mode.promise.catch(() => {});
  let draft = 'C1 unaccepted draft sentinel';
  const entry = send('unknown-text', []).entry;
  entry.inputConfig!.inputBlocks = [{ type: 'text', text: draft }];
  let admitted = false;
  const runtime = {
    ...f.runtime,
    workspaceId: 'workspace',
    contentMode: 'plaintext',
    waitForContentAdmission: () => {
      waiting.resolve();
      return admitted ? Promise.resolve() : mode.promise;
    },
  } as unknown as WorkspaceRuntime;
  const sending = acceptSessionUserTurn(
    runtime,
    SESSION,
    entry,
    { kind: 'history' },
    undefined,
    undefined,
    undefined,
    () => {
      draft = '';
    }
  );
  const rejectedSend = expect(sending).rejects.toThrow('mode unavailable');
  void rejectedSend.catch(() => {});
  try {
    await Promise.race([waiting.promise, sending.catch(() => {})]);
    expect(draft).toBe('C1 unaccepted draft sentinel');
    expect(f.turns()).toEqual([]);
    mode.reject(new Error('mode unavailable'));
    await rejectedSend;
    expect(draft).toBe('C1 unaccepted draft sentinel');
    admitted = true;
    await acceptSessionUserTurn(
      runtime,
      SESSION,
      entry,
      { kind: 'history' },
      undefined,
      undefined,
      undefined,
      () => {
        draft = '';
      }
    );
    expect(draft).toBe('');
    expect(f.turns().map((turn) => turn.inputConfig?.inputBlocks)).toEqual([
      [{ type: 'text', text: 'C1 unaccepted draft sentinel' }],
    ]);
  } finally {
    mode.reject(new Error('mode unavailable'));
    await sending.catch(() => {});
    await rejectedSend.catch(() => {});
  }
});

it('sends a same-machine image without cloud authentication or a cloud transfer', async () => {
  Object.assign(local, { enabled: true, machineId: 'machine' });
  const f = fixture(false, null);
  upload.run = async () => {
    throw new Error('Cloud transfer must not be selected');
  };
  f.pending.enqueue(send('offline-image', ['image.png']));
  await until(f.pending, (sends) => sends.length === 0 || sends.some((s) => !!s.error));
  expect(f.turns()[0]?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'image',
        transport: 'local',
        machineId: MACHINE,
        storageSessionId: SESSION,
        mimeType: 'image/png',
        sizeBytes: 9,
        imageId: expect.any(String),
        localImageId: expect.any(String),
      }),
      expect.objectContaining({ type: 'text', text: 'keep offline-image' }),
    ])
  );
  const image = f.turns()[0]?.inputConfig?.inputBlocks?.find((block) => block.type === 'image');
  expect(image?.imageId).toBe(image?.localImageId);
  expect(local.files).toEqual(['image.png']);
  if (!image) throw new Error('Expected a committed image');
  const identity = { ...image, workspaceId: 'workspace' as WorkspaceId, sessionId: SESSION };
  const url = peekSessionImageUrl(identity);
  expect(url).toMatch(/^blob:/);
  expect(
    await getSessionImageBlobUrl({
      ...identity,
      transport: 'r2',
      imageId: 'published-image',
      token: '',
    })
  ).toBe(url);
  clearSessionImageCache();
  await expect(
    getSessionImageBlobUrl({
      ...identity,
      transport: 'r2',
      imageId: 'published-image',
      token: '',
    })
  ).rejects.toThrow('Local image snapshot unavailable');
});

it('sends a same-machine image without daemon capability metadata', async () => {
  Object.assign(local, { enabled: true, machineId: 'machine' });
  const f = fixture(false, null);
  f.metas.set(getMachineRoomId(MACHINE), { protocolCapabilities: {} });
  f.pending.enqueue(send('no-capabilities', ['image.png']));
  await f.delivered('no-capabilities');
  expect(f.turns()[0]?.inputConfig?.inputBlocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'image', transport: 'local', machineId: MACHINE }),
    ])
  );
  expect(local.files).toEqual(['image.png']);
});

it('keeps an original path without host preparation or reading file bytes', async () => {
  const { prepareElectronLocalAttachment } = await vi.importActual<
    typeof import('../src/lib/electron-local-attachment')
  >('../src/lib/electron-local-attachment');
  const expected = {
    type: 'local_attachment' as const,
    path: '/synthetic/original.txt',
    machineId: 'machine',
    kind: 'file' as const,
    fileName: 'original.txt',
    mimeType: 'text/plain',
    sizeBytes: 9,
  };
  const bridge = vi.spyOn(electronIpc, 'getIpcServices').mockImplementation(() => {
    throw new Error('Original paths do not need host preparation');
  });
  try {
    const source = new Blob(['synthetic']);
    source.arrayBuffer = async () => {
      throw new Error('Original file bytes must not cross IPC');
    };
    await expect(
      prepareElectronLocalAttachment({
        workspaceId: 'workspace',
        sessionId: 'session',
        machineId: 'machine',
        signal: new AbortController().signal,
        attachment: {
          id: 'draft',
          kind: 'file',
          source,
          name: 'original.txt',
          mimeType: 'text/plain',
          lastModified: 0,
          localSourcePath: '/synthetic/original.txt',
        },
      })
    ).resolves.toEqual(expected);
  } finally {
    bridge.mockRestore();
  }
});

it('admits same-machine draft attachments without cloud identity', async () => {
  Object.assign(local, { enabled: true, machineId: MACHINE });
  const remove = installAttachmentWorkspaceAccess({
    identity: { session: { get: () => ({ status: 'unauthenticated' }) } },
    workspaces: {},
    e2eeWorkspaces: {},
  } as never);
  try {
    const f = fixture(false, null);
    const input = send('offline-admission', ['local.png']);
    const result = await acceptSessionUserTurn(
      {
        ...f.runtime,
        workspaceId: 'workspace',
        pendingSends: f.pending,
      } as unknown as WorkspaceRuntime,
      SESSION,
      input.entry,
      input.delivery,
      undefined,
      undefined,
      input.attachments
    );
    expect(result).toBe('pending');
    await f.delivered(input.id);
    expect(f.turns()[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', transport: 'local', fileName: 'local.png' }),
      ])
    );
  } finally {
    remove();
  }
});

it('rejects a remote attachment before consuming the draft when cloud admission fails', async () => {
  Object.assign(local, { enabled: true, machineId: 'another-machine' });
  const remove = installAttachmentWorkspaceAccess({
    identity: { session: { get: () => ({ status: 'unauthenticated' }) } },
    workspaces: {},
    e2eeWorkspaces: {},
  } as never);
  try {
    const f = fixture(false, null);
    const input = send('remote-admission', ['remote.png']);
    await expect(
      acceptSessionUserTurn(
        {
          ...f.runtime,
          workspaceId: 'workspace',
          pendingSends: f.pending,
        } as unknown as WorkspaceRuntime,
        SESSION,
        input.entry,
        input.delivery,
        undefined,
        undefined,
        input.attachments
      )
    ).rejects.toThrow('attachment_workspace_mode_unverified');
    expect(f.pending.getSnapshot()).toEqual([]);
    expect(input.attachments[0]?.source).toBeDefined();
    expect(f.turns()).toEqual([]);
    expect(local.files).toEqual([]);
  } finally {
    remove();
  }
});
