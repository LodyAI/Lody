import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MessageContent,
  SessionId,
  SessionImageUploadResponse,
  SessionStatus,
  WorkspaceId,
} from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
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
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

/**
 * Mark a session as having active presence so async status callbacks are allowed
 * to write working statuses (see session-activity-status.ts).
 */
const injectActivePresence = (handler: MessageHandler, sessionId: SessionId): void => {
  (
    handler as unknown as {
      startSessionActivePresence: (id: SessionId) => void;
    }
  ).startSessionActivePresence(sessionId);
};

type TestHarness = {
  handler: MessageHandler;
  host: Record<string, (...args: unknown[]) => unknown>;
  history: Array<Record<string, unknown>>;
  sessionDoc: {
    getMetaState: ReturnType<typeof vi.fn>;
    updateHistory: ReturnType<typeof vi.fn>;
    setLastMessageAt: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
};

const createHarness = (): TestHarness => {
  const logger = createSilentLogger();
  const state = {
    history: [] as Array<Record<string, unknown>>,
    status: { type: 'idle' } as SessionStatus,
  };

  const sessionDoc = {
    getMetaState: vi.fn(async () => ({
      isArchived: false,
      status: state.status,
    })),
    updateHistory: vi.fn(
      async (
        updater: (history: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
      ) => {
        state.history = updater(state.history);
      }
    ),
    setLastMessageAt: vi.fn(async () => {}),
    setStatus: vi.fn(async (status: SessionStatus) => {
      state.status = status;
    }),
  };

  const workspaceDocument = {
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
    repo: {
      getDocMeta: vi.fn(async () => ({
        meta: {},
      })),
      watch: vi.fn(() => ({
        unsubscribe: vi.fn(),
      })),
    },
    getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    publishSessionPresence: vi.fn(),
    clearSessionPresence: vi.fn(),
    sendMachineHeartbeat: vi.fn(async () => {}),
  };

  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(() => null),
    cleanUp: vi.fn(async () => {}),
  };

  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    logger,
    {
      token: 'token',
      workspaceId: 'ws-1' as WorkspaceId,
      userId: 'user-1',
      machineId: 'machine-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    }
  );

  return {
    handler,
    host: handler as unknown as Record<string, (...args: unknown[]) => unknown>,
    get history() {
      return state.history;
    },
    sessionDoc,
  };
};

describe('MessageHandler image upload flow', () => {
  const handlers: MessageHandler[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (handlers.length > 0) {
      const handler = handlers.pop();
      if (handler) {
        await handler.cleanup();
      }
    }
  });

  it('publishes and clears Codex image generation activity status', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const sessionId = 'session-1' as SessionId;
    await harness.sessionDoc.setStatus({ type: 'running' } as SessionStatus);
    harness.sessionDoc.setStatus.mockClear();

    // Image-generation status is only sustainable while active presence is live;
    // simulate the in-flight turn that owns this activity.
    injectActivePresence(harness.handler, sessionId);

    (harness.host.handleImageGenerationBegin as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
      }
    );

    await vi.waitFor(() => {
      expect(harness.sessionDoc.setStatus).toHaveBeenCalledWith({
        type: 'running',
        activity: 'image_generation',
      });
    });

    (harness.host.handleImageGenerationEnd as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
        status: 'completed',
      }
    );

    await vi.waitFor(() => {
      expect(harness.sessionDoc.setStatus).toHaveBeenLastCalledWith({ type: 'running' });
    });
  });

  it('does not resurrect image generation activity after durable status is idle', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const sessionId = 'session-idle-image-generation' as SessionId;
    injectActivePresence(harness.handler, sessionId);

    (harness.host.handleImageGenerationBegin as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-idle',
      }
    );

    await vi.waitFor(() => {
      expect(harness.sessionDoc.getMetaState).toHaveBeenCalled();
    });
    expect(harness.sessionDoc.setStatus).not.toHaveBeenCalled();
  });

  it('attaches uploaded images as partial success when a later upload fails', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    vi.spyOn(harness.host, 'resolveSessionImageUploadAttachTarget').mockResolvedValue({
      kind: 'active_turn',
      turnId: 'assistant-turn-1',
    });
    vi.spyOn(harness.host, 'validateSessionImageUploadPath')
      .mockResolvedValueOnce({
        absolutePath: '/tmp/one.png',
        fileName: 'one.png',
        mimeType: 'image/png',
        sizeBytes: 10,
      })
      .mockResolvedValueOnce({
        absolutePath: '/tmp/two.png',
        fileName: 'two.png',
        mimeType: 'image/png',
        sizeBytes: 10,
      });
    vi.spyOn(harness.host, 'uploadSessionImageFile')
      .mockResolvedValueOnce({
        imageId: 'img-1',
        fileName: 'one.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        width: 100,
        height: 50,
        downloadUrl: 'https://example.com/img-1',
      })
      .mockRejectedValueOnce(new Error('transient upload failure'));
    vi.spyOn(harness.host, 'appendAssistantImageGroupToActiveTurn').mockResolvedValue(true);

    const responses: SessionImageUploadResponse[] = [];
    await harness.host.handleSessionImageUpload(
      {
        type: 'session/image-upload',
        machineId: 'machine-1',
        sessionId: 'session-1' as SessionId,
        paths: ['/tmp/one.png', '/tmp/two.png'],
      },
      {
        source: 'local-control',
        send: (message: unknown) => {
          responses.push(message as SessionImageUploadResponse);
        },
      }
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      success: true,
      attachedTo: 'active_turn',
      historyEntryId: 'assistant-turn-1',
      message: expect.stringContaining('Uploaded 1 of 2 images'),
    });
    expect(responses[0]?.content?.images).toHaveLength(1);
    expect(responses[0]?.images).toHaveLength(1);
    expect(harness.sessionDoc.setLastMessageAt).toHaveBeenCalledOnce();
  });

  it('attaches Codex generated images to the turn captured at generation start', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const sessionId = 'session-1' as SessionId;
    const turnId = (harness.host.beginConversationTurn as (sessionId: SessionId) => string)(
      sessionId
    );
    await (
      harness.host.createAssistantEntryForTurn as (
        sessionId: SessionId,
        sessionDoc: TestHarness['sessionDoc'],
        turnId: string,
        modelInfo: undefined
      ) => Promise<void>
    )(sessionId, harness.sessionDoc, turnId, undefined);

    (harness.host.handleImageGenerationBegin as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
      }
    );
    (harness.host.clearACPState as (sessionId: SessionId) => void)(sessionId);

    vi.spyOn(harness.host, 'validateSessionImageUploadPath').mockResolvedValue({
      absolutePath: '/tmp/codex-image.png',
      fileName: 'codex-image.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });
    vi.spyOn(harness.host, 'uploadSessionImageFile').mockResolvedValue({
      imageId: 'img-codex',
      fileName: 'codex-image.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 100,
      height: 50,
      downloadUrl: 'https://example.com/img-codex',
    });

    (harness.host.handleImageGenerationEnd as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
        status: 'completed',
        savedPath: '/tmp/codex-image.png',
      }
    );
    await (harness.host.flushCodexGeneratedImageUploads as (sessionId: SessionId) => Promise<void>)(
      sessionId
    );

    expect(harness.history).toHaveLength(1);
    expect(harness.history[0]?.id).toBe(turnId);
    const items = harness.history[0]?.items as MessageContent[] | undefined;
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      type: 'image_group',
      images: [{ imageId: 'img-codex' }],
    });
    expect(harness.sessionDoc.setLastMessageAt).toHaveBeenCalledOnce();
  });

  it('records a user-visible warning when a Codex generated image cannot be uploaded', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const sessionId = 'session-1' as SessionId;
    const turnId = (harness.host.beginConversationTurn as (sessionId: SessionId) => string)(
      sessionId
    );
    await (
      harness.host.createAssistantEntryForTurn as (
        sessionId: SessionId,
        sessionDoc: TestHarness['sessionDoc'],
        turnId: string,
        modelInfo: undefined
      ) => Promise<void>
    )(sessionId, harness.sessionDoc, turnId, undefined);

    (harness.host.handleImageGenerationBegin as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-fail',
      }
    );

    vi.spyOn(harness.host, 'validateSessionImageUploadPath').mockRejectedValue(
      new Error('cloud_attachment_upload_unavailable')
    );

    (harness.host.handleImageGenerationEnd as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-fail',
        status: 'completed',
        savedPath: '/tmp/codex-image.png',
      }
    );
    await (harness.host.flushCodexGeneratedImageUploads as (sessionId: SessionId) => Promise<void>)(
      sessionId
    );

    await vi.waitFor(() => {
      expect(
        harness.history.some((entry) =>
          (entry.items as MessageContent[] | undefined)?.some(
            (item) =>
              item?.type === 'system_notice' &&
              item.name === 'agent_warning' &&
              (item.meta as { message?: string } | undefined)?.message?.includes(
                'could not be attached'
              )
          )
        )
      ).toBe(true);
    });
    expect(
      harness.history.some((entry) =>
        (entry.items as MessageContent[] | undefined)?.some((item) => item?.type === 'image_group')
      )
    ).toBe(false);
  });

  it('uploads completed-only Codex inline images without persisting base64', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const sessionId = 'session-inline-image' as SessionId;
    const turnId = (harness.host.beginConversationTurn as (sessionId: SessionId) => string)(
      sessionId
    );
    await (
      harness.host.createAssistantEntryForTurn as (
        sessionId: SessionId,
        sessionDoc: TestHarness['sessionDoc'],
        turnId: string,
        modelInfo: undefined
      ) => Promise<void>
    )(sessionId, harness.sessionDoc, turnId, undefined);

    (harness.host.handleImageGenerationBegin as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      { acpSessionId: 'acp-inline', callId: 'ig-inline' }
    );

    const upload = vi.spyOn(harness.host, 'uploadSessionImageFile').mockResolvedValue({
      imageId: 'img-inline',
      fileName: 'agent-image.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      width: 1,
      height: 1,
      downloadUrl: 'https://example.com/img-inline',
    });

    (harness.host.handleImageGenerationEnd as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-inline',
        callId: 'ig-inline',
        status: 'completed',
        image: { data: 'aGVsbG8=', mimeType: 'image/png' },
      }
    );
    await (harness.host.flushCodexGeneratedImageUploads as (sessionId: SessionId) => Promise<void>)(
      sessionId
    );

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        file: expect.objectContaining({
          mimeType: 'image/png',
          sizeBytes: 5,
          bytes: expect.any(Buffer),
        }),
      })
    );
    expect(harness.history).toHaveLength(1);
    expect(harness.history[0]?.id).toBe(turnId);
    expect(harness.history[0]?.items).toEqual([
      expect.objectContaining({
        type: 'image_group',
        images: [expect.objectContaining({ imageId: 'img-inline' })],
      }),
    ]);
    expect(JSON.stringify(harness.history)).not.toContain('aGVsbG8=');
    expect(harness.sessionDoc.setLastMessageAt).toHaveBeenCalledOnce();
  });

  it('keeps Codex image turn capture across generating updates', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const sessionId = 'session-1' as SessionId;
    const turnId = (harness.host.beginConversationTurn as (sessionId: SessionId) => string)(
      sessionId
    );
    await (
      harness.host.createAssistantEntryForTurn as (
        sessionId: SessionId,
        sessionDoc: TestHarness['sessionDoc'],
        turnId: string,
        modelInfo: undefined
      ) => Promise<void>
    )(sessionId, harness.sessionDoc, turnId, undefined);

    (harness.host.handleImageGenerationBegin as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
      }
    );
    (harness.host.clearACPState as (sessionId: SessionId) => void)(sessionId);

    const validatePath = vi
      .spyOn(harness.host, 'validateSessionImageUploadPath')
      .mockResolvedValue({
        absolutePath: '/tmp/codex-image.png',
        fileName: 'codex-image.png',
        mimeType: 'image/png',
        sizeBytes: 10,
      });
    vi.spyOn(harness.host, 'uploadSessionImageFile').mockResolvedValue({
      imageId: 'img-codex',
      fileName: 'codex-image.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 100,
      height: 50,
      downloadUrl: 'https://example.com/img-codex',
    });

    (harness.host.handleImageGenerationEnd as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
        status: 'generating',
      }
    );
    await (harness.host.flushCodexGeneratedImageUploads as (sessionId: SessionId) => Promise<void>)(
      sessionId
    );

    expect(validatePath).not.toHaveBeenCalled();
    expect(harness.history[0]?.items).toEqual([]);

    (harness.host.handleImageGenerationEnd as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
        status: 'generating',
        savedPath: '/tmp/codex-image.png',
      }
    );
    await (harness.host.flushCodexGeneratedImageUploads as (sessionId: SessionId) => Promise<void>)(
      sessionId
    );

    (harness.host.handleImageGenerationEnd as (sessionId: SessionId, event: unknown) => void)(
      sessionId,
      {
        acpSessionId: 'acp-1',
        callId: 'ig-1',
        status: 'completed',
        savedPath: '/tmp/codex-image.png',
      }
    );
    await (harness.host.flushCodexGeneratedImageUploads as (sessionId: SessionId) => Promise<void>)(
      sessionId
    );

    expect(validatePath).toHaveBeenCalledOnce();
    expect(harness.history).toHaveLength(1);
    expect(harness.history[0]?.id).toBe(turnId);
    const items = harness.history[0]?.items as MessageContent[] | undefined;
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      type: 'image_group',
      images: [{ imageId: 'img-codex' }],
    });
  });

  it('reserves a new entry before upload and keeps using it if a new turn starts later', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const resolveAttachTarget = vi
      .spyOn(harness.host, 'resolveSessionImageUploadAttachTarget')
      .mockResolvedValueOnce({ kind: 'new_entry' })
      .mockResolvedValueOnce({ kind: 'active_turn', turnId: 'new-turn' });

    vi.spyOn(harness.host, 'validateSessionImageUploadPath').mockResolvedValue({
      absolutePath: '/tmp/shot.png',
      fileName: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });
    vi.spyOn(harness.host, 'uploadSessionImageFile').mockResolvedValue({
      imageId: 'img-1',
      fileName: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 100,
      height: 50,
      downloadUrl: 'https://example.com/img-1',
    });

    const responses: SessionImageUploadResponse[] = [];
    await harness.host.handleSessionImageUpload(
      {
        type: 'session/image-upload',
        machineId: 'machine-1',
        sessionId: 'session-1' as SessionId,
        paths: ['/tmp/shot.png'],
      },
      {
        source: 'local-control',
        send: (message: unknown) => {
          responses.push(message as SessionImageUploadResponse);
        },
      }
    );

    expect(resolveAttachTarget).toHaveBeenCalledTimes(1);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      success: true,
      attachedTo: 'new_entry',
    });
    expect(harness.history).toHaveLength(1);
    expect(harness.history[0]?.items).toEqual([responses[0]?.content]);
  });

  it('removes the reserved entry when validation fails before upload starts', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    vi.spyOn(harness.host, 'resolveSessionImageUploadAttachTarget').mockResolvedValue({
      kind: 'new_entry',
    });
    vi.spyOn(harness.host, 'validateSessionImageUploadPath').mockRejectedValue(
      new Error('bad path')
    );

    const responses: SessionImageUploadResponse[] = [];
    await harness.host.handleSessionImageUpload(
      {
        type: 'session/image-upload',
        machineId: 'machine-1',
        sessionId: 'session-1' as SessionId,
        paths: ['/tmp/missing.png'],
      },
      {
        source: 'local-control',
        send: (message: unknown) => {
          responses.push(message as SessionImageUploadResponse);
        },
      }
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      success: false,
      error: 'invalid_file',
    });
    expect(harness.history).toHaveLength(0);
  });

  it('rejects symlinked image paths before upload', async () => {
    const harness = createHarness();
    handlers.push(harness.handler);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-image-upload-'));
    try {
      const targetPath = path.join(tempDir, 'secret.txt');
      const linkPath = path.join(tempDir, 'innocent.png');
      await fs.writeFile(targetPath, 'secret');
      await fs.symlink(targetPath, linkPath);

      const validatePath = harness.host.validateSessionImageUploadPath as (
        filePath: string
      ) => Promise<unknown>;
      await expect(validatePath(linkPath)).rejects.toThrow(/must not be a symlink/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
