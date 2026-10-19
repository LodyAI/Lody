import { describe, expect, it, vi } from 'vitest';
import { sessionFileOpenResultToContentLoadResult } from '../src/lib/session-file-content-snapshot';

import {
  LocalProjectRpcFileProvider,
  type LocalProjectFileTransport,
} from '../src/lib/local-project-rpc-file-provider';

function createTransport(
  overrides: Partial<LocalProjectFileTransport> = {}
): LocalProjectFileTransport {
  return {
    listDir: vi.fn(async () => ({ entries: [], truncated: false })),
    listFiles: vi.fn(async () => ({ paths: [], truncated: false })),
    readFile: vi.fn(async () => null),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) {
    throw new Error('Failed to create deferred promise.');
  }
  return { promise, resolve };
}

describe('LocalProjectRpcFileProvider', () => {
  it('emits after lazy directory load failures without degrading the root provider', async () => {
    const transport = createTransport({
      listDir: vi.fn(async ({ relativePath }) => {
        if (!relativePath) {
          return { entries: [{ name: 'src', type: 'directory' }], truncated: false };
        }
        throw new Error('directory denied');
      }),
    });
    const provider = new LocalProjectRpcFileProvider({ transport });

    await provider.listFiles();
    const subscriber = vi.fn();
    provider.subscribeFiles(subscriber);

    await expect(provider.initializeDirectory('src')).rejects.toThrow('directory denied');

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(provider.getState()).toMatchObject({
      ready: true,
      sourceState: 'live-readonly',
    });
  });

  it('dedupes concurrent loads for the same directory', async () => {
    const pending = deferred<{ entries: []; truncated: false }>();
    const listDir = vi.fn(() => pending.promise);
    const provider = new LocalProjectRpcFileProvider({
      transport: createTransport({ listDir }),
    });

    const first = provider.initializeDirectory('');
    const second = provider.initializeDirectory('');

    expect(listDir).toHaveBeenCalledTimes(1);
    pending.resolve({ entries: [], truncated: false });
    await Promise.all([first, second]);
  });
});

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('LocalProjectRpcFileProvider.openFile (images)', () => {
  it('decodes base64 image reads into a binary snapshot with exact bytes', async () => {
    const provider = new LocalProjectRpcFileProvider({
      transport: createTransport({
        readFile: vi.fn(async ({ relativePath }) => ({
          path: relativePath,
          content: toBase64(pngBytes),
          truncated: false,
          encoding: 'base64' as const,
        })),
      }),
    });

    const result = await provider.openFile('assets/logo.png');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.snapshot.kind).toBe('binary');
    if (result.snapshot.kind !== 'binary') return;
    expect(result.snapshot.bytes && Array.from(result.snapshot.bytes)).toEqual(
      Array.from(pngBytes)
    );
  });

  it('requests a larger byte budget for images than for text', async () => {
    const requestedMaxBytes: Record<string, number | undefined> = {};
    const provider = new LocalProjectRpcFileProvider({
      transport: createTransport({
        readFile: vi.fn(async ({ relativePath, maxBytes }) => {
          requestedMaxBytes[relativePath] = maxBytes;
          return { path: relativePath, content: '', truncated: false, encoding: 'utf8' as const };
        }),
      }),
    });

    await provider.openFile('assets/logo.png');
    await provider.openFile('src/index.ts');
    expect(requestedMaxBytes['assets/logo.png']).toBeGreaterThan(
      requestedMaxBytes['src/index.ts'] ?? 0
    );
  });

  it('omits bytes for a truncated (too-large) image so callers can show a notice', async () => {
    const provider = new LocalProjectRpcFileProvider({
      transport: createTransport({
        readFile: vi.fn(async ({ relativePath }) => ({
          path: relativePath,
          content: toBase64(pngBytes),
          truncated: true,
          encoding: 'base64' as const,
        })),
      }),
    });

    const result = await provider.openFile('assets/huge.png');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.snapshot.kind).toBe('binary');
    if (result.snapshot.kind !== 'binary') return;
    expect(result.snapshot.bytes).toBeUndefined();
  });

  it('retains truncated text through the provider and viewer conversion', async () => {
    const provider = new LocalProjectRpcFileProvider({
      transport: createTransport({
        readFile: async () => ({
          path: 'large.html',
          content: '<h1>Partial',
          truncated: true,
          encoding: 'utf8',
        }),
      }),
    });
    const result = await provider.openFile('large.html');
    expect(result).toMatchObject({
      status: 'ready',
      snapshot: { kind: 'text', text: '<h1>Partial', truncated: true },
    });
    expect(sessionFileOpenResultToContentLoadResult(result)).toEqual({
      status: 'ready',
      snapshot: { kind: 'text', text: '<h1>Partial', truncated: true },
    });
  });

  it('returns a text snapshot for utf8 reads', async () => {
    const provider = new LocalProjectRpcFileProvider({
      transport: createTransport({
        readFile: vi.fn(async ({ relativePath }) => ({
          path: relativePath,
          content: 'hello world',
          truncated: false,
          encoding: 'utf8' as const,
        })),
      }),
    });

    const result = await provider.openFile('notes.md');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.snapshot.kind).toBe('text');
    if (result.snapshot.kind !== 'text') return;
    expect(result.snapshot.text).toBe('hello world');
  });
});
