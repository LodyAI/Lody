import { describe, expect, it } from 'vitest';

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
});
