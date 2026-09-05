import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MachineId,
  PreviewCandidateReportRequest,
  SessionId,
  SessionImageUploadRequest,
  WorkspaceId,
} from '@lody/shared';

import { __lodyMcpServerInternals } from '../src/mcp/lody-mcp-server';

const {
  ImageUploadToolInputSchema,
  TaskImageUploadToolInputSchema,
  getSessionContext,
  postImageUpload,
  postPreviewCandidate,
  postSessionControl,
  resolveUploadPath,
  summarizeTaskForMcp,
} = __lodyMcpServerInternals;

const ENV_KEYS = [
  'LODY_MCP_MACHINE_ID',
  'LODY_MCP_WORKSPACE_ID',
  'LODY_MCP_SESSION_ID',
  'LODY_MCP_SOCKET_PATH',
  'LODY_MCP_WORKDIR',
  'LODY_MCP_TASK_TOOLS_ENABLED',
  'LODY_MCP_SCHEDULE_TOOLS_ENABLED',
  'LODY_PREVIEW_MCP_MACHINE_ID',
  'LODY_PREVIEW_MCP_WORKSPACE_ID',
  'LODY_PREVIEW_MCP_SESSION_ID',
  'LODY_PREVIEW_MCP_SOCKET_PATH',
  'LODY_PREVIEW_MCP_WORKDIR',
] as const;

const originalEnv = new Map<string, string | undefined>();
const servers: http.Server[] = [];
const tempDirs: string[] = [];

const previewRequest = (): PreviewCandidateReportRequest => ({
  type: 'session/preview-candidate-report',
  machineId: 'machine-1' as MachineId,
  workspaceId: 'workspace-1' as WorkspaceId,
  sessionId: 'session-1' as SessionId,
  target: {
    protocol: 'http',
    host: '127.0.0.1',
    port: 5173,
  },
  source: {
    toolName: 'test',
  },
});

const imageUploadRequest = (): SessionImageUploadRequest => ({
  type: 'session/image-upload',
  machineId: 'machine-1' as MachineId,
  workspaceId: 'workspace-1' as WorkspaceId,
  sessionId: 'session-1' as SessionId,
  paths: ['/tmp/screenshot.png'],
});

function makeSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\lody-mcp-test-${process.pid}-${randomUUID()}`;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-mcp-test-'));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'control.sock');
}

async function listenSocket(
  handler: http.RequestListener
): Promise<{ socketPath: string; seenBodies: string[] }> {
  const socketPath = makeSocketPath();
  const seenBodies: string[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      seenBodies.push(Buffer.concat(chunks).toString('utf8'));
      handler(req, res);
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { socketPath, seenBodies };
}

describe('lody MCP server internals', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
    vi.unstubAllGlobals();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('validates image upload tool path count and non-empty paths', () => {
    expect(ImageUploadToolInputSchema.safeParse({ paths: [] }).success).toBe(false);
    expect(
      ImageUploadToolInputSchema.safeParse({
        paths: Array.from({ length: 9 }, (_, index) => `/tmp/${index}.png`),
      }).success
    ).toBe(false);
    expect(ImageUploadToolInputSchema.safeParse({ paths: [''] }).success).toBe(false);
    expect(
      ImageUploadToolInputSchema.safeParse({
        paths: Array.from({ length: 8 }, (_, index) => `/tmp/${index}.png`),
      }).success
    ).toBe(true);
  });

  it('validates task image paths and rejects unknown fields', () => {
    expect(TaskImageUploadToolInputSchema.safeParse({ paths: [] }).success).toBe(false);
    expect(
      TaskImageUploadToolInputSchema.safeParse({
        paths: Array.from({ length: 9 }, (_, index) => `/tmp/${index}.png`),
      }).success
    ).toBe(false);
    expect(TaskImageUploadToolInputSchema.safeParse({ paths: ['task.png'] }).success).toBe(true);
    expect(
      TaskImageUploadToolInputSchema.safeParse({
        paths: ['task.png'],
        taskId: 'task-1',
      }).success
    ).toBe(false);
  });

  it('posts local-control requests and returns validated responses', async () => {
    const request = previewRequest();
    const responsePayload = {
      type: 'session/preview-candidate-report_response',
      sessionId: 'session-1',
      success: true,
    };
    const { socketPath, seenBodies } = await listenSocket((req, res) => {
      expect(req.url).toBe('/session-control');
      expect(req.method).toBe('POST');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, responses: [responsePayload] }));
    });

    await expect(postSessionControl(request, socketPath)).resolves.toEqual([responsePayload]);
    expect(seenBodies).toEqual([JSON.stringify(request)]);
  });

  it('surfaces local-control error, message, and details fields', async () => {
    const { socketPath } = await listenSocket((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: 'invalid_request',
          message: 'paths must be a non-empty array of strings',
          details: { fieldErrors: { paths: ['Required'] } },
        })
      );
    });

    await expect(postSessionControl(imageUploadRequest(), socketPath)).rejects.toThrow(
      /invalid_request: paths must be a non-empty array of strings: details: .*fieldErrors/
    );
  });

  it('translates local-control timeout failures', async () => {
    const { socketPath } = await listenSocket(() => {});

    await expect(postSessionControl(previewRequest(), socketPath, 1)).rejects.toThrow(
      /local control timed out/
    );
  });

  it('fails when local-control omits the expected response type', async () => {
    const first = await listenSocket((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          responses: [
            {
              type: 'session/image-upload_response',
              sessionId: 'session-1',
              success: true,
            },
          ],
        })
      );
    });

    await expect(postPreviewCandidate(previewRequest(), first.socketPath)).rejects.toThrow(
      /did not return a preview candidate response/
    );

    const second = await listenSocket((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          responses: [
            {
              type: 'session/preview-candidate-report_response',
              sessionId: 'session-1',
              success: true,
            },
          ],
        })
      );
    });

    await expect(postImageUpload(imageUploadRequest(), second.socketPath)).rejects.toThrow(
      /did not return an image upload response/
    );
  });

  it('resolves relative image paths against the MCP workdir and passes absolute paths through', () => {
    expect(resolveUploadPath('screenshots/home.png', '/repo/worktree')).toBe(
      '/repo/worktree/screenshots/home.png'
    );
    expect(resolveUploadPath('/tmp/home.png', '/repo/worktree')).toBe('/tmp/home.png');
    expect(resolveUploadPath('../outside.png', '/repo/worktree')).toBe('/repo/outside.png');
  });

  it('loads session context from env vars', () => {
    process.env.LODY_MCP_MACHINE_ID = 'machine';
    process.env.LODY_MCP_WORKSPACE_ID = 'workspace';
    process.env.LODY_MCP_SESSION_ID = 'session';
    process.env.LODY_MCP_SOCKET_PATH = '/tmp/lody-control.sock';
    process.env.LODY_MCP_WORKDIR = '/workdir';
    process.env.LODY_MCP_TASK_TOOLS_ENABLED = '1';
    process.env.LODY_MCP_SCHEDULE_TOOLS_ENABLED = '1';

    expect(getSessionContext()).toEqual({
      machineId: 'machine',
      workspaceId: 'workspace',
      sessionId: 'session',
      localControlSocketPath: '/tmp/lody-control.sock',
      workdir: '/workdir',
      taskToolsEnabled: true,
      scheduleToolsEnabled: true,
    });
  });

  it('falls back to legacy preview MCP env vars', () => {
    process.env.LODY_PREVIEW_MCP_MACHINE_ID = 'legacy-machine';
    process.env.LODY_PREVIEW_MCP_WORKSPACE_ID = 'legacy-workspace';
    process.env.LODY_PREVIEW_MCP_SESSION_ID = 'legacy-session';
    process.env.LODY_PREVIEW_MCP_SOCKET_PATH = '/tmp/legacy-control.sock';
    process.env.LODY_PREVIEW_MCP_WORKDIR = '/legacy-workdir';

    expect(getSessionContext()).toEqual({
      machineId: 'legacy-machine',
      workspaceId: 'legacy-workspace',
      sessionId: 'legacy-session',
      localControlSocketPath: '/tmp/legacy-control.sock',
      workdir: '/legacy-workdir',
      taskToolsEnabled: false,
      scheduleToolsEnabled: false,
    });
  });

  it('prefers lody MCP env vars over legacy preview MCP env vars', () => {
    process.env.LODY_MCP_MACHINE_ID = 'machine';
    process.env.LODY_MCP_WORKSPACE_ID = 'workspace';
    process.env.LODY_MCP_SESSION_ID = 'session';
    process.env.LODY_MCP_SOCKET_PATH = '/tmp/lody-control.sock';
    process.env.LODY_MCP_WORKDIR = '/workdir';
    process.env.LODY_PREVIEW_MCP_MACHINE_ID = 'legacy-machine';
    process.env.LODY_PREVIEW_MCP_WORKSPACE_ID = 'legacy-workspace';
    process.env.LODY_PREVIEW_MCP_SESSION_ID = 'legacy-session';
    process.env.LODY_PREVIEW_MCP_SOCKET_PATH = '/tmp/legacy-control.sock';
    process.env.LODY_PREVIEW_MCP_WORKDIR = '/legacy-workdir';

    expect(getSessionContext()).toEqual({
      machineId: 'machine',
      workspaceId: 'workspace',
      sessionId: 'session',
      localControlSocketPath: '/tmp/lody-control.sock',
      workdir: '/workdir',
      taskToolsEnabled: false,
      scheduleToolsEnabled: false,
    });
  });

  it('requires session identity env vars', () => {
    expect(() => getSessionContext()).toThrow(/LODY_MCP_MACHINE_ID/);
  });
});

describe('summarizeTaskForMcp bounds', () => {
  const snapshot = (over: Record<string, unknown> = {}) =>
    ({
      meta: {
        taskId: 't1',
        title: 'T',
        status: 'backlog',
        ownerId: 'u1',
        order: '1',
        createdAt: 1,
        updatedAt: 1,
      },
      body: 'short body',
      links: [],
      timeline: [],
      ...over,
    }) as never;

  it('returns a short body untouched and unflagged', () => {
    const out = summarizeTaskForMcp(snapshot());

    expect(out.body).toBe('short body');
    expect('bodyTruncated' in out).toBe(false);
  });

  it('bounds a huge body and says so instead of blowing the caller context', () => {
    const out = summarizeTaskForMcp(snapshot({ body: 'x'.repeat(400_000) }));

    expect(Buffer.byteLength(out.body, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(out.bodyTruncated).toBe(true);
    expect(out.bodyOmittedBytes).toBeGreaterThan(0);
  });

  it('keeps both ends of a bounded body so an exact-match edit can still aim', () => {
    const body = `HEAD-MARKER\n${'y'.repeat(300_000)}\nTAIL-MARKER`;
    const out = summarizeTaskForMcp(snapshot({ body }));

    expect(out.body.startsWith('HEAD-MARKER')).toBe(true);
    expect(out.body.endsWith('TAIL-MARKER')).toBe(true);
  });

  it('reports that older comments exist rather than silently keeping 20', () => {
    const timeline = Array.from({ length: 25 }, (_, index) => ({
      id: `c${index}`,
      kind: 'comment',
      actorKind: 'human',
      createdAt: index,
      body: `comment ${index}`,
    }));
    const out = summarizeTaskForMcp(snapshot({ timeline }));

    expect(out.comments).toHaveLength(20);
    expect(out.commentCount).toBe(25);
    // The newest are the ones kept.
    expect(out.comments.at(-1)?.body).toBe('comment 24');
  });
});
