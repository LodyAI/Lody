// @vitest-environment jsdom
import { File, Blob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { act, useRef, useState, type ClipboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { IDBFactory } from 'fake-indexeddb';
import { LoroDoc } from 'loro-crdt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore as createPlatformStore, type PlatformProvider } from '@lody/platform';
import { installAttachmentWorkspaceAccess } from '../src/lib/attachment-workspace-access';
import {
  SESSION_IMAGE_MAX_COUNT,
  SESSION_FILE_MAX_COUNT,
  SESSION_IMAGE_MAX_SIZE_BYTES,
  type SessionHistory,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { ChatComposer } from '../src/components/chat/chat-composer';
import { useChatLandingDraftSession } from '../src/hooks/use-chat-landing-draft-session';
import { useChatLandingImageDraft } from '../src/hooks/use-chat-landing-image-draft';
import { useChatLandingFileDraft } from '../src/hooks/use-chat-landing-file-draft';
import {
  chatLandingPendingImagesAtomFamily,
  chatLandingPendingFilesAtomFamily,
  buildChatLandingDraftKey,
} from '../src/atoms/chat-landing-draft';
import { splitImageAndFileAttachments, selectPastedClipboardFiles } from '../src/lib/file-drop';
import { acceptSessionUserTurn } from '../src/lib/session-send-admission';
import { createConversationSession } from '../src/lib/conversation-view';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import { createWorkspacePendingSends } from '../src/providers/workspace-pending-sends';
import { protectedAttachmentBlob } from '../src/lib/encrypted-session-attachment';
import { clearSessionImageCache, getSessionImageBlobUrl } from '../src/lib/session-image-cache';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { QueuedImagePreview } from '../src/components/sessions/message-queue/queued-image-preview';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { authTokenAtom, runtimeAtom } from '../src/atoms/runtime';
import { fetchSessionFilePreview } from '../src/lib/session-file-download';
import { initI18n } from '../src/i18n';

vi.mock('../src/components/mentions/mention-session-source', async (original) => ({
  ...(await original<object>()),
  useSessionMentionItems: () => [],
}));
vi.mock('../src/components/mentions/mention-agent-role-source', async (original) => ({
  ...(await original<object>()),
  useAgentRoleMentionItems: () => [],
}));
const local = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('../src/lib/electron-session-file-sender', () => ({
  canUseElectronLocalFileSend: () => true,
  sendSessionFileToLocalRuntime: async ({ file }: { file: File }) => {
    local.files.push(await file.text());
    throw new Error('Plaintext local handoff forbidden');
  },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Valid synthetic PNG, shared with the browser composer fixture.
const imageBytes = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII='
  ),
  (value) => value.charCodeAt(0)
);
const imageContent = new TextDecoder().decode(imageBytes);
const workspaceId = 'encrypted-workspace' as WorkspaceId;
let root: Root;
let container: HTMLDivElement;
let close: (() => Promise<void>)[] = [];
const objectUrls = new Map<string, globalThis.Blob>();

beforeEach(async () => {
  await initI18n('en');
  vi.stubGlobal('File', File);
  vi.stubGlobal('Blob', Blob);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('URL', NodeURL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:attachment-${objectUrls.size}`;
    objectUrls.set(url, blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  local.files = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const cleanup of close) await cleanup();
  close = [];
  container.remove();
  clearSessionImageCache();
  objectUrls.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(contentMode: 'e2ee' | 'plaintext' = 'e2ee') {
  const doc = new LoroDoc();
  const session = createConversationSession(doc, { sessionId: 'session' as SessionId });
  const metas = new Map<string, Record<string, unknown>>();
  const sendResources = createSessionSendResources({
    acquire: async () =>
      ({
        sessionData: session.sessionData,
        getState: () => session.mirror.getState(),
        setState: session.mirror.setState.bind(session.mirror),
        waitUntilSynced: async () => {},
      }) as never,
    releaseRef: () => {},
  });
  const runtime = {
    workspaceId,
    contentMode,
    attachmentToken: async () => 'attachment-only-token',
    sendResources,
    repo: { getDocMeta: async (id: string) => ({ meta: metas.get(id) }) },
    writer: {
      upsertDocMeta: async (id: string, patch: object) => {
        metas.set(id, { ...metas.get(id), ...patch });
      },
      appendSessionTurn: async (_id: SessionId, entry: SessionHistory) =>
        session.sessionData.commands.appendTurn(entry),
    },
  } as unknown as WorkspaceRuntime;
  runtime.pendingSends = createWorkspacePendingSends({
    runtime,
    accountId: 'account',
    workspaceId,
    localIdentity: {
      accountId: 'account',
      workspaceId,
      genesisHash: 'a'.repeat(64),
      signingPublicKey: 'b'.repeat(64),
    },
    token: () => 'ordinary-token',
    localMachineId: () => 'machine' as never,
  });
  close.push(async () => {
    await runtime.pendingSends!.dispose();
    await sendResources.dispose();
    session.dispose();
    doc.free();
  });
  const until = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (done()) {
          stop();
          resolve();
        }
      };
      const stop = runtime.pendingSends!.subscribe(check);
      check();
    });
  return { runtime, doc, session, metas, until };
}

function Composer({ runtime, slug = 'encrypted' }: { runtime: WorkspaceRuntime; slug?: string }) {
  const key = buildChatLandingDraftKey('account', slug);
  const { sessionId, ensureSessionId, resetSessionId } = useChatLandingDraftSession(key);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const images = useChatLandingImageDraft({
    draftKey: key,
    workspaceId,
    sessionId,
    ensureSessionId,
    authToken: 'ordinary-token',
    isMobile: false,
    projectKind: null,
  });
  const files = useChatLandingFileDraft({
    draftKey: key,
    workspaceId,
    sessionId,
    ensureSessionId,
    authToken: 'ordinary-token',
    machineId: 'machine' as never,
  });
  const add = (values: globalThis.File[]) => {
    const parts = splitImageAndFileAttachments(values);
    images.addFiles(parts.images);
    files.addFiles(parts.attachments);
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const values = Array.from(event.clipboardData.items)
      .map((item) => item.getAsFile())
      .filter((file): file is globalThis.File => !!file);
    const selected = selectPastedClipboardFiles({
      text: event.clipboardData.getData('text/plain'),
      files: values,
    });
    if (selected.files.length) {
      event.preventDefault();
      add(selected.files);
    }
  };
  const handleSubmit = async () => {
    try {
      const id = ensureSessionId();
      const entry = {
        id: 'turn',
        role: 'user',
        userId: 'account',
        timestamp: '2026-10-29T00:00:00Z',
        items: [],
        fileDiff: [],
        inputConfig: { inputBlocks: [{ type: 'text', text: 'keep draft' }] },
      } as unknown as SessionHistory;
      await acceptSessionUserTurn(
        runtime,
        id,
        entry,
        { kind: 'history' },
        { id, machineId: 'machine', historyBackend: 'loro' } as never,
        undefined,
        [...images.attachments, ...files.attachments]
      );
      images.clearPendingImages();
      files.clearPendingFiles();
      resetSessionId();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(event) => add(Array.from(event.target.files ?? []))}
      />
      <ChatComposer
        promptValue="keep draft"
        onPromptChange={() => {}}
        onPromptPaste={paste}
        onImageDrop={add}
        imageItems={images.imageItems}
        fileItems={files.fileItems}
        onAttachmentAddClick={() => inputRef.current?.click()}
        primaryAction={<button onClick={() => void handleSubmit()}>Send attachments</button>}
      />
      <output>{error}</output>
    </>
  );
}

async function mount(runtime: WorkspaceRuntime, store = createStore(), slug = 'encrypted') {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <Composer runtime={runtime} slug={slug} />
      </Provider>
    )
  );
  return store;
}
async function attach(method: 'paste' | 'drop' | 'select', files: globalThis.File[]) {
  await act(async () => {
    if (method === 'select') {
      const input = container.querySelector('input[type=file]')!;
      Object.defineProperty(input, 'files', { configurable: true, value: files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const event = new Event(method, { bubbles: true, cancelable: true });
      Object.defineProperty(event, method === 'paste' ? 'clipboardData' : 'dataTransfer', {
        value: {
          getData: () => '',
          types: ['Files'],
          files,
          items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        },
      });
      (method === 'paste'
        ? container.querySelector('textarea')!
        : container.querySelector('.group.relative')!
      ).dispatchEvent(event);
    }
  });
}
async function submit() {
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Send attachments')!
      .click()
  );
}

function relay() {
  const parts = new Map<string, Uint8Array>();
  const requests: { url: string; headers: Headers; bytes?: Uint8Array }[] = [];
  let fail: 'image' | 'file' | undefined;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const bytes = init?.method === 'POST' ? new Uint8Array(init.body as Uint8Array) : undefined;
    requests.push({ url, headers, bytes });
    if (init?.method === 'POST') {
      if (fail && url.includes(`session-encrypted-${fail}`))
        return new Response('', { status: 503 });
      const fileId = `part-${parts.size}`;
      parts.set(fileId, bytes!);
      return Response.json({
        file: {
          type: 'file',
          fileId,
          fileName: 'attachment.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: bytes!.length,
          sha256: 'a'.repeat(64),
          textPreview: false,
          transport: 'r2',
          uploadedAt: 1,
        },
      });
    }
    const id = url.split('/').pop()!;
    return new Response(parts.get(id) as Uint8Array<ArrayBuffer>);
  });
  return {
    requests,
    parts,
    fail: (kind?: 'image' | 'file') => {
      fail = kind;
    },
  };
}

it.each(['paste', 'drop', 'select'] as const)(
  'sends new image and file through the real composer and protected pending queue via %s',
  async (method) => {
    const f = fixture();
    const server = relay();
    await mount(f.runtime);
    await attach(method, [
      new File([imageBytes], 'secret.png', { type: 'image/png' }),
      new File(['private file bytes'], 'secret.txt', { type: 'text/plain' }),
    ]);
    expect(container.textContent).toContain('secret.txt');
    await submit();
    expect(container.querySelector('output')!.textContent).toBe('');
    await f.until(() => !f.runtime.pendingSends!.getSnapshot().length);
    expect(f.session.historyWriter.readStored()).toHaveLength(1);
    expect(local.files).toEqual([]);
    expect(server.requests).toHaveLength(2);
    expect(
      server.requests.every(
        (request) =>
          request.url.includes('/session-encrypted-') &&
          request.headers.get('Authorization') === 'Bearer attachment-only-token'
      )
    ).toBe(true);
    for (const request of server.requests) {
      expect(new TextDecoder().decode(request.bytes)).not.toContain('private');
      expect(JSON.stringify([...request.headers])).not.toContain('secret.');
    }
    // Independent receiving document reads the synced manifest, then authenticates
    // relay bytes using the actual client preview/download functions.
    const receivedDoc = new LoroDoc();
    receivedDoc.import(f.doc.export({ mode: 'snapshot' }));
    const receiver = createConversationSession(receivedDoc, { sessionId: 'session' as SessionId });
    try {
      const turn = receiver.historyWriter.readStored()[0]!;
      const attachments = turn.items.filter(
        (item) => item.type === 'image' || item.type === 'file'
      );
      expect(attachments).toHaveLength(2);
      clearSessionImageCache();
      for (const item of attachments) {
        if (item.type !== 'image' && item.type !== 'file') continue;
        expect(item.encryption).toBeDefined();
        const context = {
          workspaceId,
          sessionId: [...f.metas.values()][0]!.id as SessionId,
          encryption: item.encryption!,
          attachmentToken: f.runtime.attachmentToken,
        };
        const blob = await protectedAttachmentBlob(context);
        expect(await blob.text()).toBe(item.type === 'image' ? imageContent : 'private file bytes');
        await expect(
          protectedAttachmentBlob({ ...context, workspaceId: 'other' as WorkspaceId })
        ).rejects.toThrow();
        await expect(
          protectedAttachmentBlob({ ...context, sessionId: 'other' as SessionId })
        ).rejects.toThrow();
        const partId = item.encryption!.parts[0]!;
        const original = server.parts.get(partId)!;
        const corrupt = original.slice();
        corrupt[0] = corrupt[0]! ^ 1;
        server.parts.set(partId, corrupt);
        await expect(protectedAttachmentBlob(context)).rejects.toThrow();
        server.parts.set(partId, original);
        if (item.type === 'file') {
          await expect(
            fetchSessionFilePreview({
              ...context,
              fileId: item.fileId,
              token: 'ordinary-token',
              sizeBytes: item.sizeBytes,
            })
          ).resolves.toMatchObject({ text: 'private file bytes', truncated: false });
        }
        if (item.type === 'image') {
          const url = await getSessionImageBlobUrl({
            ...context,
            imageId: item.imageId,
            token: 'ordinary-token',
            encryption: item.encryption,
          });
          expect(await objectUrls.get(url)!.text()).toBe(imageContent);
          const receivingStore = createStore();
          receivingStore.set(currentWorkspaceIdAtom, workspaceId);
          receivingStore.set(authTokenAtom, 'ordinary-token');
          receivingStore.set(runtimeAtom, f.runtime);
          await act(async () =>
            root.render(
              <Provider store={receivingStore}>
                <QueuedImagePreview sessionId={context.sessionId} image={item} />
              </Provider>
            )
          );
          // Join the same real thumbnail read as the component, then flush its
          // resulting React state. No polling interval or sleep owns readiness.
          await act(async () => {
            await getSessionImageBlobUrl({
              ...context,
              imageId: item.imageId,
              token: 'ordinary-token',
              variant: 'thumbnail',
              thumbnailWidth: 40,
              thumbnailHeight: 40,
              thumbnailFit: 'cover',
              thumbnailQuality: 80,
            });
          });
          const displayed = container.querySelector('img')!;
          expect(displayed).not.toBeNull();
          expect(await objectUrls.get(displayed.getAttribute('src')!)!.text()).toBe(imageContent);
        }
      }
    } finally {
      receiver.dispose();
      receivedDoc.free();
    }
  }
);

it.each(['image', 'file'] as const)(
  'retains the draft and successful receipts after a protected %s failure, then retries only that attachment',
  async (kind) => {
    const f = fixture();
    const server = relay();
    server.fail(kind);
    await mount(f.runtime);
    await attach('select', [
      new File([imageBytes], 'secret.png', { type: 'image/png' }),
      new File(['private file bytes'], 'secret.txt', { type: 'text/plain' }),
    ]);
    await submit();
    expect(container.querySelector('output')!.textContent).toBe('');
    await f.until(() => !!f.runtime.pendingSends!.getSnapshot()[0]?.error);
    const held = f.runtime.pendingSends!.getSnapshot()[0]!;
    expect(held.entry.inputConfig?.inputBlocks).toContainEqual({
      type: 'text',
      text: 'keep draft',
    });
    expect(held.attachments).toHaveLength(2);
    const successful = held.attachments.find((item) => item.kind !== kind)!.ready;
    expect(successful).toHaveProperty('encryption');
    const failed = held.attachments.find((item) => item.kind === kind)!;
    expect(failed.ready).toBeUndefined();
    expect(await failed.source!.text()).toBe(
      kind === 'image' ? imageContent : 'private file bytes'
    );
    expect(local.files).toEqual([]);
    expect(f.session.historyWriter.readStored()).toEqual([]);
    expect(server.parts.size).toBe(1);
    server.fail();
    f.runtime.pendingSends!.retry('turn');
    await f.until(() => !f.runtime.pendingSends!.getSnapshot().length);
    const [turn] = f.session.historyWriter.readStored();
    expect(turn!.items).toContainEqual(successful);
    expect(
      turn!.items.filter((item) => item.type === 'image' || item.type === 'file')
    ).toHaveLength(2);
    expect(server.requests).toHaveLength(3);
    expect(server.parts.size).toBe(2);
    expect(local.files).toEqual([]);
  }
);

it('keeps sources and writes nothing when the protected grant is unavailable; retry obtains a grant without plaintext fallback', async () => {
  const f = fixture();
  const server = relay();
  const grant = f.runtime.attachmentToken;
  Object.assign(f.runtime, {
    attachmentToken: async () => {
      throw new Error('grant unavailable');
    },
  });
  await mount(f.runtime);
  await attach('paste', [
    new File([imageBytes], 'secret.png', { type: 'image/png' }),
    new File(['private file bytes'], 'secret.txt', { type: 'text/plain' }),
  ]);
  await submit();
  await f.until(() => !!f.runtime.pendingSends!.getSnapshot()[0]?.error);
  expect(
    f.runtime
      .pendingSends!.getSnapshot()[0]!
      .attachments.every((item) => item.source && !item.ready)
  ).toBe(true);
  expect(server.requests).toEqual([]);
  expect(local.files).toEqual([]);
  expect(f.session.historyWriter.readStored()).toEqual([]);
  Object.assign(f.runtime, { attachmentToken: grant });
  f.runtime.pendingSends!.retry('turn');
  await f.until(() => !f.runtime.pendingSends!.getSnapshot().length);
  expect(f.session.historyWriter.readStored()).toHaveLength(1);
  expect(server.parts.size).toBe(2);
});

it('preserves the original workspace draft across an unknown-mode wait and workspace switch', async () => {
  const f = fixture('plaintext');
  const server = relay();
  const described = Promise.withResolvers<import('@lody/cloud-api').WorkspaceAdmissionDescriptor>();
  const started = Promise.withResolvers<void>();
  const remove = installAttachmentWorkspaceAccess({
    identity: {
      session: createPlatformStore({ status: 'authenticated', user: { id: 'account' } } as never),
      signOut: async () => {},
    },
    workspaces: {
      state: createPlatformStore({
        status: 'ready',
        activeWorkspaceId: workspaceId,
        workspaces: [],
      }),
      setActive: async () => {},
    },
    e2eeWorkspaces: {
      describe: () => {
        started.resolve();
        return described.promise;
      },
    } as PlatformProvider['e2eeWorkspaces'],
  });
  close.push(async () => remove());
  const store = await mount(f.runtime);
  await attach('select', [
    new File([imageBytes], 'secret.png', { type: 'image/png' }),
    new File(['private file bytes'], 'secret.txt', { type: 'text/plain' }),
  ]);
  await submit();
  await started.promise;
  expect(server.requests).toEqual([]);
  expect(f.runtime.pendingSends!.getSnapshot()).toEqual([]);
  await mount(f.runtime, store, 'other-workspace');
  expect(container.textContent).not.toContain('secret.txt');
  await act(async () =>
    described.resolve({
      workspaceId,
      contentMode: 'e2ee',
      contentModeVersion: 1,
      activation: 'control-only',
      genesisHash: 'a'.repeat(64),
      cryptoOrgId: 'a'.repeat(64),
    })
  );
  await mount(f.runtime, store);
  expect(container.textContent).toContain('secret.txt');
  expect(container.querySelector('img[alt="secret.png"]')).not.toBeNull();
  expect(server.requests).toEqual([]);
  expect(local.files).toEqual([]);
  expect(f.runtime.pendingSends!.getSnapshot()).toEqual([]);
  expect(f.session.historyWriter.readStored()).toEqual([]);
});

it('keeps image/file count and size limits at the real draft hooks', async () => {
  const f = fixture();
  relay();
  const store = await mount(f.runtime);
  const oversizedImage = new File(['x'], 'large.png', { type: 'image/png' });
  Object.defineProperty(oversizedImage, 'size', { value: SESSION_IMAGE_MAX_SIZE_BYTES + 1 });
  const oversizedFile = new File(['x'], 'large.txt', { type: 'text/plain' });
  Object.defineProperty(oversizedFile, 'size', { value: 101 * 1024 * 1024 });
  await attach('select', [
    oversizedImage,
    oversizedFile,
    new File([], 'empty.txt', { type: 'text/plain' }),
  ]);
  const key = buildChatLandingDraftKey('account', 'encrypted');
  expect(store.get(chatLandingPendingImagesAtomFamily(key))).toEqual([]);
  expect(store.get(chatLandingPendingFilesAtomFamily(key))).toEqual([]);
  await attach('select', [
    ...Array.from(
      { length: SESSION_IMAGE_MAX_COUNT + 1 },
      (_, i) => new File(['image'], `image-${i}.png`, { type: 'image/png' })
    ),
    ...Array.from(
      { length: SESSION_FILE_MAX_COUNT + 1 },
      (_, i) => new File(['file'], `file-${i}.txt`, { type: 'text/plain' })
    ),
  ]);
  expect(store.get(chatLandingPendingImagesAtomFamily(key))).toHaveLength(SESSION_IMAGE_MAX_COUNT);
  expect(store.get(chatLandingPendingFilesAtomFamily(key))).toHaveLength(SESSION_FILE_MAX_COUNT);
});
