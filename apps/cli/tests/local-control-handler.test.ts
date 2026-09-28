import { describe, expect, it, vi } from 'vitest';
import {
  LocalProjectControlResponse,
  LocalSessionControlRequest,
  LocalSessionControlResponse,
} from '@lody/shared';
import { LOCAL_PROJECT_CONTROL_PATH } from '@lody/shared/node/local-project-control';
import { LOCAL_SESSION_CONTROL_PATH } from '@lody/shared/node/local-ipc';
import { LocalControlHandler } from '../src/lib/local-control-handler';
import type { Logger } from '../src/utils/logger';

const logger: Logger = {
  debug: vi.fn(),
  trace: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  setLevel: vi.fn(),
  setDebug: vi.fn(),
  child: vi.fn(() => logger),
  close: vi.fn(async () => {}),
};

const createSessionRequest = (): LocalSessionControlRequest => ({
  type: 'session/create',
  machineId: 'machine-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  acpSessionConfig: {
    prompt: 'hello',
    cliType: 'builtin',
    agentType: 'codex',
  },
  userId: 'user-1',
  userName: 'User One',
  userEmail: 'user@example.com',
});

describe('LocalControlHandler', () => {
  it('handles session-control messages without HTTP objects', async () => {
    const dispatchResponse: LocalSessionControlResponse = {
      type: 'session/create_response',
      sessionId: 'session-1',
      success: true,
    };
    const dispatchSession = vi.fn(async () => [dispatchResponse]);
    const handler = new LocalControlHandler({
      machineId: 'machine-1',
      logger,
      dispatchSession,
      dispatchProject: vi.fn(),
    });

    await expect(
      handler.handle({
        path: LOCAL_SESSION_CONTROL_PATH,
        rawBody: JSON.stringify(createSessionRequest()),
        requestId: 1,
      })
    ).resolves.toEqual({
      status: 200,
      payload: {
        ok: true,
        responses: [
          {
            type: 'session/create_ack',
            sessionId: 'session-1',
          },
          dispatchResponse,
        ],
      },
    });
    expect(dispatchSession).toHaveBeenCalledOnce();
  });

  it('handles project-control parse failures without HTTP objects', async () => {
    const dispatchProject = vi.fn<() => Promise<LocalProjectControlResponse>>();
    const handler = new LocalControlHandler({
      machineId: 'machine-1',
      logger,
      dispatchSession: vi.fn(),
      dispatchProject,
    });

    const response = await handler.handle({
      path: LOCAL_PROJECT_CONTROL_PATH,
      rawBody: '{"type":"local-project/list","machineId":1}',
      requestId: 2,
    });

    expect(response.status).toBe(400);
    expect(response.payload).toMatchObject({
      ok: false,
      type: 'local-project/list',
      error: 'invalid_request',
    });
    expect(dispatchProject).not.toHaveBeenCalled();
  });
});
