import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  type MachineId,
  type SessionId,
  type WorkspaceId,
  type SessionFilePayload,
} from '@lody/shared';
import { prepareSessionInputAttachments } from './session-input-attachments';
import { buildCommandInputBlocks } from './session-input-content';
import { SessionAttachmentTransfer } from './session-attachment-transfer';
import { getSessionFileBlobPath } from './session-file-blob-store';

let root: string;
const scope = {
  workspaceId: 'workspace' as WorkspaceId,
  sessionId: 'target' as SessionId,
  sourceMachineId: 'source' as MachineId,
  targetMachineId: 'source' as MachineId,
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'input-attachment-test-'));
  vi.stubEnv('LODY_DATA_DIR', path.join(root, 'state'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('session input attachment preparation', () => {
  it('freezes local bytes, supports attachment-only input, and never uses the target cwd', async () => {
    await fs.writeFile(path.join(root, 'report.txt'), 'original');
    const blocks = await prepareSessionInputAttachments({
      ...scope,
      paths: ['report.txt'],
      cwd: root,
    });
    await fs.writeFile(path.join(root, 'report.txt'), 'changed');
    const file = blocks[0] as SessionFilePayload;
    expect(file).toMatchObject({
      type: 'file',
      transport: 'local',
      machineId: 'source',
      fileName: 'report.txt',
      sizeBytes: 8,
    });
    expect(
      await fs.readFile(getSessionFileBlobPath({ ...scope, fileId: file.fileId }), 'utf8')
    ).toBe('original');
    expect(file.sha256).toBe(createHash('sha256').update('original').digest('hex'));
    expect(buildCommandInputBlocks('', blocks)).toEqual(blocks);
  });

  it('checks all sources before any upload and rejects escaped paths and symlinks', async () => {
    await fs.writeFile(path.join(root, 'valid.txt'), 'valid');
    const relay = new SessionAttachmentTransfer('token', 'https://relay.invalid');
    vi.stubGlobal('fetch', () => {
      throw new Error('Unexpected transfer before source validation');
    });
    await expect(
      prepareSessionInputAttachments({
        ...scope,
        paths: ['valid.txt', 'missing'],
        cwd: root,
        relay,
      })
    ).rejects.toThrow('ENOENT');
    const inside = path.join(root, 'inside');
    await fs.mkdir(inside);
    await fs.symlink(path.join(root, 'valid.txt'), path.join(inside, 'escape.txt'));
    await expect(
      prepareSessionInputAttachments({
        ...scope,
        paths: ['../valid.txt'],
        cwd: inside,
        containWithin: inside,
      })
    ).rejects.toThrow('outside');
    await expect(
      prepareSessionInputAttachments({
        ...scope,
        paths: ['escape.txt'],
        cwd: inside,
        containWithin: inside,
      })
    ).rejects.toThrow();
    expect(await fs.readdir(inside)).toEqual(['escape.txt']);
  });

  it('transfers frozen snapshots to a different machine and retains ordered input references', async () => {
    await fs.writeFile(path.join(root, 'one.txt'), 'one');
    await fs.writeFile(path.join(root, 'two.txt'), 'two');
    const received: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = Buffer.from(init.body as Uint8Array);
      received.push(body.toString());
      await fs.writeFile(path.join(root, 'two.txt'), 'mutated after preparation');
      return Response.json({
        success: true,
        file: {
          type: 'file',
          fileId: 'file-' + received.length,
          fileName: received.length === 1 ? 'one.txt' : 'two.txt',
          mimeType: 'text/plain',
          sizeBytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          textPreview: true,
          transport: 'r2',
          uploadedAt: 1,
        },
      });
    });
    const blocks = await prepareSessionInputAttachments({
      ...scope,
      targetMachineId: 'remote' as MachineId,
      paths: ['one.txt', 'two.txt'],
      cwd: root,
      relay: new SessionAttachmentTransfer('token', 'https://relay.invalid'),
    });
    expect(received).toEqual(['one', 'two']);
    expect(buildCommandInputBlocks('analyze', blocks)).toEqual([
      { type: 'text', text: 'analyze' },
      ...blocks,
    ]);
    expect(blocks.map((block) => block.type === 'file' && block.fileId)).toEqual([
      'file-1',
      'file-2',
    ]);
    expect(JSON.stringify(blocks)).not.toContain(root);
  });

  it('routes supported images to visual input and keeps relay failure fatal', async () => {
    await fs.writeFile(path.join(root, 'screen.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    let imageBytes: Uint8Array | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      const file = body.get('file') as File;
      imageBytes = new Uint8Array(await file.arrayBuffer());
      expect(body.get('sessionId')).toBe('target');
      return Response.json({
        success: true,
        image: {
          type: 'image',
          imageId: 'image-1',
          fileName: 'screen.png',
          mimeType: 'image/png',
          sizeBytes: 8,
        },
      });
    });
    const args = {
      ...scope,
      paths: ['screen.png'],
      cwd: root,
      relay: new SessionAttachmentTransfer('token', 'https://relay.invalid'),
    };
    expect(await prepareSessionInputAttachments(args)).toEqual([
      {
        type: 'image',
        imageId: 'image-1',
        fileName: 'screen.png',
        mimeType: 'image/png',
        sizeBytes: 8,
      },
    ]);
    expect(Buffer.from(imageBytes!).toString('hex')).toBe('89504e470d0a1a0a');
    vi.stubGlobal('fetch', async () => new Response('unavailable', { status: 503 }));
    await expect(prepareSessionInputAttachments(args)).rejects.toThrow('screen.png');
  });

  it('rejects remote local-only transfer, empty input, directories, and too many files', async () => {
    await expect(
      prepareSessionInputAttachments({
        ...scope,
        targetMachineId: 'remote' as MachineId,
        paths: ['x'],
        cwd: root,
      })
    ).rejects.toThrow('relay');
    expect(() => buildCommandInputBlocks('')).toThrow('text');
    await expect(
      prepareSessionInputAttachments({ ...scope, paths: ['.'], cwd: root })
    ).rejects.toThrow('regular file');
    await expect(
      prepareSessionInputAttachments({ ...scope, paths: Array(9).fill('x'), cwd: root })
    ).rejects.toThrow('8');
  });
});
