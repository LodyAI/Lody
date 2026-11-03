import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, SessionInputBlock, WorkspaceId } from '@lody/shared';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { Loro } from 'loro-crdt';
import { createLoroSessionData } from '@lody/shared/session-data';

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
    userTurnId?: string;
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

  describe('sender provenance', () => {
    const agentAuthor = {
      v: 1,
      kind: 'agent',
      sessionId: 'coordinator-session',
      turnId: 'coordinator-turn',
      name: 'Codex',
      role: { id: 'role-1', revision: 1, name: 'Executor', emoji: '' },
    } as const;
    const build = async (readTurn: () => Promise<unknown>) => {
      const handler = createPromptHandler({ workspaceRoot: tmpDir, workspaceId });
      const internals = handler as unknown as {
        workspaceDocument: { repo: { getDocMeta: unknown }; getOrCreateSessionDoc: unknown };
      };
      internals.workspaceDocument.getOrCreateSessionDoc = vi.fn(async () => ({}));
      internals.workspaceDocument.repo.getDocMeta = vi.fn(async () => ({
        meta: { title: 'E2EE coordinator' },
      }));
      vi.spyOn(
        handler as unknown as { getSessionBackend: () => Promise<unknown> },
        'getSessionBackend'
      ).mockResolvedValue({ history: { readTurn } });
      return await handler.buildAcpPromptBlocks({
        workspaceId,
        sessionId,
        userTurnId: 'input-turn',
        inputBlocks: [{ type: 'text', text: 'Only report P0/P1.' }],
      });
    };

    it('prefixes an agent-authored input with its source Session', async () => {
      expect(
        await build(async () => ({ state: 'ready', turn: { role: 'user', author: agentAuthor } }))
      ).toEqual([
        {
          type: 'text',
          text:
            '[Lody] This message was sent by another agent, not by a human.\n' +
            'Source Session: "E2EE coordinator" (coordinator-session), Codex · Agent Role "Executor"\n\n' +
            'Only report P0/P1.',
        },
      ]);
    });

    it('leaves human input unchanged', async () => {
      expect(
        await build(async () => ({
          state: 'ready',
          turn: { role: 'user', author: { v: 1, kind: 'human', userId: 'user-1' } },
        }))
      ).toEqual([{ type: 'text', text: 'Only report P0/P1.' }]);
    });

    it('still delivers the input when its author cannot be read', async () => {
      expect(
        await build(async () => {
          throw new Error('Synthetic history read failure');
        })
      ).toEqual([{ type: 'text', text: 'Only report P0/P1.' }]);
    });
  });
  describe('live activity', () => {
    const rows = [
      { id: 'u1', role: 'user', status: 'handled', timestamp: '2026-11-03T01:00:00.000Z' },
      { id: 'assistant:u1', role: 'assistant', timestamp: '2026-11-03T01:00:01.000Z' },
      { id: 'u2', role: 'user', status: 'pending', timestamp: '2026-11-03T01:05:00.000Z' },
      { id: 'u3', role: 'user', status: 'pending', timestamp: '2026-11-03T01:06:00.000Z' },
    ];
    const daemon = (history: {
      count: () => Promise<number>;
      readAt: unknown;
      readDirectory?: unknown;
    }) => {
      const handler = createPromptHandler({ workspaceRoot: tmpDir, workspaceId });
      const internals = handler as unknown as Record<string, unknown> & {
        workspaceDocument: { getOrCreateSessionDoc: unknown };
      };
      internals.executionService = {
        getExecutionSnapshot: () => ({ hasActiveTurn: true, activeTurnId: 'assistant:u1' }),
      };
      internals.sessionActivePresence = { getStatus: () => undefined };
      internals.sessionDispatchWatcher = { hasPendingDispatch: () => true };
      internals.workspaceDocument.getOrCreateSessionDoc = vi.fn(async () => ({}));
      vi.spyOn(
        handler as unknown as { getSessionBackend: () => Promise<unknown> },
        'getSessionBackend'
      ).mockResolvedValue({ history });
      return handler as unknown as {
        recordLiveActivity: (id: SessionId, update: unknown) => void;
        readSessionLiveStatus: (
          id: SessionId,
          includeActivity?: boolean
        ) => Promise<Record<string, unknown>>;
      };
    };
    const history = {
      count: async () => rows.length,
      readAt: async () => {
        throw new Error('Activity must not materialize turn bodies');
      },
      readDirectory: async (from: number, to: number) =>
        rows
          .slice(from, to)
          .map((scalars, offset) => ({ position: from + offset, state: 'ready', scalars })),
    };

    it('answers requested activity from the running turn and queued inputs', async () => {
      const handler = daemon(history);
      handler.recordLiveActivity(sessionId, {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'shell: flock heavy.lock make test',
          status: 'in_progress',
        },
      });
      expect((await handler.readSessionLiveStatus(sessionId, true)).activity).toMatchObject({
        turnStartedAt: Date.parse('2026-11-03T01:00:01.000Z'),
        lastOutputAt: expect.any(Number),
        currentAction: 'shell: flock heavy.lock make test',
        queuedInputs: 2,
      });
      handler.recordLiveActivity(sessionId, {
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
      });
      expect((await handler.readSessionLiveStatus(sessionId, true)).activity).not.toHaveProperty(
        'currentAction'
      );
    });

    it('omits activity unless requested, and when local history cannot be read', async () => {
      expect(await daemon(history).readSessionLiveStatus(sessionId)).not.toHaveProperty('activity');
      const failing = await daemon({
        count: async () => {
          throw new Error('Synthetic history failure');
        },
        readAt: async () => undefined,
      }).readSessionLiveStatus(sessionId, true);
      expect(failing).toMatchObject({ success: true });
      expect(failing).not.toHaveProperty('activity');
    });
  });
  describe('queued input withdrawal', () => {
    const author = (requester: string) => ({
      v: 1,
      kind: 'agent',
      sessionId: requester,
      turnId: `${requester}-turn`,
      name: 'Codex',
    });
    const withdraw = async () => {
      const data = createLoroSessionData({ sessionId, doc: new Loro() });
      const append = (id: string, status: string, requester: string) =>
        data.commands.appendTurn({
          id,
          role: 'user',
          status,
          author: author(requester),
          timestamp: '2026-11-03T01:00:00.000Z',
          items: [{ type: 'text', text: id }],
          fileDiff: [],
        } as never);
      await append('own-pending', 'pending', 'coordinator');
      await append('own-started', 'processing', 'coordinator');
      await append('other-pending', 'pending', 'someone-else');
      await append('own-seen', 'seen', 'coordinator');
      const handler = createPromptHandler({ workspaceRoot: tmpDir, workspaceId });
      const internals = handler as unknown as Record<string, unknown> & {
        workspaceDocument: { getOrCreateSessionDoc: unknown };
      };
      internals.workspaceDocument.getOrCreateSessionDoc = vi.fn(async () => ({}));
      internals.sessionDispatchWatcher = { discardRpcTurn: () => undefined };
      vi.spyOn(
        handler as unknown as { getSessionBackend: () => Promise<unknown> },
        'getSessionBackend'
      ).mockResolvedValue({
        history: data.history,
        applyHistoryAction: (action: never) => data.commands.applyHistoryAction(action),
      });
      const run = (userTurnId: string) =>
        (
          handler as unknown as {
            withdrawQueuedInput: (args: unknown) => Promise<{ outcome: string }>;
          }
        ).withdrawQueuedInput({ sessionId, userTurnId, requesterSessionId: 'coordinator' });
      const status = async (id: string) => {
        const read = await data.history.readTurn(id);
        return read.state === 'ready' ? read.turn.status : undefined;
      };
      return { run, status };
    };

    it("cancels only the requester's own input that has not started", async () => {
      const { run, status } = await withdraw();
      expect(await run('own-pending')).toMatchObject({ outcome: 'withdrawn' });
      expect(await status('own-pending')).toBe('canceled');

      expect(await run('own-started')).toMatchObject({ outcome: 'already_started' });
      expect(await status('own-started')).toBe('processing');
      expect(await run('other-pending')).toMatchObject({ outcome: 'not_owner' });
      expect(await status('other-pending')).toBe('pending');
      expect(await run('missing')).toMatchObject({ outcome: 'not_found' });
      expect(await run('own-seen')).toMatchObject({ outcome: 'withdrawn' });
    });
  });
});
