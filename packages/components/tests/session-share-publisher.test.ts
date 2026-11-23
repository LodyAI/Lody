import { it, expect, vi } from 'vitest';
import { uploadEncryptedAttachment, SESSION_IMAGE_MAX_SIZE_BYTES } from '@lody/shared';
import { decodeShareHistoryBytes } from '@lody/shared/session-sharing';
import { captureSessionShare } from '../src/lib/session-share-publisher';
vi.mock('@/lib', () => ({ API_BASE_URL: 'https://api.example.test' }));

it('waits for content admission before detaching a plaintext share package', async () => {
  const mode = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  let sourceRead = false;
  const capturing = captureSessionShare({
    runtime: {
      workspaceId: 'workspace',
      contentMode: 'plaintext',
      waitForContentAdmission: () => {
        waiting.resolve();
        return mode.promise;
      },
      prepareSessionTarget: async () => {},
      acquireSessionStore: async () => {
        sourceRead = true;
        return {
          sessionId: 'root',
          firstSynced: Promise.resolve(),
          acquireSync: () => () => {},
          sessionData: {
            history: {
              readAll: async () => [
                {
                  id: 'turn',
                  role: 'user',
                  items: [{ type: 'text', text: 'C1 private share sentinel' }],
                },
              ],
            },
          },
        };
      },
      releaseSessionStoreRef: () => {},
    },
    sessions: [{ id: 'root', title: 'Private title' }],
    rootSessionId: 'root',
    token: 'test',
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof captureSessionShare>[0]);
  try {
    await Promise.race([waiting.promise, capturing]);
    expect(sourceRead).toBe(false);
    mode.resolve();
    const result = await capturing;
    expect(result.manifest.conversations[0]?.title).toBe('Private title');
  } finally {
    mode.resolve();
    await capturing;
  }
});

it.each(['plaintext', 'e2ee'] as const)(
  'captures %s sources through the same package path and releases all leases',
  async (contentMode) => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const released: string[] = [],
      syncReleased: string[] = [];
    let acquired = 0;
    const runtime = {
      contentMode,
      workspaceId: 'workspace',
      prepareSessionTarget: async () => {},
      acquireSessionStore: async (id: string) => {
        acquired++;
        if (acquired === 4) release();
        // The first finishes after the others, reproducing completion-order bugs.
        if (id === 's0') await ready;
        return {
          sessionId: id,
          firstSynced: Promise.resolve(),
          acquireSync: () => () => syncReleased.push(id),
          sessionData: {
            history: {
              readAll: async () => [
                { id: 't', role: 'assistant', items: [{ type: 'text', text: id.repeat(1000) }] },
              ],
            },
          },
        };
      },
      releaseSessionStoreRef: (id: string) => released.push(id),
    };
    const result = await captureSessionShare({
      runtime,
      sessions: Array.from({ length: 4 }, (_, i) => ({
        id: `s${i}`,
        title: `Title ${i}`,
        machineId: 'machine',
      })),
      rootSessionId: 's0',
      token: 'test',
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof captureSessionShare>[0]);
    for (const [i, conversation] of result.manifest.conversations.entries()) {
      expect(conversation.title).toBe(`Title ${i}`);
      const descriptor = result.manifest.objects.find(
        (o) => o.id === conversation.historyObjectId
      )!;
      const bytes = decodeShareHistoryBytes(result.objects.get(descriptor.id)!, descriptor);
      expect(JSON.parse(new TextDecoder().decode(bytes))[0].items[0].text).toBe(
        `s${i}`.repeat(1000)
      );
    }
    expect(released.sort()).toEqual(['s0', 's1', 's2', 's3']);
    expect(syncReleased.sort()).toEqual(released);
  }
);

it('reports image download failures and still releases the source', async () => {
  const release = vi.fn();
  const releaseSync = vi.fn();
  const runtime = {
    workspaceId: 'workspace',
    prepareSessionTarget: async () => {},
    acquireSessionStore: async () => ({
      sessionId: 'root',
      firstSynced: Promise.resolve(),
      acquireSync: () => releaseSync,
      sessionData: {
        history: {
          readAll: async () => [
            { id: 'turn', role: 'user', items: [{ type: 'image', imageId: 'image' }] },
          ],
        },
      },
    }),
    releaseSessionStoreRef: release,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Missing', { status: 404 })));
  try {
    await expect(
      captureSessionShare({
        runtime,
        sessions: [{ id: 'root', title: 'Root', machineId: 'machine' }],
        rootSessionId: 'root',
        token: 'test',
        signal: new AbortController().signal,
      } as unknown as Parameters<typeof captureSessionShare>[0])
    ).rejects.toThrow('Share attachment unavailable');
    expect(release).toHaveBeenCalledWith('root');
    expect(releaseSync).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(['success', 'image-group', 'oversized', 'missing-manifest', 'tampered'])(
  'reads protected share image bytes: %s',
  async (scenario) => {
    const plain = new Uint8Array([1, 2, 3]);
    let sealed: Uint8Array = new Uint8Array();
    const { encryption } = await uploadEncryptedAttachment({
      workspaceId: 'workspace',
      sessionId: 'original',
      kind: 'image',
      fileName: 'private.png',
      mimeType: 'image/png',
      sizeBytes: plain.length,
      read: async () => plain.slice(),
      upload: async (bytes) => {
        sealed = bytes;
        return 'ciphertext';
      },
    });
    if (scenario === 'tampered') sealed[0] ^= 1;
    if (scenario === 'oversized') encryption.sizeBytes = SESSION_IMAGE_MAX_SIZE_BYTES + 1;
    const image = {
      type: 'image',
      imageId: 'ciphertext',
      storageSessionId: 'original',
      fileName: 'private.png',
      mimeType: 'image/png',
      sizeBytes: plain.length,
      ...(scenario === 'missing-manifest' ? {} : { encryption }),
    };
    const items = [
      ...(scenario === 'image-group' ? [{ type: 'image_group', images: [image] }] : [image]),
      { type: 'image', encryption },
      {
        type: 'tool_call',
        toolCallId: 'tool',
        rawInput: { nested: [{ encryption }] },
        rawOutput: { encryption },
        _meta: { hidden: { encryption } },
      },
      { type: 'system_notice', name: 'synthetic', meta: { nested: [{ encryption }] } },
    ];
    const runtime = {
      workspaceId: 'workspace',
      contentMode: 'e2ee',
      attachmentToken: async () => 'attachment-grant',
      prepareSessionTarget: async () => {},
      acquireSessionStore: async () => ({
        sessionId: 'root',
        firstSynced: Promise.resolve(),
        acquireSync: () => () => {},
        sessionData: {
          history: { readAll: async () => [{ id: 'turn', role: 'user', items }] },
        },
      }),
      releaseSessionStoreRef: () => {},
    };
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      requests.push(String(url));
      if (scenario === 'oversized' || scenario === 'missing-manifest')
        throw new Error('Unexpected attachment request');
      expect(String(url)).toContain('/session-encrypted-images/original/ciphertext');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer attachment-grant');
      return new Response(sealed as Uint8Array<ArrayBuffer>);
    });
    try {
      const capturing = captureSessionShare({
        runtime,
        sessions: [{ id: 'root' }],
        rootSessionId: 'root',
        token: 'ordinary-token',
        signal: new AbortController().signal,
      } as unknown as Parameters<typeof captureSessionShare>[0]);
      if (scenario !== 'success' && scenario !== 'image-group') {
        await expect(capturing).rejects.toThrow(
          scenario === 'oversized'
            ? 'Share image exceeds size limit'
            : 'Share attachment unavailable'
        );
        if (scenario !== 'tampered') expect(requests).toEqual([]);
        return;
      }
      const result = await capturing;
      const attachment = result.manifest.objects.find((object) => object.id === 'a1')!;
      expect(attachment.mediaType).toBe('image/png');
      expect(result.objects.get('a1')).toEqual(plain);
      const history = result.manifest.objects.find((object) => object.id === 'h1')!;
      const captured = JSON.parse(
        new TextDecoder().decode(decodeShareHistoryBytes(result.objects.get('h1')!, history))
      );
      const capturedImage =
        scenario === 'image-group' ? captured[0].items[0].images[0] : captured[0].items[0];
      expect(capturedImage).toMatchObject({ imageId: 'a1', mimeType: 'image/png' });
      const assertClean = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        expect(value).not.toHaveProperty('encryption');
        for (const child of Object.values(value)) assertClean(child);
      };
      assertClean(captured);
      expect(JSON.stringify(captured)).not.toContain(encryption.key);
      expect(image.encryption).toBe(encryption);
    } finally {
      vi.unstubAllGlobals();
    }
  }
);
