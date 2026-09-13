import { describe, expect, it, vi } from 'vitest';
import {
  openStaticShare,
  readShareResponseBytes,
  uploadPreparedShare,
} from '../src/session-share-client';
import { prepareSharePackage } from '../src/session-share-export';

const origin = 'https://api.example.test';
const secret = 'a'.repeat(64);
it('rejects file uploads before making any network request', async () => {
  const prepared = await prepareSharePackage({
    rootSourceId: 'root',
    capturedAt: '2026-09-12T00:00:00.000Z',
    fileAttachmentsEnabled: true,
    conversations: [
      {
        sourceId: 'root',
        title: '',
        history: [
          {
            id: 'm',
            role: 'user',
            items: [{ type: 'file', fileId: 'file', fileName: 'report.txt' }],
          },
        ],
      },
    ],
    readAttachment: async () => ({ bytes: new Uint8Array([1]), mediaType: 'text/plain' }),
  });
  const fetch = vi.fn();
  await expect(
    uploadPreparedShare({ origin, deploymentId: 'deployment', secret, prepared, fetch })
  ).rejects.toThrow('share_file_attachments_disabled');
  expect(fetch).not.toHaveBeenCalled();
});
async function fixture() {
  return prepareSharePackage({
    rootSourceId: 'source-root',
    capturedAt: '2026-09-12T00:00:00.000Z',
    conversations: [
      {
        sourceId: 'source-root',
        title: 'Published',
        history: [
          { id: 'm1', role: 'assistant', items: [{ type: 'text', text: 'Frozen text' }] },
          { id: 'm2', role: 'system', futureField: { opaque: true } },
        ],
      },
    ],
    readAttachment: async () => {
      throw new Error('Unexpected source read');
    },
  });
}

describe('static share client', () => {
  it('resolves once and pins all subsequent reads without workspace credentials', async () => {
    const prepared = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init).toMatchObject({
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect([...new Headers(init?.headers)]).toEqual([['authorization', `Bearer ${secret}`]]);
      if (String(input) === `${origin}/api/shares/share`) {
        return Response.json({
          shareId: 'share',
          deploymentId: 'version1',
          manifest: prepared.manifest,
        });
      }
      expect(String(input)).toBe(`${origin}/api/shares/share/deployments/version1/objects/h1`);
      return new Response(prepared.objects.get('h1')!.slice().buffer);
    });
    const share = await openStaticShare({ origin, shareId: 'share', secret, fetch: fetcher });
    const first = await share.readHistory('c1');
    expect(first[0]?.items?.[0]?.text).toBe('Frozen text');
    expect(first[1]).toEqual({ id: 'm2', role: 'system', futureField: { opaque: true } });
    expect(await share.readHistory('c1')).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(share.readHistory('source-root')).rejects.toThrow('unavailable');
    await expect(share.readObject('../source')).rejects.toThrow('unavailable');
    await expect(share.readAttachment('source-file')).rejects.toThrow('unavailable');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects corrupted bytes, even when the response length matches', async () => {
    const prepared = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/share')
        ? Response.json({ shareId: 'share', deploymentId: 'version1', manifest: prepared.manifest })
        : new Response(new Uint8Array(prepared.objects.get('h1')!.length))
    );
    const share = await openStaticShare({ origin, shareId: 'share', secret, fetch: fetcher });
    await expect(share.readHistory('c1')).rejects.toThrow('Invalid share object');
  });

  it('cancels one conversation read without invalidating the deployment handle', async () => {
    const prepared = await fixture();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/share'))
        return Response.json({
          shareId: 'share',
          deploymentId: 'version1',
          manifest: prepared.manifest,
        });
      if (++reads > 1) return new Response(prepared.objects.get('h1')!.slice().buffer);
      return new Response(
        new ReadableStream({
          start(controller) {
            init!.signal!.addEventListener('abort', () => controller.error(new Error('Aborted')), {
              once: true,
            });
            started();
          },
        })
      );
    });
    const share = await openStaticShare({ origin, shareId: 'share', secret, fetch: fetcher });
    const abort = new AbortController();
    const read = share.readHistory('c1', abort.signal);
    await waiting;
    abort.abort();
    await expect(read).rejects.toThrow('Share object read failed');
    expect((await share.readHistory('c1'))[0]?.id).toBe('m1');
  });

  it('honors lifetime and already-cancelled per-read signals before network I/O', async () => {
    const prepared = await fixture();
    const lifetime = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ shareId: 'share', deploymentId: 'version1', manifest: prepared.manifest })
    );
    const share = await openStaticShare({
      origin,
      shareId: 'share',
      secret,
      signal: lifetime.signal,
      fetch: fetcher,
    });
    await expect(share.readHistory('c1', AbortSignal.abort())).rejects.toThrow();
    lifetime.abort();
    await expect(share.readHistory('c1')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects arbitrary origins, credentials and returned identities', async () => {
    const prepared = await fixture();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ shareId: 'different', deploymentId: 'version1', manifest: prepared.manifest })
    );
    for (const invalid of [
      'http://api.example.test',
      'https://user:pass@api.example.test',
      `${origin}/source`,
      `${origin}?token=secret`,
    ]) {
      await expect(
        openStaticShare({ origin: invalid, shareId: 'share', secret, fetch: fetcher })
      ).rejects.toThrow('origin');
    }
    await expect(
      openStaticShare({ origin, shareId: 'share', secret: 'workspace-token', fetch: fetcher })
    ).rejects.toThrow('credential');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      openStaticShare({ origin, shareId: 'share', secret, fetch: fetcher })
    ).rejects.toThrow('identity');
  });

  it('bounds streamed bodies even without Content-Length and cancels overflow', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
        },
        cancel,
      })
    );
    await expect(readShareResponseBytes(response, 5)).rejects.toThrow('read failed');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uploads checked inventory before sealing and never publishes', async () => {
    const prepared = await fixture();
    const requests: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(`${init?.method} ${input}`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
      expect(new Headers(init?.headers).get('content-type')).toBe(
        init?.method === 'PUT' ? 'application/octet-stream' : 'application/json'
      );
      return new Response(null, { status: 204 });
    });
    await uploadPreparedShare({
      origin,
      deploymentId: 'version1',
      secret,
      prepared,
      fetch: fetcher,
    });
    expect(requests).toEqual([
      `PUT ${origin}/api/share-deployments/version1/objects/h1`,
      `POST ${origin}/api/share-deployments/version1/seal`,
    ]);
    fetcher.mockClear();
    prepared.objects.get('h1')![0] = 0;
    await expect(
      uploadPreparedShare({ origin, deploymentId: 'version1', secret, prepared, fetch: fetcher })
    ).rejects.toThrow('Invalid share object');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
