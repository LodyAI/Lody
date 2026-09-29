import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, SessionInputBlock, WorkspaceId } from '@lody/shared';
import type { ContentBlock } from '@agentclientprotocol/sdk';

import { MessageHandler } from '../src/lib/message-handler';
import {
  ATTACHMENTS_DIR_RELATIVE,
  buildAttachmentFileName,
} from '../src/lib/session-file-attachments';
import type { DownloadedSessionImagePromptBlock } from '../src/lib/session-image-download';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type PromptBlockBuilder = {
  buildAcpPromptBlocks: (args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    inputBlocks: SessionInputBlock[];
  }) => Promise<ContentBlock[]>;
  fetchSessionImageForPrompt: (args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    imageId: string;
    expectedMimeType: string;
  }) => Promise<DownloadedSessionImagePromptBlock>;
};

const createPromptHandler = (args: {
  workspaceRoot: string;
  workspaceId: WorkspaceId;
}): MessageHandler & PromptBlockBuilder => {
  const sessionManager = {
    getSession: vi.fn(() => ({
      getHostWorkdir: () => args.workspaceRoot,
      getWorkdir: () => args.workspaceRoot,
    })),
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    cleanUp: vi.fn(async () => {}),
  } as unknown as SessionManager;
  const workspaceDocument = {
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
    repo: {
      getDocMeta: vi.fn(async () => ({ meta: {} })),
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
    },
    getOrCreateSessionDoc: vi.fn(),
    sendMachineHeartbeat: vi.fn(async () => {}),
  } as unknown as LoroDocumentManager;
  const handler = new MessageHandler(sessionManager, workspaceDocument, createSilentLogger(), {
    token: 'token',
    workspaceId: args.workspaceId,
    userId: 'user-1',
    machineId: 'machine-1',
    machineName: 'machine',
    cliVersion: '0.0.0',
    cloudPort: createTestCloudPort(),
  }) as MessageHandler & PromptBlockBuilder;
  return handler;
};

describe('MessageHandler session file ACP prompt blocks', () => {
  let tmpDir: string;
  const sessionId = 'session-file-prompt' as SessionId;
  const workspaceId = 'workspace-1' as WorkspaceId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-session-file-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends materialized file attachments as ACP resource links', async () => {
    const fileBytes = new TextEncoder().encode('{"trace":true}\n');
    const fileBlock = {
      type: 'file',
      fileId: 'file-12345678',
      fileName: 'trace.json',
      mimeType: 'application/json',
      sizeBytes: fileBytes.byteLength,
      sha256: sha256Hex(fileBytes),
      textPreview: true,
      transport: 'r2',
      uploadedAt: 123,
    } satisfies Extract<SessionInputBlock, { type: 'file' }>;

    const attachmentName = buildAttachmentFileName(fileBlock.fileId, fileBlock.fileName);
    const attachmentPath = path.join(tmpDir, ATTACHMENTS_DIR_RELATIVE, attachmentName);
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, fileBytes);

    const handler = createPromptHandler({ workspaceRoot: tmpDir, workspaceId });

    try {
      const promptBlocks = await handler.buildAcpPromptBlocks({
        workspaceId,
        sessionId,
        inputBlocks: [{ type: 'text', text: 'inspect this trace' }, fileBlock],
      });

      expect(promptBlocks).toContainEqual(
        expect.objectContaining({
          type: 'resource_link',
          uri: pathToFileURL(attachmentPath).href,
          name: 'trace.json',
          title: 'trace.json',
          mimeType: 'application/json',
          size: fileBytes.byteLength,
        })
      );
      expect(promptBlocks).toContainEqual({
        type: 'text',
        text: 'inspect this trace',
      });
    } finally {
      await handler.cleanup();
    }
  });

  it('keeps image blocks visual and also exposes image bytes as ACP resource links', async () => {
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const imageInputBlock = {
      type: 'image',
      imageId: 'image-12345678',
      fileName: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: imageBytes.byteLength,
      width: 2,
      height: 2,
    } satisfies Extract<SessionInputBlock, { type: 'image' }>;
    const imageAcpBlock = {
      type: 'image',
      mimeType: 'image/png',
      data: imageBytes.toString('base64'),
    } satisfies Extract<ContentBlock, { type: 'image' }>;
    const attachmentName = buildAttachmentFileName(
      imageInputBlock.imageId,
      imageInputBlock.fileName
    );
    const attachmentPath = path.join(tmpDir, ATTACHMENTS_DIR_RELATIVE, attachmentName);
    const handler = createPromptHandler({ workspaceRoot: tmpDir, workspaceId });
    handler.fetchSessionImageForPrompt = vi.fn(async () => ({
      block: imageAcpBlock,
      bytes: imageBytes,
      mimeType: 'image/png',
      sizeBytes: imageBytes.byteLength,
    }));

    try {
      const promptBlocks = await handler.buildAcpPromptBlocks({
        workspaceId,
        sessionId,
        inputBlocks: [{ type: 'text', text: 'echo this image' }, imageInputBlock],
      });

      expect(handler.fetchSessionImageForPrompt).toHaveBeenCalledWith({
        workspaceId,
        sessionId,
        imageId: imageInputBlock.imageId,
        expectedMimeType: imageInputBlock.mimeType,
      });
      expect(promptBlocks).toContainEqual(imageAcpBlock);
      expect(promptBlocks).toContainEqual(
        expect.objectContaining({
          type: 'resource_link',
          uri: pathToFileURL(attachmentPath).href,
          name: 'screen.png',
          title: 'screen.png',
          mimeType: 'image/png',
          size: imageBytes.byteLength,
        })
      );
      expect(promptBlocks).toContainEqual({
        type: 'text',
        text: 'echo this image',
      });
      expect(fs.readFileSync(attachmentPath)).toEqual(imageBytes);
    } finally {
      await handler.cleanup();
    }
  });
});
