// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, WorkspaceId } from '@lody/shared';

import { useChatLandingDraftSession } from '../src/hooks/use-chat-landing-draft-session';
import {
  useChatLandingImageDraft,
  type ChatLandingImageDraftItem,
} from '../src/hooks/use-chat-landing-image-draft';
import {
  useChatLandingFileDraft,
  type ChatLandingFileDraftItem,
} from '../src/hooks/use-chat-landing-file-draft';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const uploadMocks = vi.hoisted(() => ({
  imageUpload: null as Deferred<unknown> | null,
  fileUpload: null as Deferred<unknown> | null,
  /** Resolves the moment the hook reaches `uploadSessionFile`, so the test
   *  waits on that call rather than on a guessed number of microtasks. */
  fileUploadStarted: null as Deferred<void> | null,
  fileUploadSignals: [] as (AbortSignal | undefined)[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

vi.mock('@posthog/react', () => ({ usePostHog: () => null }));

vi.mock('../src/lib/posthog-analytics', () => ({ capturePostHogEvent: vi.fn() }));

vi.mock('../src/lib/session-image-upload', () => ({
  validateSessionImageFile: () => null,
  uploadSessionImage: () => {
    uploadMocks.imageUpload = deferred<unknown>();
    return uploadMocks.imageUpload.promise;
  },
}));

vi.mock('../src/lib/session-file-upload', () => ({
  SESSION_FILE_MAX_SIZE_MB: 20,
  validateSessionFile: () => null,
  computeSha256Hex: async () => 'sha256',
  computeTextPreviewable: async () => undefined,
  isUploadAbortedError: () => false,
  isSessionFileTransferPhase: (status: string) => status === 'preparing' || status === 'uploading',
  uploadSessionFile: ({ signal }: { signal?: AbortSignal }) => {
    uploadMocks.fileUploadSignals.push(signal);
    uploadMocks.fileUpload = deferred<unknown>();
    uploadMocks.fileUploadStarted?.resolve();
    return uploadMocks.fileUpload.promise;
  },
}));

vi.mock('../src/lib/electron-session-file-sender', () => ({
  canUseElectronLocalFileSend: () => false,
  sendSessionFileToLocalRuntime: async () => null,
}));

const WORKSPACE_A_KEY = 'user-1:workspace-a';
const WORKSPACE_B_KEY = 'user-1:workspace-b';

type Harness = {
  imageItems: ChatLandingImageDraftItem[];
  fileItems: ChatLandingFileDraftItem[];
  sessionId: SessionId | null;
  addImages: (files: File[]) => void;
  addFiles: (files: File[]) => void;
  removeImage: (localId: string) => void;
  clearDraft: () => void;
};

let harness: Harness | null = null;

function DraftHarness({ draftKey }: { draftKey: string }) {
  const { sessionId, ensureSessionId } = useChatLandingDraftSession(draftKey);
  const imageDraft = useChatLandingImageDraft({
    draftKey,
    workspaceId: 'workspace-a' as WorkspaceId,
    authToken: 'token',
    isMobile: false,
    projectKind: null,
    sessionId,
    ensureSessionId,
  });
  const fileDraft = useChatLandingFileDraft({
    draftKey,
    workspaceId: 'workspace-a' as WorkspaceId,
    authToken: 'token',
    machineId: null,
    sessionId,
    ensureSessionId,
  });
  harness = {
    imageItems: imageDraft.imageItems,
    fileItems: fileDraft.fileItems,
    sessionId,
    addImages: imageDraft.addFiles,
    addFiles: fileDraft.addFiles,
    removeImage: imageDraft.handleRemoveImage,
    // What submit-accepted and `resetDraftKey` call in `chat-landing.tsx`.
    clearDraft: () => {
      imageDraft.clearPendingImages();
      fileDraft.clearPendingFiles();
    },
  };
  return null;
}

let store = createStore();
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let objectUrlSeq = 0;
let revokedUrls: string[] = [];

function mountLanding(draftKey: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(Provider, { store }, createElement(DraftHarness, { draftKey })));
  });
}

function unmountLanding(): void {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
}

function readHarness(): Harness {
  if (!harness) throw new Error('landing harness is not mounted');
  return harness;
}

function pngFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

function textFile(name: string): File {
  return new File([new Uint8Array([4, 5, 6])], name, { type: 'text/plain' });
}

beforeEach(() => {
  store = createStore();
  harness = null;
  objectUrlSeq = 0;
  revokedUrls = [];
  uploadMocks.imageUpload = null;
  uploadMocks.fileUpload = null;
  uploadMocks.fileUploadStarted = deferred<void>();
  uploadMocks.fileUploadSignals = [];
  URL.createObjectURL = () => `blob:preview/${(objectUrlSeq += 1)}`;
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
});

afterEach(() => {
  if (root) unmountLanding();
});

describe('chat landing draft attachments across a route unmount', () => {
  it('restores images, their preview URLs, and the reserved session id', () => {
    mountLanding(WORKSPACE_A_KEY);
    act(() => {
      readHarness().addImages([pngFile('shot.png')]);
    });

    const added = readHarness().imageItems;
    expect(added).toHaveLength(1);
    const previewUrl = added[0]!.previewUrl;
    const reservedSessionId = readHarness().sessionId;
    expect(reservedSessionId).not.toBeNull();

    unmountLanding();
    expect(revokedUrls).toEqual([]);

    mountLanding(WORKSPACE_A_KEY);
    const restored = readHarness().imageItems;
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe(added[0]!.id);
    expect(restored[0]!.previewUrl).toBe(previewUrl);
    expect(readHarness().sessionId).toBe(reservedSessionId);
  });

  it('revokes a preview URL when the user removes that image', () => {
    mountLanding(WORKSPACE_A_KEY);
    act(() => {
      readHarness().addImages([pngFile('shot.png')]);
    });
    const [item] = readHarness().imageItems;

    act(() => {
      readHarness().removeImage(item!.id);
    });

    expect(revokedUrls).toEqual([item!.previewUrl]);
    expect(readHarness().imageItems).toEqual([]);
  });

  it('lets an image upload that was in flight at unmount finish into the restored draft', async () => {
    mountLanding(WORKSPACE_A_KEY);
    act(() => {
      readHarness().addImages([pngFile('shot.png')]);
    });
    expect(readHarness().imageItems[0]!.status).toBe('uploading');

    unmountLanding();
    await act(async () => {
      uploadMocks.imageUpload?.resolve({
        imageId: 'image-1',
        mimeType: 'image/png',
        fileName: 'shot.png',
        sizeBytes: 3,
      });
      await Promise.resolve();
    });

    mountLanding(WORKSPACE_A_KEY);
    expect(readHarness().imageItems[0]!.status).toBe('uploaded');
  });

  it('does not abort a file upload when the landing unmounts', async () => {
    mountLanding(WORKSPACE_A_KEY);
    await act(async () => {
      readHarness().addFiles([textFile('notes.txt')]);
      await uploadMocks.fileUploadStarted?.promise;
    });
    expect(uploadMocks.fileUploadSignals).toHaveLength(1);

    unmountLanding();
    expect(uploadMocks.fileUploadSignals[0]?.aborted).toBe(false);

    await act(async () => {
      uploadMocks.fileUpload?.resolve({
        fileId: 'file-1',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
        sha256: 'sha256',
        transport: 'cloud',
        uploadedAt: 0,
      });
      await Promise.resolve();
    });

    mountLanding(WORKSPACE_A_KEY);
    const restored = readHarness().fileItems;
    expect(restored).toHaveLength(1);
    expect(restored[0]!.status).toBe('uploaded');
  });

  it('clears the draft for good once submit or a draft reset releases it', async () => {
    mountLanding(WORKSPACE_A_KEY);
    act(() => {
      readHarness().addImages([pngFile('shot.png')]);
    });
    await act(async () => {
      readHarness().addFiles([textFile('notes.txt')]);
      await uploadMocks.fileUploadStarted?.promise;
    });
    const [image] = readHarness().imageItems;

    act(() => {
      readHarness().clearDraft();
    });

    expect(revokedUrls).toEqual([image!.previewUrl]);
    expect(uploadMocks.fileUploadSignals[0]?.aborted).toBe(true);
    expect(readHarness().imageItems).toEqual([]);
    expect(readHarness().fileItems).toEqual([]);

    unmountLanding();
    mountLanding(WORKSPACE_A_KEY);
    expect(readHarness().imageItems).toEqual([]);
    expect(readHarness().fileItems).toEqual([]);
  });

  it('keeps drafts in different workspaces apart', () => {
    mountLanding(WORKSPACE_A_KEY);
    act(() => {
      readHarness().addImages([pngFile('from-a.png')]);
    });
    const workspaceAItems = readHarness().imageItems;
    const workspaceASessionId = readHarness().sessionId;
    unmountLanding();

    mountLanding(WORKSPACE_B_KEY);
    expect(readHarness().imageItems).toEqual([]);
    expect(readHarness().sessionId).toBeNull();
    unmountLanding();

    mountLanding(WORKSPACE_A_KEY);
    expect(readHarness().imageItems).toEqual(workspaceAItems);
    expect(readHarness().sessionId).toBe(workspaceASessionId);
  });
});
