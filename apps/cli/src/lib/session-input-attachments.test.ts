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
import { resolveOrPrepareSessionAttachments } from './session-attachment-reuse';
import { ATTACHMENTS_DIR_RELATIVE, buildAttachmentFileName } from './session-file-attachments';
import { assistantOutputPreview } from '@/orchestration/coordinator-model';
import crypto from 'node:crypto';
import { buildCommandInputBlocks } from './session-input-content';
import { SessionAttachmentTransfer } from './session-attachment-transfer';
import { getSessionFileBlobPath } from './session-file-blob-store';
import { readEncryptedAttachment, type EncryptedAttachment } from '@lody/shared';

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
  it('uploads only opaque encrypted parts and preserves the secret manifest through command input', async () => {
    await fs.writeFile(path.join(root, 'private.txt'), 'synthetic private file');
    const stored = new Map<string, Uint8Array>();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toContain('/session-encrypted-files/upload');
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer attachment-grant');
      expect(headers.get('x-file-name')).toBe('attachment.bin');
      expect(headers.get('x-file-text-preview')).toBe('false');
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      const fileId = `opaque-${stored.size}`;
      stored.set(fileId, bytes);
      expect(Buffer.from(bytes).toString()).not.toContain('synthetic private file');
      return Response.json({
        file: {
          type: 'file',
          fileId,
          fileName: 'attachment.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: bytes.length,
          sha256: headers.get('x-file-sha256'),
          textPreview: false,
          transport: 'r2',
          uploadedAt: 1,
        },
      });
    });
    const blocks = await prepareSessionInputAttachments({
      ...scope,
      paths: ['private.txt'],
      cwd: root,
      relay: new SessionAttachmentTransfer('account-token', 'https://relay.test', {
        token: async () => 'attachment-grant',
      }),
    });
    const [file] = buildCommandInputBlocks('', blocks);
    expect(file).toMatchObject({ type: 'file', fileName: 'private.txt', encryption: { v: 1 } });
    const encryption = (file as { encryption: EncryptedAttachment }).encryption;
    const parts: Uint8Array[] = [];
    for await (const bytes of readEncryptedAttachment({
      ...scope,
      encryption,
      fetchPart: async (id) => new Response(stored.get(id) as Uint8Array<ArrayBuffer>),
    }))
      parts.push(bytes);
    expect(Buffer.concat(parts).toString()).toBe('synthetic private file');
  });
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

  it('rejects transfer to another machine when no relay is available', async () => {
    await expect(
      prepareSessionInputAttachments({
        ...scope,
        targetMachineId: 'remote' as MachineId,
        paths: ['x'],
        cwd: root,
      })
    ).rejects.toThrow('relay');
  });

  it('reuses delegated operation completion attachments and materialized workspace files zero-copy', async () => {
    const childSessionId = 'child-session-1' as SessionId;
    const childTurnId = 'child-assistant-1';
    const childImage = {
      type: 'image' as const,
      imageId: 'img-child-001',
      mimeType: 'image/png',
      fileName: 'result.png',
      sizeBytes: 1234,
      width: 800,
      height: 600,
      transport: 'r2' as const,
    };
    const childVideo = {
      type: 'file' as const,
      fileId: 'file-video-001',
      fileName: 'demo.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      textPreview: false,
      transport: 'r2' as const,
      uploadedAt: 1001,
    };

    const preview = assistantOutputPreview({
      items: [
        { type: 'text', text: 'Recorded demo' },
        { type: 'image_group', images: [{ ...childImage }] },
        childVideo,
      ],
    });
    expect(preview).toEqual({
      text: 'Recorded demo',
      attachments: [
        {
          kind: 'image',
          ref: 'image:img-child-001',
          fileName: 'result.png',
          mimeType: 'image/png',
          sizeBytes: 1234,
          width: 800,
          height: 600,
        },
        {
          kind: 'file',
          ref: 'file:file-video-001',
          fileName: 'demo.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 2048,
        },
      ],
    });

    // Materialized user-uploaded file in caller workspace `.lody/attachments/`
    const userDocBytes = Buffer.from('# Spec Document\n');
    const userDocSha = crypto.createHash('sha256').update(userDocBytes).digest('hex');
    const userFileId = 'file-spec-999';
    const attachmentsDir = path.join(root, ATTACHMENTS_DIR_RELATIVE);
    await fs.mkdir(attachmentsDir, { recursive: true });
    const materializedName = buildAttachmentFileName(userFileId, 'spec.md');
    await fs.writeFile(path.join(attachmentsDir, materializedName), userDocBytes);

    const callerHistory = [
      {
        id: 'user-1',
        role: 'user' as const,
        timestamp: '2026-11-20T00:00:00.000Z',
        items: [
          {
            type: 'file' as const,
            fileId: userFileId,
            fileName: 'spec.md',
            mimeType: 'text/markdown',
            sizeBytes: userDocBytes.length,
            sha256: userDocSha,
            textPreview: true,
            transport: 'r2' as const,
            uploadedAt: 900,
          },
        ],
      },
      {
        id: 'sys-1',
        role: 'system' as const,
        timestamp: '2026-11-20T00:01:00.000Z',
        items: [
          {
            type: 'operation_completion' as const,
            deliveryId: 'delivery-1',
            operationId: 'op-1',
            operationKind: 'session_create' as const,
            completion: {
              type: 'result' as const,
              value: {
                items: [
                  {
                    status: 'succeeded' as const,
                    target: { sessionId: childSessionId, userTurnId: 'child-user-1' },
                    assistantTurnId: childTurnId,
                    output: preview,
                  },
                ],
              },
            },
          },
        ],
      },
    ];

    const fetchSpy = vi.fn(async () => {
      throw new Error('Zero-copy attachment reuse must not call fetch/upload');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const reused = await resolveOrPrepareSessionAttachments({
      inputs: [
        'image:img-child-001',
        'file:file-video-001',
        path.join(ATTACHMENTS_DIR_RELATIVE, materializedName),
      ],
      cwd: root,
      containWithin: root,
      workspaceId: scope.workspaceId,
      callerSessionId: scope.sessionId,
      targetSessionId: 'target-session-2' as SessionId,
      sourceMachineId: scope.sourceMachineId,
      targetMachineId: 'remote-machine' as MachineId,
      relay: new SessionAttachmentTransfer('token', 'https://relay.invalid'),
      readCallerHistory: async () => callerHistory,
      readDelegatedTurn: async (sid, tid) =>
        sid === childSessionId && tid === childTurnId
          ? {
              id: childTurnId,
              role: 'assistant',
              timestamp: '2026-11-20T00:00:30.000Z',
              items: [childImage, childVideo],
            }
          : undefined,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reused).toEqual([
      { ...childImage, storageSessionId: childSessionId },
      { ...childVideo, storageSessionId: childSessionId },
      {
        type: 'file',
        fileId: userFileId,
        fileName: 'spec.md',
        mimeType: 'text/markdown',
        sizeBytes: userDocBytes.length,
        sha256: userDocSha,
        textPreview: true,
        transport: 'r2',
        uploadedAt: 900,
        storageSessionId: scope.sessionId,
      },
    ]);

    // Unknown attachment references outside caller history / delegated receipts are rejected.
    await expect(
      resolveOrPrepareSessionAttachments({
        inputs: ['image:unknown-session-image'],
        cwd: root,
        containWithin: root,
        workspaceId: scope.workspaceId,
        callerSessionId: scope.sessionId,
        targetSessionId: 'target-session-2' as SessionId,
        sourceMachineId: scope.sourceMachineId,
        targetMachineId: scope.targetMachineId,
        readCallerHistory: async () => callerHistory,
        readDelegatedTurn: async () => undefined,
      })
    ).rejects.toThrow('Attachment reference not found');
  });
});
