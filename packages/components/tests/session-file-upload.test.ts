import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_FILE_HASH_CHUNK_SIZE_BYTES,
  computeSha256HexInChunks,
  isSessionFileTransferPhase,
  uploadSessionFile,
  type SessionFileTransferProgress,
} from '../src/lib/session-file-upload';

class TrackingBlob extends Blob {
  readonly sliceSizes: number[] = [];

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.sliceSizes.push((end ?? this.size) - (start ?? 0));
    return super.slice(start, end, contentType);
  }
}

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('session file preparation', () => {
  it('hashes the file in bounded chunks and reports monotonic preparation progress', async () => {
    const bytes = new TextEncoder().encode('abc');
    const blob = new TrackingBlob([bytes]);
    const progress: SessionFileTransferProgress[] = [];

    await expect(
      computeSha256HexInChunks(blob, { onProgress: (next) => progress.push(next) })
    ).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    expect(blob.sliceSizes).toEqual([bytes.length]);
    expect(progress.map((item) => item.phase)).toEqual(['preparing', 'preparing']);
    expect(progress.map((item) => item.percent)).toEqual([0, 100]);
  });

  it('never reads more than the configured chunk size', async () => {
    const blob = new TrackingBlob([new Uint8Array(SESSION_FILE_HASH_CHUNK_SIZE_BYTES * 2 + 17)]);
    await computeSha256HexInChunks(blob);

    expect(blob.sliceSizes).toEqual([
      SESSION_FILE_HASH_CHUNK_SIZE_BYTES,
      SESSION_FILE_HASH_CHUNK_SIZE_BYTES,
      17,
    ]);
  });

  it('aborts between chunks', async () => {
    const controller = new AbortController();
    const blob = new TrackingBlob([new Uint8Array(SESSION_FILE_HASH_CHUNK_SIZE_BYTES + 1)]);

    const promise = computeSha256HexInChunks(blob, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.loadedBytes > 0) controller.abort();
      },
    });

    await expect(promise).rejects.toMatchObject({ name: 'UploadAbortedError' });
  });

  it('recognizes every blocking transfer phase', () => {
    expect(['preparing', 'uploading', 'verifying'].every(isSessionFileTransferPhase)).toBe(true);
    expect(isSessionFileTransferPhase('uploaded')).toBe(false);
    expect(isSessionFileTransferPhase('failed')).toBe(false);
  });
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
    expect(request.upload.onprogress).toBeNull();
  });

  it('aborts the actual request and rejects without retaining callbacks', async () => {
    const { postMultipartWithProgress } = await import('../src/lib/multipart-upload');
    let request!: ControlledRequest;
    class ControlledRequest {
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
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
    const upload = postMultipartWithProgress({
      url: '/upload',
      token: 'test',
      formData: new FormData(),
      errorLabel: 'Image',
      signal: controller.signal,
    });
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.aborted).toBe(true);
    expect([request.onload, request.onerror, request.onabort, request.upload.onprogress]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
