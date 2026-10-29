import { describe, expect, it, vi } from 'vitest';

import { downloadSessionImageAsPromptBlock } from './session-image-download';
import { uploadEncryptedAttachment } from '@lody/shared';

const baseArgs = {
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  imageId: 'image-1',
  expectedMimeType: 'image/png',
  serverBaseUrl: 'https://api.example.test',
  token: 'token-1',
};

describe('downloadSessionImageAsPromptBlock', () => {
  it('authenticates encrypted image bytes before creating an ACP image block', async () => {
    const objects = new Map<string, Uint8Array>();
    const { encryption } = await uploadEncryptedAttachment({
      ...baseArgs,
      kind: 'image',
      fileName: 'private.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      read: async () => new Uint8Array([1, 2, 3]),
      upload: async (bytes) => {
        objects.set('ciphertext', bytes);
        return 'ciphertext';
      },
    });
    const result = await downloadSessionImageAsPromptBlock({
      ...baseArgs,
      imageId: 'ciphertext',
      encryption,
      attachmentToken: async () => 'attachment-grant',
      fetchImpl: async (url, init) => {
        expect(String(url)).toContain('/session-encrypted-images/session-1/ciphertext');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer attachment-grant');
        return new Response(objects.get('ciphertext') as Uint8Array<ArrayBuffer>);
      },
    });
    expect(result).toEqual({ type: 'image', data: 'AQID', mimeType: 'image/png' });
  });
  it('rejects stored file manifests on the image path before fetching or allocating image bytes', async () => {
    const { encryption } = await uploadEncryptedAttachment({
      ...baseArgs,
      kind: 'file',
      fileName: 'private',
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
      read: async () => new Uint8Array([1]),
      upload: async () => 'image-1',
    });
    await expect(
      downloadSessionImageAsPromptBlock({
        ...baseArgs,
        encryption,
        attachmentToken: async () => {
          throw new Error('grant must not be requested');
        },
        fetchImpl: async () => {
          throw new Error('body must not be fetched');
        },
      })
    ).rejects.toThrow('Encrypted image reference mismatch');
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
