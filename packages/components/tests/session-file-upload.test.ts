import { createStaticStore, type PlatformProvider } from '@lody/platform';
import { installAttachmentWorkspaceAccess } from '../src/lib/attachment-workspace-access';
import { retainWorkspaceModeProof } from '../src/lib/e2ee-workspace-storage';
import i18next from 'i18next';
import en from '../../../locales/en.json';
import zhCN from '../../../locales/zh_CN.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  uploadSessionFile,
  type SessionFileTransferProgress,
} from '../src/lib/session-file-upload';

type MockXhrOptions = { failFirstAttemptAfterProgress?: boolean };

const installMockXhr = (options: MockXhrOptions = {}) => {
  const sentPartSizes: number[] = [];
  let attempt = 0;

  class MockXmlHttpRequest {
    readonly upload: {
      onprogress: ((event: ProgressEvent) => void) | null;
      onload: (() => void) | null;
    } = { onprogress: null, onload: null };
    responseType = '';
    response: unknown = null;
    status = 0;
    statusText = '';
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    onload: (() => void) | null = null;

    open(): void {}
    setRequestHeader(): void {}
    abort(): void {
      this.onabort?.();
    }

    send(body: Blob): void {
      attempt += 1;
      sentPartSizes.push(body.size);
      const report = (loaded: number) =>
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded,
          total: body.size,
        } as ProgressEvent);
      report(Math.floor(body.size / 2));
      report(body.size);

      if (options.failFirstAttemptAfterProgress && attempt === 1) {
        this.onerror?.();
        return;
      }

      this.status = 200;
      this.response = { etag: `etag-${attempt}` };
      this.onload?.();
    }
  }

  vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);
  return { sentPartSizes };
};

let removeWorkspaceAccess: () => void;
beforeEach(() => {
  retainWorkspaceModeProof(localStorage, 'upload-test', 'workspace', {
    workspaceId: 'workspace-1',
    contentMode: 'plaintext',
    contentModeVersion: 1,
  });
  removeWorkspaceAccess = installAttachmentWorkspaceAccess({
    identity: {
      session: createStaticStore({ status: 'authenticated', user: { id: 'upload-test' } } as never),
      signOut: async () => {},
    },
    e2eeWorkspaces: {} as PlatformProvider['e2eeWorkspaces'],
    workspaces: {
      state: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
      setActive: async () => {},
    },
  });
});

afterEach(() => {
  removeWorkspaceAccess();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('multipart session file progress', () => {
  it('reports byte progress within each part before verification', async () => {
    const { sentPartSizes } = installMockXhr();
    const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'video.mp4', {
      type: 'video/mp4',
    });
    const progress: SessionFileTransferProgress[] = [];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ uploadId: 'upload-1', fileId: 'file-1' }, { status: 201 })
        )
        .mockResolvedValueOnce(
          Response.json({
            file: {
              type: 'file',
              fileId: 'file-1',
              fileName: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              sha256: 'a'.repeat(64),
              textPreview: false,
              transport: 'r2',
              uploadedAt: 1,
            },
          })
        )
    );

    await uploadSessionFile({
      content: { mode: 'plaintext' },
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      token: 'token',
      file,
      sha256: 'a'.repeat(64),
      textPreview: false,
      onProgress: (next) => progress.push(next),
    });

    expect(sentPartSizes).toEqual([16 * 1024 * 1024, 1]);
    const uploading = progress.filter((item) => item.phase === 'uploading');
    expect(uploading.some((item) => item.loadedBytes > 0 && item.loadedBytes < file.size)).toBe(
      true
    );
    expect(uploading.map((item) => item.loadedBytes)).toEqual(
      [...uploading.map((item) => item.loadedBytes)].sort((a, b) => a - b)
    );
    expect(progress.at(-1)).toMatchObject({ phase: 'verifying', percent: 100 });
  });

  it('does not regress or double-count progress when a part retries', async () => {
    installMockXhr({ failFirstAttemptAfterProgress: true });
    const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'retry.mp4');
    const loadedBytes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ uploadId: 'upload-2', fileId: 'file-2' }, { status: 201 })
        )
        .mockResolvedValueOnce(
          Response.json({
            file: {
              type: 'file',
              fileId: 'file-2',
              fileName: file.name,
              mimeType: 'application/octet-stream',
              sizeBytes: file.size,
              sha256: 'b'.repeat(64),
              textPreview: false,
              transport: 'r2',
              uploadedAt: 2,
            },
          })
        )
    );

    await uploadSessionFile({
      content: { mode: 'plaintext' },
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      token: 'token',
      file,
      sha256: 'b'.repeat(64),
      textPreview: false,
      onProgress: (progress) => {
        if (progress.phase === 'uploading') loadedBytes.push(progress.loadedBytes);
      },
    });

    expect(loadedBytes).toEqual([...loadedBytes].sort((a, b) => a - b));
    expect(Math.max(...loadedBytes)).toBe(file.size);
  });
});

describe('multipart response and cancellation', () => {
  it('waits for the response after 100% progress and detaches cancellation after success', async () => {
    const { postMultipartWithProgress } = await import('../src/lib/multipart-upload');
    let request!: ControlledRequest;
    class ControlledRequest {
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      responseType = '';
      response = { imageId: 'uploaded' };
      status = 200;
      aborted = false;
      constructor() {
        request = this;
      }
      open() {}
      setRequestHeader() {}
      send() {}
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', ControlledRequest);
    const controller = new AbortController();
    const progress: number[] = [];
    let settled = false;
    const upload = postMultipartWithProgress({
      url: '/upload',
      token: 'test',
      formData: new FormData(),
      errorLabel: 'Image',
      signal: controller.signal,
      onProgress: (value) => progress.push(value),
    });
    void upload.then(() => {
      settled = true;
    });
    request.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 } as ProgressEvent);
    expect(progress).toEqual([100]);
    expect(settled).toBe(false);
    request.onload?.();
    expect(await upload).toEqual({ imageId: 'uploaded' });
    controller.abort();
    expect(request.aborted).toBe(false);
  });
});

it.each([
  ['en', en, 'e2ee_attachment_requires_preparation'],
  ['zh_CN', zhCN, 'e2ee_attachment_requires_preparation'],
] as const)(
  'explains refused encrypted uploads in %s before any network transfer',
  async (language, translations, message) => {
    await i18next.init({ lng: language, resources: { [language]: { translation: translations } } });
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        constructor() {
          throw new Error('unexpected plaintext transfer');
        }
      }
    );
    await expect(
      uploadSessionFile({
        content: { mode: 'protected' },
        workspaceId: 'workspace-1',
        sessionId: 'session-1' as never,
        token: 'synthetic',
        file: new File(['CANARY-synthetic'], 'CANARY-name.txt'),
        sha256: '00'.repeat(32),
        textPreview: true,
      })
    ).rejects.toThrow(message);
  }
);
