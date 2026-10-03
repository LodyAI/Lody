import { afterEach, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  getSessionRoomId,
  SESSION_FILE_MAX_COUNT,
  type MachineId,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { createConversationSession } from '../src/lib/conversation-view';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import { finalizePreparedSend } from '../src/lib/session-attachment-preparation';
import {
  clearSessionImageCache,
  peekSessionImageUrl,
  getSessionImageBlobUrl,
} from '../src/lib/session-image-cache';
import type { WorkspaceId } from '@lody/shared';
import { createWorkspacePendingSends } from '../src/providers/workspace-pending-sends';
import type { PendingSessionSend, PendingSessionSends } from '../src/lib/session-pending-sends';
import type { SessionSendRuntime } from '../src/lib/session-send-delivery';

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
vi.mock('../src/lib/electron-session-file-sender', () => ({
  canUseElectronLocalFileSend: () => local.enabled,
  sendSessionFileToLocalRuntime: async ({ file }: { file: File }) => {
    if (local.fail) return { ok: false, error: 'Local handoff failed' };
    local.files.push(await file.text());
    return {
      ok: true,
      files: [
        {
          type: 'file',
          transport: 'local',
          fileId: file.name,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          machineId: 'machine',
          sha256: 'a'.repeat(64),
          textPreview: false,
          uploadedAt: 1,
        },
      ],
    };
  },
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  Object.assign(local, { enabled: false, machineId: null, files: [], fail: false });
  upload.run = undefined;
  clearSessionImageCache();
});

const SESSION = 'session' as SessionId;
const MACHINE = 'machine' as MachineId;

/**
 * The real workspace pending queue over a runtime whose session documents are
 * real Loro docs: "written" means present in that document's history.
 */
function fixture() {
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
  ]);
  const resources = createSessionSendResources({
    acquire: async (sessionId) => {
      const session = open(sessionId);
      return {
        sessionData: session.sessionData,
        getState: () => session.mirror.getState(),
        waitUntilSynced: async () => {},
      } as never;
    },
    releaseRef: () => {},
  });
  const dispatched: string[] = [];
  const dispatchListeners = new Set<() => void>();
  const runtime = {
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
    token: () => 'token',
    localMachineId: () => local.machineId as MachineId | null,
  });
  cleanup.push(async () => {
    pending.dispose();
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
  return { pending, turns, metas, delivered };
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

it('finalizing an already finalized input does not duplicate its attachment blocks', async () => {
  const { buildDraftUserHistoryEntry } = await import('../src/lib/session-attachment-draft');
  const value = send('only', ['image']);
  const attachments = value.attachments.map((item) => ({
    ...item,
    ready: {
      type: 'image' as const,
      imageId: item.id,
      mimeType: item.mimeType,
      fileName: item.name,
      sizeBytes: 5,
    },
  }));
  const draft = buildDraftUserHistoryEntry(
    { userId: 'account', timestamp: '2026-01-01T00:00:00Z', inputBlocks: [] },
    attachments
  );
  expect(draft?.items).toEqual([]);
  const first = finalizePreparedSend({ ...value, attachments });
  expect(first.entry.items).toHaveLength(2);
  expect(first.attachments.every((item) => item.ready && !item.source)).toBe(true);
  const again = finalizePreparedSend({ ...value, ...first });
  expect(again.entry.items).toEqual(first.entry.items);
  expect(again.entry.inputConfig).toEqual(first.entry.inputConfig);
});

it('writes a failed cloud image through the same-machine local handoff as a file receipt', async () => {
  Object.assign(local, { enabled: true, machineId: 'machine' });
  const f = fixture();
  upload.run = async () => {
    throw new Error('Image upload offline');
  };
  f.pending.enqueue(send('local-image', ['image.png']));
  await f.delivered('local-image');
  expect(local.files).toEqual(['image.png']);
  expect(f.turns()[0]?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'file', transport: 'local', fileId: 'image.png' }),
      expect.objectContaining({ type: 'text', text: 'keep local-image' }),
    ])
  );
});

it.each(['remote', 'no-capability', 'canceled', 'file-limit', 'local-failure'])(
  'keeps the message held without local image fallback for %s',
  async (reason) => {
    Object.assign(local, {
      enabled: reason !== 'no-capability',
      machineId: reason === 'remote' ? 'other' : 'machine',
      fail: reason === 'local-failure',
    });
    const f = fixture();
    const failure =
      reason === 'canceled'
        ? new DOMException('Upload canceled', 'AbortError')
        : new Error('Image upload offline');
    upload.run = async () => {
      throw failure;
    };
    const value = send('blocked', ['image.png']);
    if (reason === 'file-limit')
      (value.entry.inputConfig as { inputBlocks: unknown[] }).inputBlocks = Array.from(
        { length: SESSION_FILE_MAX_COUNT },
        (_, i) => ({
          type: 'file',
          fileId: `existing-${i}`,
          fileName: 'file',
          mimeType: 'text/plain',
          sizeBytes: 1,
          transport: 'local' as const,
          machineId: 'machine',
          sha256: 'a'.repeat(64),
          textPreview: false,
          uploadedAt: 1,
        })
      );
    f.pending.enqueue(value);
    const held = await failed(f.pending, 'blocked');
    expect(local.files).toEqual([]);
    expect(f.turns()).toEqual([]);
    expect(held).toMatchObject({
      error: failure.message,
      attachments: [expect.objectContaining({ error: failure.message })],
    });
    expect(held.attachments[0]?.source).toBeInstanceOf(Blob);
  }
);
