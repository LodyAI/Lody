import { describe, expect, it, vi } from 'vitest';

import { downloadSessionImageAsPromptBlock } from './session-image-download';

const baseArgs = {
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  imageId: 'image-1',
  expectedMimeType: 'image/png',
  serverBaseUrl: 'https://api.example.test',
  token: 'token-1',
};

describe('downloadSessionImageAsPromptBlock', () => {
  it('cancels the active download without retrying it', async () => {
    const controller = new AbortController();
    const download = downloadSessionImageAsPromptBlock({
      ...baseArgs,
      signal: controller.signal,
      fetchImpl: (async (_url, options) =>
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        })) as typeof fetch,
      sleep: async () => {
        throw new Error('Cancelled downloads must not retry');
      },
    });
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retries transient network failures before returning an ACP image block', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('ECONNRESET') }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'image/png' },
        })
      );
    const sleeps: number[] = [];

    const block = await downloadSessionImageAsPromptBlock({
      ...baseArgs,
      fetchImpl: fetchMock as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([250]);
    expect(block).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]).toString('base64'),
    });
  });

  it('honors Retry-After for retryable HTTP failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('warming up', {
          status: 503,
          headers: { 'Retry-After': '1' },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([4, 5, 6]), {
          headers: { 'Content-Type': 'image/jpeg; charset=utf-8' },
        })
      );
    const sleeps: number[] = [];

    const block = await downloadSessionImageAsPromptBlock({
      ...baseArgs,
      expectedMimeType: 'image/jpeg',
      fetchImpl: fetchMock as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
    expect(block).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('does not retry non-retryable HTTP failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('no access', { status: 401 }));

    await expect(
      downloadSessionImageAsPromptBlock({
        ...baseArgs,
        fetchImpl: fetchMock as typeof fetch,
        sleep: async () => {},
      })
    ).rejects.toThrow('Failed to download image image-1 (401): no access');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the underlying network cause after retries are exhausted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new Error('proxy refused connection'),
      })
    );

    await expect(
      downloadSessionImageAsPromptBlock({
        ...baseArgs,
        fetchImpl: fetchMock as typeof fetch,
        sleep: async () => {},
      })
    ).rejects.toThrow(
      'Failed to download image image-1 after 4 attempts: fetch failed: proxy refused connection'
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
