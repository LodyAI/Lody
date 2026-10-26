import * as encryptedWorkspace from '../src/lib/e2ee/workspace-legacy';
import type { LocalE2eePairingRequest } from '@lody/shared/e2ee-local-pairing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  LocalProjectControlResponse,
  type LocalProjectControlRequest,
  LocalSessionControlRequest,
  LocalSessionControlResponse,
} from '@lody/shared';
import { LOCAL_PROJECT_CONTROL_PATH } from '@lody/shared/node/local-project-control';
import { LOCAL_SESSION_CONTROL_PATH } from '@lody/shared/node/local-ipc';
import { LocalControlHandler } from '../src/lib/local-control-handler';
import { LocalProjectControlService } from '../src/lib/local-project-control-service';
import { MessageHandler } from '../src/lib/message-handler';
import { LodyFleet } from '../src/lib/lody-fleet';
import type { Logger } from '../src/utils/logger';

// Focused mock tests: directory dispatch does not launch an agent. Isolate installed
// provider metadata; this does not validate real adapter/runtime integration.
vi.mock(
  '../../../packages/acp-extension-claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>();
    const { default: manifest } = await import('../src/agent/claude-runtime-manifest.json');
    return { default: { ...actual.default, version: manifest.sdkVersion } };
  }
);
vi.mock(
  '../../../packages/acp-extension-claude/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json',
  async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>();
    const { default: manifest } = await import('../src/agent/claude-runtime-manifest.json');
    return { default: { ...actual.default, version: manifest.version } };
  }
);

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

describe.each(['machine RPC', 'local daemon'] as const)(
  'create-directory through %s (focused mock)',
  (route) => {
    let parentPath: string;
    let dispatch: (request: LocalProjectControlRequest) => Promise<LocalProjectControlResponse>;
    beforeEach(async () => {
      parentPath = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'lody-create-route-'))
      );
      // Exercise the real dispatchers and filesystem without starting daemon/session lifecycles.
      const target = Object.assign(
        Object.create(route === 'machine RPC' ? MessageHandler.prototype : LodyFleet.prototype),
        {
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          localProjectControlService: new LocalProjectControlService(logger),
          startInFlight: new Map(),
          cleanupOwners: new Map(),
          startupCleanupOwners: new Map(),
          runtimes: new Map([['workspace-1', {}]]),
        }
      ) as {
        dispatchLocalProjectControlViaRpc: typeof dispatch;
        dispatchLocalProjectControl: typeof dispatch;
      };
      dispatch =
        route === 'machine RPC'
          ? target.dispatchLocalProjectControlViaRpc.bind(target)
          : target.dispatchLocalProjectControl.bind(target);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fs.rm(parentPath, { recursive: true, force: true });
    });
    const request = (parent: string): LocalProjectControlRequest => ({
      type: 'local-project/create-directory',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      parentPath: parent,
      name: 'new',
    });

    it('creates via the wire schema and returns the canonical directory without registration', async () => {
      const handler = new LocalControlHandler({
        machineId: 'machine-1',
        logger,
        dispatchSession: vi.fn(),
        dispatchProject: dispatch,
      });
      const result = await handler.handle({
        path: LOCAL_PROJECT_CONTROL_PATH,
        requestId: 1,
        rawBody: JSON.stringify(request(parentPath)),
      });
      expect(result).toEqual({
        status: 200,
        payload: {
          ok: true,
          type: 'local-project/create-directory',
          result: { path: path.join(parentPath, 'new') },
        },
      });
      expect(await fs.readdir(parentPath)).toEqual(['new']);
      expect(await fs.readdir(path.join(parentPath, 'new'))).toEqual([]);
      // No catalog dependency exists in this harness: an accidental registration fails the test.
      await expect(dispatch(request(parentPath))).resolves.toMatchObject({
        ok: false,
        error: 'already_exists',
      });
    });

    it.each([
      { machineId: 'other', error: 'machine_mismatch' },
      { workspaceId: 'other', error: 'workspace_not_found' },
      { name: '../escape', error: 'invalid_request' },
      { parentPath: 'relative', error: 'path_invalid' },
    ])('rejects $error before creating anything', async ({ error, ...patch }) => {
      await expect(
        dispatch({ ...request(parentPath), ...patch } as LocalProjectControlRequest)
      ).resolves.toMatchObject({ ok: false, error });
      expect(await fs.readdir(parentPath)).toEqual([]);
    });

    it('preserves the permission error returned by the machine filesystem', async () => {
      vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'EACCES' })
      );
      await expect(dispatch(request(parentPath))).resolves.toMatchObject({
        ok: false,
        error: 'access_denied',
      });
      expect(await fs.readdir(parentPath)).toEqual([]);
    });
  }
);

describe('local E2EE pairing authority', () => {
  const request: LocalE2eePairingRequest = {
    type: 'activate',
    accountId: 'account',
    machineId: 'machine',
    workspaceId: 'workspace',
    genesisHash: '12'.repeat(32),
    signingPublicKey: '56'.repeat(32),
  };
  const workspace = { id: 'workspace', contentMode: 'e2ee', genesisHash: request.genesisHash };
  const target = (overrides: Record<string, unknown> = {}) =>
    Object.assign(Object.create(LodyFleet.prototype), {
      stopped: false,
      localPlatform: false,
      userId: 'account',
      cloudPort: { e2ee: {} },
      desiredWorkspaces: new Map([['workspace', workspace]]),
      runtimes: new Map([['workspace', { lody: { refreshEncryptedWorkspace: async () => true } }]]),
      startInFlight: new Map(),
      cleanupOwners: new Map(),
      startupCleanupOwners: new Map(),
      e2eeActivationInFlight: new Map(),
      startWorkspace: async () => {},
      resolveWorkspaceRuntime: async () => ({
        lody: { refreshEncryptedWorkspace: async () => true },
      }),
      ...overrides,
    }) as { dispatchLocalE2eePairing: (input: LocalE2eePairingRequest) => Promise<unknown> };
  it('refuses another account, ordinary workspace, foreign genesis and OSS mode before starting anything', async () => {
    for (const instance of [
      target({ userId: 'other' }),
      target({ localPlatform: true }),
      target({
        desiredWorkspaces: new Map([['workspace', { ...workspace, contentMode: 'plaintext' }]]),
      }),
      target({
        desiredWorkspaces: new Map([['workspace', { ...workspace, genesisHash: '34'.repeat(32) }]]),
      }),
    ]) {
      await expect(instance.dispatchLocalE2eePairing(request)).rejects.toThrow(
        /e2ee_(account_unavailable|binding_conflict)/
      );
    }
  });
  it('releases a running old device before installing and starting its replacement', async () => {
    const events: string[] = [];
    const activation = vi
      .spyOn(encryptedWorkspace, 'activateCliE2eeWorkspaceLegacy')
      .mockImplementation(async (options) => {
        if (options.expectedSigningPublicKey !== request.signingPublicKey)
          throw new Error('wrong target');
        events.push('installed replacement');
      });
    const instance = target({
      logger: { debug: () => {} },
      waitingForPairing: new Set(['workspace']),
      runtimes: new Map([
        ['workspace', { lody: { refreshEncryptedWorkspace: async () => false } }],
      ]),
      stopWorkspace: async () => {
        events.push('released old owner');
      },
      startWorkspace: async () => {
        events.push('started replacement');
      },
    });
    try {
      expect(await instance.dispatchLocalE2eePairing(request)).toEqual({
        ok: true,
        type: 'activate',
      });
      expect(events).toEqual([
        'released old owner',
        'installed replacement',
        'started replacement',
      ]);
    } finally {
      activation.mockRestore();
    }
  });
  it('retries retained cleanup before replacing a device after a transient release failure', async () => {
    const events: string[] = [];
    const cleanupOwners = new Map();
    const runtimes = new Map([
      ['workspace', { lody: { refreshEncryptedWorkspace: async () => false } }],
    ]);
    const activation = vi
      .spyOn(encryptedWorkspace, 'activateCliE2eeWorkspaceLegacy')
      .mockImplementation(async () => {
        events.push('installed replacement');
      });
    const instance = target({
      logger: { debug: () => {} },
      waitingForPairing: new Set(),
      cleanupOwners,
      runtimes,
      stopWorkspace: async () => {
        cleanupOwners.set('workspace', {});
        throw new Error('release pending');
      },
      retryWorkspaceCleanup: async () => {
        events.push('released retained owner');
        cleanupOwners.clear();
        runtimes.clear();
      },
      startWorkspace: async () => {
        events.push('started replacement');
      },
    });
    try {
      await expect(instance.dispatchLocalE2eePairing(request)).rejects.toThrow('release pending');
      expect(events).toEqual([]);
      expect(await instance.dispatchLocalE2eePairing(request)).toEqual({
        ok: true,
        type: 'activate',
      });
      expect(events).toEqual([
        'released retained owner',
        'installed replacement',
        'started replacement',
      ]);
    } finally {
      activation.mockRestore();
    }
  });
  it('keeps a temporary mailbox failure retryable and acknowledges only a later verified refresh', async () => {
    let ready = false;
    const instance = target({
      runtimes: new Map([
        [
          'workspace',
          {
            lody: {
              refreshEncryptedWorkspace: async () => {
                if (!ready) throw new Error('e2ee_waiting_for_key');
                return true;
              },
            },
          },
        ],
      ]),
    });
    await expect(instance.dispatchLocalE2eePairing(request)).rejects.toThrow(
      'e2ee_waiting_for_key'
    );
    ready = true;
    expect(await instance.dispatchLocalE2eePairing(request)).toEqual({
      ok: true,
      type: 'activate',
    });
  });
});
