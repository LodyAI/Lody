import { nativeSessionCredentials } from '@/session/session-credentials';
import { createSessionBackend } from '@/session/session-backend';
import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  ACP_CAPABILITY_REFRESH_CACHE_TTL_MS,
  getAcpCapabilityCacheEntryAuthority,
  getSessionRoomId,
  quotaReservationIdentity,
  SessionStatusFactory,
  type AcpCapabilityCacheEntry,
  type AcpConfigOptionSummary,
  type ACPSessionId,
  type AgentConfigId,
  type MachineFlockKey,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { projectTurnAttention, type TurnOutcomeFact } from '@lody/shared/notifications';
import Database from 'better-sqlite3';
import { Effect } from 'effect';
import type { LoroRepo } from 'loro-repo';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AcpAuthenticationManager } from '../src/agent/acp-authentication';
import { AcpAuthenticationRequiredError } from '../src/agent/agent-client';
import * as codexProfiles from '../src/agent/codex-profile-store';
import { dispatchQuotaSchedule } from '../src/automations/compat/quota-schedule';
import {
  configureSessionPolicies,
  internalPolicy,
  upgradeCapacityPolicies,
} from '../src/automations/policies/session';
import {
  observeSessionTurnLegacy,
  reconcileSessionTurnsLegacy,
} from '../src/automations/sources/sessions-legacy';
import { AutomationLedger } from '../src/automations/storage/ledger';
import { MachineDocument, SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionActivePresencePhase } from '../src/lib/loro/session-active-presence';
import { MessageHandler } from '../src/lib/message-handler';
import { MessageProcessor } from '../src/lib/message-processor';
import { InboxExecutionRejected } from '../src/orchestration/inbox/admission-failure';
import { LodyOperationCoordinator } from '../src/orchestration/operation-coordinator';
import { LodyOperationStore } from '../src/orchestration/operation-store';
import {
  SessionExecutionService,
  type SessionExecutionServiceDeps,
} from '../src/session/session-execution-service';
import type { SessionManager } from '../src/session/session-manager';
import type { SessionConfig } from '../src/session/types';
import { withHistoryPort } from './history-port-fixture';
import {
  capabilityConfigId,
  createBaseDeps,
  createDeadlineHarness,
  createDeferred,
  createGoalService,
  createLaunchConfig,
  createSilentLogger,
  goalArgs,
  goalSessionId,
  inboxExecutionFixture,
} from './session-execution-service-helpers';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});
describe('SessionExecutionService', () => {
  describe('dead assistant turns', () => {
    const setup = (userStatus: 'processing' | 'failed') => {
      const upsertDocMeta = vi.fn(async (_room: string, _patch: Record<string, unknown>) => {});
      const history: Array<Record<string, unknown>> = [
        { id: 'user-dead', role: 'user', status: userStatus, items: [], timestamp: 't0' },
        {
          id: 'assistant:user-dead',
          role: 'assistant',
          userTurnId: 'user-dead',
          items: [{ type: 'text', text: 'partial answer' }],
          timestamp: 't1',
        },
      ];
      const sessionDoc = withHistoryPort({
        getHistory: vi.fn(() => history),
        setStatus: vi.fn(async () => {}),
        updateHistory: vi.fn(async (update: (value: typeof history) => typeof history) => {
          update(history);
        }),
      });
      const deps = createBaseDeps({
        sessionManager: {
          getSession: vi.fn(() => null),
          getPendingSession: vi.fn(() => null),
        } as unknown as SessionManager,
        getActiveTurnId: vi.fn(() => undefined),
        workspaceDocument: {
          repo: {
            upsertDocMeta,
            getDocMeta: vi.fn(async () => ({
              meta: { latestUserMsgId: 'user-dead', processingUserMsgId: 'user-dead' },
            })),
          },
          getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
      });
      return { service: new SessionExecutionService(deps), history, upsertDocMeta, sessionDoc };
    };

    it('Stop closes an ordinary turn whose agent process is gone', async () => {
      const { service, history, upsertDocMeta, sessionDoc } = setup('processing');

      const result = await service.cancelSession({
        type: 'session/cancel',
        sessionId: 'session-dead' as SessionId,
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: 'assistant:user-dead',
      });

      expect(result).toEqual({ success: true });
      expect(history[1]).toMatchObject({ finished: true, endedAt: expect.any(Number) });
      expect(history[0]).toMatchObject({ status: 'canceled' });
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-dead', {
        lastHandledUserMsgId: 'user-dead',
        processingUserMsgId: undefined,
      });
      expect(sessionDoc.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
      expect(upsertDocMeta).toHaveBeenCalledWith('session-session-dead', {
        lastCanceledTurn: undefined,
      });
    });

    it('closes automatically only after the user input settled', async () => {
      const owed = setup('processing');
      // A processing input still owes its crash-recovery run on this entry.
      await expect(
        owed.service.closeDeadAssistantTurn('session-dead' as SessionId, {
          requireSettledUserTurn: true,
        })
      ).resolves.toBe(false);
      expect(owed.history[1]?.finished).toBeUndefined();

      const failed = setup('failed');
      await expect(
        failed.service.closeDeadAssistantTurn('session-dead' as SessionId, {
          requireSettledUserTurn: true,
        })
      ).resolves.toBe(true);
      expect(failed.history[1]).toMatchObject({ finished: true });
      // The settled outcome is kept, not rewritten as a cancellation.
      expect(failed.history[0]).toMatchObject({ status: 'failed' });
      expect(failed.upsertDocMeta).not.toHaveBeenCalled();
    });
  });

  it('keeps a newer queued turn pending when cancelling the currently running turn', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const sessionDoc = withHistoryPort({
      getHistory: vi.fn(() => []),
      setStatus: vi.fn(async () => {}),
      updateHistory: vi.fn(async () => {}),
    });
    const session = {
      acpSessionId: 'acp-queued-cancel' as ACPSessionId,
      agentClient: {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
      },
    };
    const sessionManager = {
      getSession: vi.fn(() => session),
      getPendingSession: vi.fn(() => null),
      createSession: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      validateSessionCredentials: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const deps = createBaseDeps({
      sessionManager,
      getActiveTurnId: vi.fn(() => 'assistant-turn-1'),
      workspaceDocument: {
        repo: {
          upsertDocMeta,
          getDocMeta: vi.fn(async () => ({
            meta: {
              latestUserMsgId: 'turn-queued-2',
              processingUserMsgId: 'turn-running-1',
            },
          })),
        },
        getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.cancelSession({
      type: 'session/cancel',
      sessionId: 'session-queued-cancel' as SessionId,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      turnId: 'assistant-turn-1',
    });

    expect(result).toEqual({ success: true });
    expect(session.agentClient.cancel).toHaveBeenCalledWith('acp-queued-cancel');
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-queued-cancel', {
      lastHandledUserMsgId: 'turn-running-1',
      processingUserMsgId: undefined,
    });
    expect(upsertDocMeta).toHaveBeenCalledWith('session-session-queued-cancel', {
      lastCanceledTurn: undefined,
    });
  });

  it('stops authentication when aborted while the launch config is loading', async () => {
    let resolveConfig!: (value: ReturnType<typeof createLaunchConfig>) => void;
    const config = new Promise<ReturnType<typeof createLaunchConfig>>((resolve) => {
      resolveConfig = resolve;
    });
    const authenticate = vi.spyOn(AcpAuthenticationManager.prototype, 'authenticate');
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          getAgentConfigForMachineLaunch: () => config,
        } as unknown as LoroDocumentManager,
      })
    );
    const controller = new AbortController();
    try {
      const result = service.authenticateMachineAcp(
        {
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'cancel-loading',
          action: 'start',
          configId: capabilityConfigId,
        },
        { signal: controller.signal }
      );
      controller.abort();
      resolveConfig(createLaunchConfig());
      await expect(result).resolves.toMatchObject({ success: true, disposition: 'cancelled' });
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });

  it('cancels a registered authentication when its signal aborts during registration', async () => {
    const controller = new AbortController();
    let finish!: (result: { success: true; disposition: 'cancelled' }) => void;
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockImplementation(() => {
        controller.abort();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
    const cancel = vi.spyOn(AcpAuthenticationManager.prototype, 'cancel').mockImplementation(() => {
      if (finish) finish({ success: true, disposition: 'cancelled' });
      return { success: true, disposition: 'cancelled' };
    });
    const service = new SessionExecutionService(createBaseDeps({}));
    try {
      await expect(
        service.authenticateMachineAcp(
          {
            type: 'machine/acp-authenticate',
            machineId: 'machine-1' as MachineId,
            workspaceId: 'workspace-1' as WorkspaceId,
            requestId: 'cancel-registration',
            action: 'start',
            configId: capabilityConfigId,
          },
          { signal: controller.signal }
        )
      ).resolves.toMatchObject({ disposition: 'cancelled' });
    } finally {
      authenticate.mockRestore();
      cancel.mockRestore();
    }
  });

  it('does not publish capability refresh after authentication is aborted', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finishProbe!: (value: never) => void;
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'authenticated' });
    const updateAcpCapabilities = vi.fn(async () => {});
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities: vi.fn(() => {
          started();
          return new Promise((resolve) => {
            finishProbe = resolve;
          });
        }),
        workspaceDocument: {
          getAgentConfigForMachineLaunch: async () => createLaunchConfig(),
          updateAcpCapabilities,
        } as unknown as LoroDocumentManager,
      })
    );
    try {
      const result = service.authenticateMachineAcp(
        {
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'cancel-refresh',
          action: 'start',
          configId: capabilityConfigId,
        },
        { signal: controller.signal }
      );
      await probeStarted;
      controller.abort();
      finishProbe({
        cliType: 'builtin',
        agentType: 'kimi',
        modes: [],
        models: [],
        configOptions: [],
      } as never);
      await expect(result).resolves.toMatchObject({ disposition: 'cancelled' });
      expect(updateAcpCapabilities).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });

  it('preserves authentication success and auth methods when the follow-up probe still needs auth', async () => {
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'authenticated' });
    const fetchAcpCapabilities = vi.fn(async () => {
      throw new AcpAuthenticationRequiredError([{ type: 'terminal', args: ['--login'] }]);
    });
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities,
        workspaceDocument: {
          getAgentConfigForMachineLaunch: vi.fn(async () =>
            createLaunchConfig({
              cliType: 'builtin',
              agentType: 'kimi',
              env: {},
              runtimeOverrides: { kimiPath: '/test/kimi' },
            })
          ),
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
      })
    );

    try {
      const result = await service.authenticateMachineAcp({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        requestId: 'auth-1',
        action: 'start',
        configId: capabilityConfigId,
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          disposition: 'authenticated',
          capabilitiesRefreshed: false,
          authRequired: true,
          authMethods: [{ type: 'terminal', args: ['--login'] }],
          error: 'Authentication required',
        })
      );
    } finally {
      authenticate.mockRestore();
    }
  });

  it('rejects an endpoint rewrite between displaying the secret form and accepting its key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-auth-binding-'));
    const secrets = new Map<string, string>();
    const store = new codexProfiles.CodexProfileStore(root, {
      get: async (id) => secrets.get(id),
      set: async (id, value) => {
        secrets.set(id, value);
      },
      delete: async (id) => {
        secrets.delete(id);
      },
    });
    let persistedConfig = createLaunchConfig({
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
      codexAuth: {
        mode: 'api-key',
        profileId: '0b772cc2-dc33-4708-aabb-61b7c1cd15c0',
        baseUrl: 'https://confirmed.example.invalid/v1',
      },
    });
    const profileStore = vi.spyOn(codexProfiles, 'getCodexProfileStore').mockReturnValue(store);
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockImplementation(async (options) => {
        try {
          if (!options.authenticateManagedProfile) throw new Error('Missing managed flow');
          await options.authenticateManagedProfile({
            signal: new AbortController().signal,
            requestInput: async (_form, message) => {
              expect(message).toContain('https://confirmed.example.invalid/v1');
              persistedConfig = {
                ...persistedConfig,
                codexAuth: {
                  profileId: '0b772cc2-dc33-4708-aabb-61b7c1cd15c0',
                  mode: 'api-key',
                  baseUrl: 'https://changed.example.invalid/v1',
                },
              };
              return { apiKey: 'synthetic-key-must-not-be-used' };
            },
          });
          return { success: true, disposition: 'authenticated' };
        } catch (error) {
          return { success: false, disposition: 'error', error: String(error) };
        }
      });
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          getAgentConfigForMachineLaunch: async () => persistedConfig,
        } as unknown as LoroDocumentManager,
      })
    );
    try {
      const result = await service.authenticateMachineAcp({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        requestId: 'frozen-api-binding',
        action: 'start',
        configId: capabilityConfigId,
      });
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Provider changed during authentication'),
      });
      expect(secrets.size).toBe(0);
      expect(await store.list('workspace-1')).toHaveLength(1);
    } finally {
      authenticate.mockRestore();
      profileStore.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('launches authentication only from the daemon-authoritative persisted config', async () => {
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'cancelled' });
    const persistedConfig = createLaunchConfig({
      cliType: 'custom',
      agentType: 'persisted-custom',
      customAcp: { command: '/opt/trusted/custom-acp', args: ['--stdio'] },
      env: { TRUSTED_TOKEN: 'from-local-config' },
      runtimeOverrides: undefined,
    });
    const getAgentConfigForMachineLaunch = vi.fn(async () => persistedConfig);
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          getAgentConfigForMachineLaunch,
          updateAcpCapabilities: vi.fn(async () => {}),
        } as unknown as LoroDocumentManager,
      })
    );

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-persisted-custom',
          action: 'start',
          configId: capabilityConfigId,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          success: true,
          disposition: 'cancelled',
          agentType: 'persisted-custom',
        })
      );
      expect(getAgentConfigForMachineLaunch).toHaveBeenCalledWith(capabilityConfigId, 'machine-1');
      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          cliType: 'custom',
          agentType: 'persisted-custom',
          customAcp: { command: '/opt/trusted/custom-acp', args: ['--stdio'] },
          env: { TRUSTED_TOKEN: 'from-local-config' },
        })
      );
    } finally {
      authenticate.mockRestore();
    }
  });

  it('refuses authentication when the config is not persisted on the target machine', async () => {
    const authenticate = vi.spyOn(AcpAuthenticationManager.prototype, 'authenticate');
    const service = new SessionExecutionService(
      createBaseDeps({
        workspaceDocument: {
          getAgentConfigForMachineLaunch: vi.fn(async () => null),
        } as unknown as LoroDocumentManager,
      })
    );

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-missing-config',
          action: 'start',
          configId: 'missing-config' as AgentConfigId,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          success: false,
          disposition: 'error',
          error: expect.stringContaining('Provider config not found or invalid'),
        })
      );
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });

  it('bounds the post-authentication capability proof inside the renderer deadline', async () => {
    vi.useFakeTimers();
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'authenticated' });
    const fetchAcpCapabilities = vi.fn(
      (...args: unknown[]) =>
        new Promise<never>((_resolve, reject) => {
          const signal = (args[5] as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    const service = new SessionExecutionService(createBaseDeps({ fetchAcpCapabilities }));

    try {
      const resultPromise = service.authenticateMachineAcp({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        requestId: 'auth-refresh-timeout',
        action: 'start',
        configId: capabilityConfigId,
      });

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({
          success: true,
          disposition: 'authenticated',
          capabilitiesRefreshed: false,
          error: 'Authentication succeeded, but capability verification timed out',
        })
      );
      expect(fetchAcpCapabilities).toHaveBeenCalledOnce();
    } finally {
      authenticate.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not mark a provider verified when the post-authentication probe has an empty model catalog', async () => {
    const authenticate = vi
      .spyOn(AcpAuthenticationManager.prototype, 'authenticate')
      .mockResolvedValue({ success: true, disposition: 'authenticated' });
    const fetchAcpCapabilities = vi.fn(async () => ({
      modes: [],
      models: [],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select' as const,
          currentValue: 'model-a',
          options: [],
        },
      ],
      sessionFork: false,
      acknowledgedSteer: true,
    }));
    const updateAcpCapabilities = vi.fn(async () => ({
      cliType: 'registry' as const,
      agentType: 'deepseek',
      modes: [],
      models: [],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select' as const,
          currentValue: 'model-a',
          options: [],
        },
      ],
      sessionFork: false,
      acknowledgedSteer: true,
      sessionTitle: false,
      sessionForkWorktree: false,
      fetchedAt: 1,
    }));
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities,
        workspaceDocument: {
          getAgentConfigForMachineLaunch: vi.fn(async () =>
            createLaunchConfig({ cliType: 'registry', agentType: 'deepseek', env: {} })
          ),
          updateAcpCapabilities,
        } as unknown as LoroDocumentManager,
      })
    );

    try {
      const result = await service.authenticateMachineAcp({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        requestId: 'auth-degraded-catalog',
        action: 'start',
        configId: capabilityConfigId,
      });

      // Auth succeeded but the catalog is degraded: not a verification pass.
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          disposition: 'authenticated',
          capabilitiesRefreshed: false,
          error: 'Authentication succeeded, but the provider reported no usable models',
        })
      );
      // The degraded probe is still persisted so the cache can identify it.
      expect(updateAcpCapabilities).toHaveBeenCalledOnce();
    } finally {
      authenticate.mockRestore();
    }
  });

  it('forwards a browser authorization code to the active login process', async () => {
    const submitAuthorizationCode = vi
      .spyOn(AcpAuthenticationManager.prototype, 'submitAuthorizationCode')
      .mockReturnValue({ success: true, disposition: 'input-accepted' });
    const service = new SessionExecutionService(createBaseDeps({}));

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-input-1',
          action: 'submit-code',
          authenticationRequestId: 'auth-1',
          authorizationCode: 'browser-code',
        })
      ).resolves.toEqual(expect.objectContaining({ success: true, disposition: 'input-accepted' }));
      expect(submitAuthorizationCode).toHaveBeenCalledWith('auth-1', 'browser-code');
    } finally {
      submitAuthorizationCode.mockRestore();
    }
  });

  it('forwards a Custom ACP form response to the active authentication request', async () => {
    const submitAuthenticationInput = vi
      .spyOn(AcpAuthenticationManager.prototype, 'submitAuthenticationInput')
      .mockReturnValue({ success: true, disposition: 'input-accepted' });
    const service = new SessionExecutionService(createBaseDeps({}));
    const authenticationInput = JSON.stringify({
      action: 'accept',
      content: { account: 'work', code: 'secret-code' },
    });

    try {
      await expect(
        service.authenticateMachineAcp({
          type: 'machine/acp-authenticate',
          machineId: 'machine-1' as MachineId,
          workspaceId: 'workspace-1' as WorkspaceId,
          requestId: 'auth-input-2',
          action: 'submit-input',
          authenticationRequestId: 'auth-custom',
          interactionId: 'form-1',
          authenticationInput,
        })
      ).resolves.toEqual(expect.objectContaining({ success: true, disposition: 'input-accepted' }));
      expect(submitAuthenticationInput).toHaveBeenCalledWith(
        'auth-custom',
        'form-1',
        authenticationInput
      );
    } finally {
      submitAuthenticationInput.mockRestore();
    }
  });

  it('refreshes machine ACP capabilities and persists them to machine meta', async () => {
    const capability = {
      cliType: 'registry' as const,
      agentType: 'deepseek',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime' as const,
      sourceVersion: 'registry:deepseek:unknown',
      modes: [],
      models: [{ modelId: 'kimi-k3', name: 'Kimi K3' }],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select' as const,
          currentValue: 'kimi-k3',
          options: [{ value: 'kimi-k3', name: 'Kimi K3' }],
        },
        {
          id: 'reasoning_effort',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select' as const,
          currentValue: 'max',
          options: ['low', 'high', 'max'].map((value) => ({ value, name: value })),
        },
      ],
      modelReasoningEfforts: { 'kimi-k3': ['low', 'high', 'max'] },
      sessionFork: false,
      acknowledgedSteer: true,
      sessionForkWorktree: false,
      fetchedAt: 1,
    };
    const updateAcpCapabilities = vi.fn(async () => capability);
    const fetchAcpCapabilities = vi.fn(async () => ({
      modes: [],
      models: capability.models,
      configOptions: capability.configOptions,
      availableCommands: [{ name: 'review', description: 'Review changes' }],
      sessionFork: false,
      acknowledgedSteer: true,
      modelReasoningEfforts: capability.modelReasoningEfforts,
    }));

    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(),
        updateAcpCapabilities,
        getAgentConfigForMachineLaunch: vi.fn(async () =>
          createLaunchConfig({
            agentType: 'deepseek',
            env: { ACP_PROVIDER_TOKEN: 'secret-token' },
          })
        ),
      } as unknown as LoroDocumentManager,
      fetchAcpCapabilities,
    });

    const service = new SessionExecutionService(deps);
    const result = await service.refreshMachineAcpCapabilities({
      type: 'machine/acp-capabilities-refresh',
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    });

    expect(fetchAcpCapabilities).toHaveBeenCalledWith(
      'registry',
      'deepseek',
      { ACP_PROVIDER_TOKEN: 'secret-token' },
      undefined,
      undefined,
      expect.objectContaining({
        onManagedRuntimeProgress: expect.any(Function),
      })
    );
    expect(updateAcpCapabilities).toHaveBeenCalledWith(
      'machine-1',
      capabilityConfigId,
      'registry',
      'deepseek',
      [],
      capability.models,
      capability.configOptions,
      [{ name: 'review', description: 'Review changes' }],
      false,
      'registry:deepseek:unknown',
      capability.modelReasoningEfforts,
      true,
      // Goal actions: this runtime advertises no goal extension.
      undefined,
      { signal: expect.any(AbortSignal) }
    );
    expect(result).toEqual(
      expect.objectContaining({
        type: 'machine/acp-capabilities-refresh_response',
        machineId: 'machine-1',
        configId: capabilityConfigId,
        cliType: 'registry',
        agentType: 'deepseek',
        success: true,
        capability,
      })
    );
  });

  it.each([
    { cliType: 'builtin' as const, readsModels: true },
    { cliType: 'registry' as const, readsModels: false },
  ])(
    'reads every model and reports each one only for a $cliType agent that asked',
    async ({ cliType, readsModels }) => {
      const model = (currentValue: string) => ({
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue,
        options: [
          { value: 'mimo', name: 'MiMo' },
          { value: 'deepseek-flash', name: 'DeepSeek Flash' },
        ],
      });
      const answer = [model('deepseek-flash')];
      const updateAcpCapabilities = vi.fn(async () => ({
        cliType,
        agentType: 'dimcode',
        modes: [],
        models: [],
        fetchedAt: 1,
      }));
      const fetchAcpCapabilities = vi.fn(
        async (...args: Parameters<SessionExecutionServiceDeps['fetchAcpCapabilities']>) => {
          const readModelOptions = args[5]?.readModelOptions;
          readModelOptions?.onProgress?.({
            modelId: 'deepseek-flash',
            modelName: 'DeepSeek Flash',
            index: 2,
            total: 2,
          });
          return {
            modes: [],
            models: [],
            configOptions: [model('mimo')],
            sessionFork: false,
            acknowledgedSteer: false,
            ...(readModelOptions ? { modelConfigOptions: { 'deepseek-flash': answer } } : {}),
          };
        }
      );
      const deps = createBaseDeps({
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(),
          updateAcpCapabilities,
          getAgentConfigForMachineLaunch: vi.fn(async () =>
            createLaunchConfig({ cliType, agentType: 'dimcode' })
          ),
        } as unknown as LoroDocumentManager,
        fetchAcpCapabilities,
      });
      const progress: unknown[] = [];

      await new SessionExecutionService(deps).refreshMachineAcpCapabilities(
        {
          type: 'machine/acp-capabilities-refresh',
          machineId: 'machine-1',
          workspaceId: 'workspace-1' as WorkspaceId,
          configId: capabilityConfigId,
          force: true,
          readModelOptions: true,
        },
        { onAcpBinaryProgress: (message) => progress.push(message) }
      );

      expect(progress).toEqual(
        readsModels
          ? [
              {
                type: 'machine/acp-binary-progress',
                machineId: 'machine-1',
                agentType: 'dimcode',
                status: 'reading-model-options',
                configId: capabilityConfigId,
                modelId: 'deepseek-flash',
                modelName: 'DeepSeek Flash',
                modelIndex: 2,
                modelCount: 2,
              },
            ]
          : []
      );
      const writeOptions = (updateAcpCapabilities.mock.calls[0] as unknown[] | undefined)?.at(-1);
      expect(writeOptions).toMatchObject(
        readsModels ? { modelConfigOptions: { 'deepseek-flash': answer } } : {}
      );
      if (!readsModels) {
        expect(writeOptions).not.toHaveProperty('modelConfigOptions', expect.anything());
      }
    }
  );

  describe('ACP capability refresh cache', () => {
    const sourceVersion = 'opencode@1.0.0';
    const secretToken = 'sk-test-9f3a-low-entropy-token';

    /** Machine Flock rows in memory, behind the real MachineDocument writer. */
    class InMemoryMachineFlock {
      readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();
      commits = 0;
      scan(options?: { prefix?: readonly unknown[] }) {
        return [...this.rows.values()].filter((row) =>
          options?.prefix ? options.prefix.every((part, index) => row.key[index] === part) : true
        );
      }
      set(key: MachineFlockKey, value: unknown): void {
        this.rows.set(JSON.stringify(key), { key: [...key] as MachineFlockKey, value });
      }
      delete(key: MachineFlockKey): void {
        this.rows.delete(JSON.stringify(key));
      }
      commit(): void {
        this.commits += 1;
      }
    }

    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    /**
     * A service whose capability reads and writes go through a real
     * MachineDocument, so persistence decisions (skip, renew, overwrite) are the
     * production ones. Probes always report the same capabilities.
     */
    const createHarness = (
      options: {
        env?: Record<string, string>;
        expectedSourceVersion?: () => string | undefined;
        getAcpCapabilities?: () => Promise<AcpCapabilityCacheEntry | undefined>;
        probeConfigOptions?: () => AcpConfigOptionSummary[] | undefined;
      } = {}
    ) => {
      const flock = new InMemoryMachineFlock();
      const machine = new MachineDocument(
        {
          openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => undefined) })),
          flush: vi.fn(async () => undefined),
        } as unknown as LoroRepo,
        'workspace-1' as WorkspaceId,
        'machine-1' as MachineId,
        () => {}
      );
      let launchConfig = createLaunchConfig({
        cliType: 'registry',
        agentType: 'opencode',
        env: options.env ?? { OPENCODE_API_KEY: secretToken },
      });
      let probes = 0;
      let probeCommands: Array<{ name: string }> | undefined = [{ name: 'review' }];
      let onWrite: (() => void) | undefined;
      const deps = createBaseDeps({
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(),
          getAcpCapabilities:
            options.getAcpCapabilities ??
            ((_machineId: MachineId, configId: AgentConfigId) =>
              machine.getAcpCapabilities(configId)),
          updateAcpCapabilities: async (
            _machineId: MachineId,
            ...rest: Parameters<MachineDocument['updateAcpCapabilities']>
          ) => {
            const entry = await machine.updateAcpCapabilities(...rest);
            onWrite?.();
            onWrite = undefined;
            return entry;
          },
          getAgentConfigForMachineLaunch: vi.fn(async () => launchConfig),
        } as unknown as LoroDocumentManager,
        fetchAcpCapabilities: async () => {
          probes += 1;
          return {
            modes: [{ id: 'default', name: 'Default' }],
            models: [{ modelId: 'model-a', name: 'Model A' }],
            configOptions: options.probeConfigOptions?.(),
            availableCommands: probeCommands,
            sessionFork: false,
            acknowledgedSteer: true,
            capabilitySourceVersion: sourceVersion,
          };
        },
        resolveAcpCapabilitySourceVersion: async () =>
          options.expectedSourceVersion ? options.expectedSourceVersion() : sourceVersion,
      });
      const service = new SessionExecutionService(deps);
      return {
        service,
        setProbeCommands: (commands: typeof probeCommands) => {
          probeCommands = commands;
        },
        publishSessionCommands: (names: string[]) =>
          new Promise<void>((resolve) => {
            onWrite = resolve;
            service['scheduleCreatedSessionCapabilityUpdate'](
              {
                sessionId: 'project-session' as SessionId,
                getAcpCapabilities: () => ({
                  modes: [],
                  models: [],
                  availableCommands: names.map((name) => ({ name })),
                  sessionFork: false,
                }),
                getAcpCapabilitySourceVersion: () => sourceVersion,
              } as unknown as Parameters<
                SessionExecutionService['scheduleCreatedSessionCapabilityUpdate']
              >[0],
              {
                agentConfigId: capabilityConfigId,
                agentCliType: 'registry',
                agentType: 'opencode',
                env: launchConfig.env,
              } as SessionConfig
            );
          }),
        flock,
        probes: () => probes,
        editEnv: (env: Record<string, string>) => {
          launchConfig = { ...launchConfig, env };
        },
        storedEntry: () =>
          [...flock.rows.values()].find((row) => row.key[0] === 'acpCapability')?.value as
            | AcpCapabilityCacheEntry
            | undefined,
      };
    };

    it('keeps project commands out of the probe preview and refreshes that preview independently', async () => {
      const harness = createHarness();
      await harness.publishSessionCommands(['review-a']);
      expect(harness.storedEntry()?.availableCommands).toBeUndefined();
      await harness.service.refreshMachineAcpCapabilities(request);
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'review' }]);
      await harness.publishSessionCommands(['review-a']);
      await harness.publishSessionCommands(['review-b']);
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'review' }]);
      harness.setProbeCommands([{ name: 'refreshed-help' }]);
      await harness.service.refreshMachineAcpCapabilities({ ...request, force: true });
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'refreshed-help' }]);
      await harness.publishSessionCommands([]);
      expect(harness.storedEntry()?.availableCommands).toEqual([{ name: 'refreshed-help' }]);
    });

    it('persists an empty probe as confirmed and serves it without another probe', async () => {
      const harness = createHarness();
      harness.setProbeCommands(undefined);
      const probed = await harness.service.refreshMachineAcpCapabilities(request);
      expect(probed.availableCommands).toEqual([]);
      expect(harness.storedEntry()?.availableCommands).toEqual([]);
      harness.setProbeCommands([{ name: 'must-not-be-probed' }]);
      const cached = await harness.service.refreshMachineAcpCapabilities(request);
      expect(cached.availableCommands).toEqual([]);
      expect(harness.storedEntry()?.availableCommands).toEqual([]);
    });

    const start = new Date('2026-09-20T00:00:00.000Z').getTime();
    const withClock = async (run: () => Promise<void>) => {
      // Only Date is faked: the refresh path has no timers, and freezing the
      // scheduler would stall the service's own promise chains.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start);
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    };

    it('answers from the persisted entry without starting an agent once it has probed it', () =>
      withClock(async () => {
        const harness = createHarness();

        await harness.service.refreshMachineAcpCapabilities(request);
        const cached = await harness.service.refreshMachineAcpCapabilities(request);

        expect(harness.probes()).toBe(1);
        expect(cached).toEqual({
          type: 'machine/acp-capabilities-refresh_response',
          machineId: 'machine-1',
          configId: capabilityConfigId,
          cliType: 'registry',
          agentType: 'opencode',
          success: true,
          modes: [{ id: 'default', name: 'Default', description: undefined }],
          models: [{ modelId: 'model-a', name: 'Model A', description: undefined }],
          configOptions: undefined,
          capability: harness.storedEntry(),
          availableCommands: [{ name: 'review' }],
        });
      }));

    it('keeps answering from the cache after an expired entry is re-probed with identical content', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);

        vi.setSystemTime(start + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS + 1);
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);

        // The probe found nothing new, yet the entry must be fresh again: otherwise
        // every later request re-probes forever.
        vi.setSystemTime(start + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS + 60_000);
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);
        expect(harness.storedEntry()?.fetchedAt).toBe(
          start + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS + 1
        );
      }));

    it('does not write the Machine Flock when a young entry is re-probed with identical content', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);
        const commitsAfterFirstProbe = harness.flock.commits;

        vi.setSystemTime(start + 60 * 60 * 1000);
        await harness.service.refreshMachineAcpCapabilities({ ...request, force: true });

        expect(harness.probes()).toBe(2);
        expect(harness.flock.commits).toBe(commitsAfterFirstProbe);
        expect(harness.storedEntry()?.fetchedAt).toBe(start);
      }));

    it('starts the agent after the config environment is edited', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(1);

        // Neither a registry nor a custom source version depends on env, so the
        // stored sourceVersion still matches; only the launch inputs changed.
        harness.editEnv({ OPENCODE_API_KEY: `${secretToken}-rotated` });
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);

        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);
      }));

    it('probes once after a restart rather than trusting an entry it cannot attribute', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);

        const restarted = createHarness();
        restarted.flock.rows.clear();
        for (const [key, row] of harness.flock.rows) restarted.flock.rows.set(key, row);
        // A fresh process has no record of which launch inputs produced the entry.
        await restarted.service.refreshMachineAcpCapabilities(request);
        await restarted.service.refreshMachineAcpCapabilities(request);

        expect(restarted.probes()).toBe(1);
      }));

    it('never persists the config environment or a derivative of it', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);
        harness.editEnv({ OPENCODE_API_KEY: `${secretToken}-rotated` });
        await harness.service.refreshMachineAcpCapabilities(request);

        const persisted = JSON.stringify([...harness.flock.rows.values()]);
        const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
        for (const secret of [secretToken, `${secretToken}-rotated`]) {
          expect(persisted).not.toContain(secret);
          for (const derived of [sha256(secret), sha256(`OPENCODE_API_KEY=${secret}`)]) {
            // Twelve hex characters is the shortest digest prefix this codebase
            // stores anywhere (the DeepSeek endpoint suffix).
            expect(persisted).not.toContain(derived.slice(0, 12));
          }
        }
      }));

    it('starts the agent when the launch inputs no longer produce the stored source version', () =>
      withClock(async () => {
        let expected = sourceVersion;
        const harness = createHarness({ expectedSourceVersion: () => expected });
        await harness.service.refreshMachineAcpCapabilities(request);

        expected = `${sourceVersion}+override:other-binary`;
        await harness.service.refreshMachineAcpCapabilities(request);

        expect(harness.probes()).toBe(2);
      }));

    it('starts the agent for a forced refresh even when the stored entry is current', () =>
      withClock(async () => {
        const harness = createHarness();
        await harness.service.refreshMachineAcpCapabilities(request);

        await expect(
          harness.service.refreshMachineAcpCapabilities({ ...request, force: true })
        ).resolves.toEqual(expect.objectContaining({ success: true }));
        expect(harness.probes()).toBe(2);
      }));

    it('reports a failed refresh when the persisted entry cannot be read', () =>
      withClock(async () => {
        const harness = createHarness({
          getAcpCapabilities: async () => {
            throw new Error('machine flock document is unreadable');
          },
        });

        await expect(harness.service.refreshMachineAcpCapabilities(request)).resolves.toEqual(
          expect.objectContaining({
            type: 'machine/acp-capabilities-refresh_response',
            success: false,
            error: expect.stringContaining('machine flock document is unreadable'),
          })
        );
        expect(harness.probes()).toBe(0);
      }));

    it('re-probes a persisted entry whose model select advertised zero choices, then caches the healed result', () =>
      withClock(async () => {
        let catalog: AcpConfigOptionSummary[] | undefined = [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'model-a',
            options: [],
          },
        ];
        const harness = createHarness({ probeConfigOptions: () => catalog });

        // The degraded probe persists like any other result...
        const degraded = await harness.service.refreshMachineAcpCapabilities(request);
        expect(degraded.success).toBe(true);
        expect(harness.storedEntry()?.configOptions?.[0]?.options).toEqual([]);
        expect(getAcpCapabilityCacheEntryAuthority(harness.storedEntry(), undefined)).toBe(
          'degraded'
        );

        // ...but it never answers a refresh: the cache misses and probes again.
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(2);

        // Once a real catalog lands, the entry is authoritative again and the
        // next refresh is served from it without another probe.
        catalog = [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'model-a',
            options: [{ value: 'model-a', name: 'Model A' }],
          },
        ];
        await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(3);
        expect(getAcpCapabilityCacheEntryAuthority(harness.storedEntry(), undefined)).toBe(
          'authoritative'
        );

        const cached = await harness.service.refreshMachineAcpCapabilities(request);
        expect(harness.probes()).toBe(3);
        expect(cached.success).toBe(true);
      }));
  });

  it('deduplicates concurrent ACP capability refreshes for the same config and launch inputs', async () => {
    let release: () => void = () => {};
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchAcpCapabilities = vi.fn(async () => {
      await fetched;
      return { modes: [], models: [] };
    });
    const updateAcpCapabilities = vi.fn(async () => {});

    const deps = createBaseDeps({
      workspaceDocument: {
        repo: {
          upsertDocMeta: vi.fn(async () => {}),
          getDocMeta: vi.fn(async () => undefined),
        },
        getOrCreateSessionDoc: vi.fn(),
        getOrOpenSessionCode: vi.fn(async () => null),
        updateAcpCapabilities,
      } as unknown as LoroDocumentManager,
      fetchAcpCapabilities,
    });

    const service = new SessionExecutionService(deps);
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const first = service.refreshMachineAcpCapabilities(request);
    const second = service.refreshMachineAcpCapabilities(request);
    const third = service.refreshMachineAcpCapabilities(request);
    release();
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(1);
    expect(updateAcpCapabilities).toHaveBeenCalledTimes(1);
    expect(a).toEqual(expect.objectContaining({ success: true }));
    expect(b).toEqual(expect.objectContaining({ success: true }));
    expect(c).toEqual(expect.objectContaining({ success: true }));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('keeps shared capability work alive until its last consumer cancels', async () => {
    let releaseFetch!: () => void;
    const fetched = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let sharedSignal!: AbortSignal;
    const fetchAcpCapabilities = vi.fn(async (...args: unknown[]) => {
      const options = args[5] as { signal: AbortSignal };
      sharedSignal = options.signal;
      markFetchStarted();
      await fetched;
      return { modes: [], models: [] };
    });
    const updateAcpCapabilities = vi.fn(async () => {});
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(),
          getOrOpenSessionCode: vi.fn(async () => null),
          updateAcpCapabilities,
        } as unknown as LoroDocumentManager,
      })
    );
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = service.refreshMachineAcpCapabilities(request, {
      signal: firstController.signal,
    });
    const second = service.refreshMachineAcpCapabilities(request, {
      signal: secondController.signal,
    });
    await fetchStarted;

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(sharedSignal.aborted).toBe(false);

    releaseFetch();
    await expect(second).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(updateAcpCapabilities).toHaveBeenCalledTimes(1);
  });

  it('aborts capability probing when its last consumer cancels', async () => {
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let markProbeAborted!: () => void;
    const probeAborted = new Promise<void>((resolve) => {
      markProbeAborted = resolve;
    });
    const fetchAcpCapabilities = vi.fn(async (...args: unknown[]) => {
      const options = args[5] as { signal: AbortSignal };
      markFetchStarted();
      await new Promise<void>((_resolve, reject) => {
        const handleAbort = () => {
          markProbeAborted();
          reject(new DOMException('probe cancelled', 'AbortError'));
        };
        options.signal.addEventListener('abort', handleAbort, { once: true });
        if (options.signal.aborted) handleAbort();
      });
      throw new Error('unreachable');
    });
    const updateAcpCapabilities = vi.fn(async () => {});
    const service = new SessionExecutionService(
      createBaseDeps({
        fetchAcpCapabilities,
        workspaceDocument: {
          repo: {
            upsertDocMeta: vi.fn(async () => {}),
            getDocMeta: vi.fn(async () => undefined),
          },
          getOrCreateSessionDoc: vi.fn(),
          getOrOpenSessionCode: vi.fn(async () => null),
          updateAcpCapabilities,
        } as unknown as LoroDocumentManager,
      })
    );
    const controller = new AbortController();
    const refresh = service.refreshMachineAcpCapabilities(
      {
        type: 'machine/acp-capabilities-refresh',
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
        configId: capabilityConfigId,
      },
      { signal: controller.signal }
    );
    await fetchStarted;

    controller.abort();
    await expect(refresh).rejects.toMatchObject({ name: 'AbortError' });
    await probeAborted;
    expect(updateAcpCapabilities).not.toHaveBeenCalled();
  });

  it('starts a new capability probe while an aborted generation is still cleaning up', async () => {
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let markFirstAborted!: () => void;
    const firstAborted = new Promise<void>((resolve) => {
      markFirstAborted = resolve;
    });
    let releaseFirstCleanup!: () => void;
    const firstCleanup = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    let markFirstFinished!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      markFirstFinished = resolve;
    });
    let callCount = 0;
    const fetchAcpCapabilities = vi.fn(async (...args: unknown[]) => {
      const options = args[5] as { signal: AbortSignal };
      callCount += 1;
      if (callCount === 2) {
        return { modes: [], models: [] };
      }
      markFirstStarted();
      await new Promise<void>((resolve) => {
        const handleAbort = () => {
          markFirstAborted();
          resolve();
        };
        options.signal.addEventListener('abort', handleAbort, { once: true });
        if (options.signal.aborted) handleAbort();
      });
      await firstCleanup;
      markFirstFinished();
      throw new DOMException('old probe cancelled', 'AbortError');
    });
    const service = new SessionExecutionService(createBaseDeps({ fetchAcpCapabilities }));
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };
    const controller = new AbortController();

    const first = service.refreshMachineAcpCapabilities(request, {
      signal: controller.signal,
    });
    await firstStarted;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await firstAborted;

    await expect(service.refreshMachineAcpCapabilities(request)).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2);

    releaseFirstCleanup();
    await firstFinished;
  });

  it('does not deduplicate ACP refreshes for configs sharing the same provider', async () => {
    let release: () => void = () => {};
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchAcpCapabilities = vi.fn(async () => {
      await fetched;
      return { modes: [], models: [] };
    });
    const service = new SessionExecutionService(createBaseDeps({ fetchAcpCapabilities }));
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const first = service.refreshMachineAcpCapabilities(request);
    const second = service.refreshMachineAcpCapabilities({
      ...request,
      configId: 'config-2' as AgentConfigId,
    });
    await vi.waitFor(() => expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
  });

  it('does not deduplicate ACP refreshes across authoritative config revisions', async () => {
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const firstFetched = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondFetched = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let callCount = 0;
    const fetchAcpCapabilities = vi.fn(async () => {
      const which = ++callCount;
      await (which === 1 ? firstFetched : secondFetched);
      return { modes: [], models: [] };
    });

    const getAgentConfigForMachineLaunch = vi
      .fn()
      .mockResolvedValueOnce(createLaunchConfig({ env: { TOKEN: 'A' } }))
      .mockResolvedValueOnce(createLaunchConfig({ env: { TOKEN: 'B' } }));
    const deps = createBaseDeps({
      fetchAcpCapabilities,
      workspaceDocument: {
        getAgentConfigForMachineLaunch,
        updateAcpCapabilities: vi.fn(async () => {}),
      } as unknown as LoroDocumentManager,
    });
    const service = new SessionExecutionService(deps);
    const baseRequest = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const first = service.refreshMachineAcpCapabilities(baseRequest);
    const second = service.refreshMachineAcpCapabilities(baseRequest);

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);

    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2);
    expect(fetchAcpCapabilities).toHaveBeenCalledWith(
      'registry',
      'codex',
      { TOKEN: 'A' },
      undefined,
      undefined,
      expect.objectContaining({
        onManagedRuntimeProgress: expect.any(Function),
      })
    );
    expect(fetchAcpCapabilities).toHaveBeenCalledWith(
      'registry',
      'codex',
      { TOKEN: 'B' },
      undefined,
      undefined,
      expect.objectContaining({
        onManagedRuntimeProgress: expect.any(Function),
      })
    );
  });

  it('clears the ACP refresh dedupe slot after a fetch failure so subsequent calls retry', async () => {
    let fail = true;
    const fetchAcpCapabilities = vi.fn(async () => {
      if (fail) {
        throw new Error('probe failed');
      }
      return { modes: [], models: [] };
    });
    const deps = createBaseDeps({ fetchAcpCapabilities });
    const service = new SessionExecutionService(deps);
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1' as WorkspaceId,
      configId: capabilityConfigId,
    };

    const failed = await service.refreshMachineAcpCapabilities(request);
    expect(failed).toEqual(expect.objectContaining({ success: false, error: 'probe failed' }));

    fail = false;
    const second = await service.refreshMachineAcpCapabilities(request);
    expect(second).toEqual(expect.objectContaining({ success: true }));
    expect(fetchAcpCapabilities).toHaveBeenCalledTimes(2);
  });
});

describe('SessionExecutionService goal control', () => {
  it('pauses out-of-band without opening a turn', async () => {
    const { service, goalStatus } = createGoalService({ transport: 'request' });

    const response = await service.controlSessionGoal({ ...goalArgs, action: 'pause' });

    expect(response).toMatchObject({ accepted: true, disposition: 'applied', action: 'pause' });
    expect(goalStatus()).toBe('pause');
    // The goal's own prompt owns the session's only turn slot; a pause that
    // needed a free slot could never reach the goal it is stopping.
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('refuses an action the agent never advertised', async () => {
    const { service } = createGoalService({ transport: null });

    const response = await service.controlSessionGoal({ ...goalArgs, action: 'resume' });

    expect(response).toMatchObject({ accepted: false, disposition: 'unsupported' });
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('starts a Lody-owned turn for an action that resumes work', async () => {
    const { service, deps, submitted, completion, delivered, failures } = createGoalService({
      transport: 'promptMeta',
    });

    const notified = createDeferred<TurnOutcomeFact>();
    deps.turnFinalization.onTurnOutcome = async (fact) => {
      notified.resolve(fact);
    };
    const response = await service.controlSessionGoal({ ...goalArgs, action: 'resume' });

    expect(response).toMatchObject({ accepted: true, disposition: 'queued' });
    await submitted.promise;
    expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
    expect(failures).toEqual([]);
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(true);
    expect(service.getActiveInvocationContext(goalSessionId)).toMatchObject({
      sender: { kind: 'user' },
    });
    const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
    expect(service.getActiveInvocationContext(goalSessionId)?.notificationOriginTurnIds).toEqual([
      expect.stringMatching(/^goal:resume:/),
    ]);
    completion.resolve();
    await released;
    expect(await notified.promise).toMatchObject({
      audience: { kind: 'user' },
      outcome: { kind: 'succeeded' },
      scope: { recipientId: 'owner-user' },
    });
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('retains an accepted goal across more than three competing turns', async () => {
    const { service, submitted, completion, delivered } = createGoalService({
      transport: 'promptMeta',
    });
    const internals = service as unknown as {
      currentTurnBySession: Map<SessionId, string>;
      clearCurrentTurn: (sessionId: SessionId, turnId: string) => void;
    };
    let waiting = createDeferred<void>();
    const originalWait = service.waitForTurnRelease.bind(service);
    vi.spyOn(service, 'waitForTurnRelease').mockImplementation((sessionId, turnId) => {
      const result = originalWait(sessionId, turnId);
      waiting.resolve();
      return result;
    });
    internals.currentTurnBySession.set(goalSessionId, 'busy-0');
    expect(await service.controlSessionGoal({ ...goalArgs, action: 'resume' })).toMatchObject({
      accepted: true,
      disposition: 'queued',
    });
    for (let index = 0; index < 4; index += 1) {
      await waiting.promise;
      waiting = createDeferred<void>();
      internals.clearCurrentTurn(goalSessionId, `busy-${index}`);
      internals.currentTurnBySession.set(goalSessionId, `busy-${index + 1}`);
    }
    await waiting.promise;
    expect(delivered).toEqual([]);
    internals.clearCurrentTurn(goalSessionId, 'busy-4');
    await submitted.promise;
    expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
    const released = originalWait(goalSessionId, 'turn-1');
    completion.resolve();
    await released;
  });

  it.each(['pause', 'clear'] as const)(
    'a newer %s supersedes resume while metadata is loading',
    async (action) => {
      const { service, agentClient, sessionDoc, delivered, goalStatus } = createGoalService({
        transport: 'promptMeta',
      });
      const metadataRead = createDeferred<void>();
      const metadataReady = createDeferred<void>();
      const originalMeta = sessionDoc.getMetaState;
      sessionDoc.getMetaState = async () => {
        metadataRead.resolve();
        await metadataReady.promise;
        return originalMeta();
      };
      const internals = service as unknown as {
        startGoalTurn: (request: unknown) => Promise<boolean>;
      };
      const originalStart = internals.startGoalTurn.bind(service);
      const settled = createDeferred<void>();
      vi.spyOn(internals, 'startGoalTurn').mockImplementation(async (request) => {
        try {
          return await originalStart(request);
        } finally {
          settled.resolve();
        }
      });
      await service.controlSessionGoal({ ...goalArgs, action: 'resume' });
      await metadataRead.promise;
      agentClient.resolveGoalActionTransport = () => 'request';
      await service.controlSessionGoal({ ...goalArgs, action });
      metadataReady.resolve();
      await settled.promise;
      expect(goalStatus()).toBe(action);
      expect(delivered).toEqual([]);
      expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
    }
  );

  it.each([false, true])(
    'only a matching Stop invalidates queued goal work (stale=%s)',
    async (stale) => {
      const { service, delivered, submitted, completion } = createGoalService({
        transport: 'promptMeta',
      });
      const internals = service as unknown as {
        currentTurnBySession: Map<SessionId, string>;
        pendingGoalTurnBySession: Map<SessionId, unknown>;
        clearCurrentTurn: (sessionId: SessionId, turnId: string) => void;
      };
      internals.currentTurnBySession.set(goalSessionId, 'draining');
      await service.controlSessionGoal({ ...goalArgs, action: 'resume' });
      await service.cancelSession({
        type: 'session/cancel',
        sessionId: goalSessionId,
        machineId: 'machine-1' as MachineId,
        workspaceId: 'workspace-1' as WorkspaceId,
        turnId: stale ? 'older' : 'draining',
      });
      expect(internals.pendingGoalTurnBySession.has(goalSessionId)).toBe(stale);
      internals.clearCurrentTurn(goalSessionId, 'draining');
      if (stale) {
        await submitted.promise;
        expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
        const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
        completion.resolve();
        await released;
      } else {
        expect(delivered).toEqual([]);
        expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
      }
    }
  );

  it('fences a superseded resume after turn ownership but before provider submission', async () => {
    const { service, deps, agentClient, delivered, goalStatus, submitted, completion } =
      createGoalService({
        transport: 'promptMeta',
      });
    const preparing = createDeferred<void>();
    const ready = createDeferred<void>();
    deps.applyAcpModeAndModel = async (_session, config) => {
      expect(config.modelId).toBeUndefined();
      expect(config.modeId).toBeUndefined();
      preparing.resolve();
      await ready.promise;
    };
    await service.controlSessionGoal({ ...goalArgs, action: 'resume' });
    await preparing.promise;
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(true);
    agentClient.resolveGoalActionTransport = () => 'request';
    await service.controlSessionGoal({ ...goalArgs, action: 'pause' });
    const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
    const outcome = Promise.race([
      submitted.promise.then(() => 'submitted'),
      released.then(() => 'released'),
    ]);
    ready.resolve();
    const first = await outcome;
    completion.resolve();
    await released;
    expect(first).toBe('released');
    expect(goalStatus()).toBe('pause');
    expect(delivered).toEqual([]);
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('records a visible failure when an accepted action cannot load its configuration', async () => {
    const { service, sessionDoc, failed, failures, delivered } = createGoalService({
      transport: 'promptMeta',
    });
    sessionDoc.getMetaState = async () => {
      throw new Error('Synthetic metadata failure');
    };
    expect(await service.controlSessionGoal({ ...goalArgs, action: 'resume' })).toMatchObject({
      accepted: true,
      disposition: 'queued',
    });
    await failed.promise;
    expect(failures).toEqual(['Goal resume failed: Synthetic metadata failure']);
    expect(delivered).toEqual([]);
    expect(service.getExecutionSnapshot(goalSessionId).hasActiveTurn).toBe(false);
  });

  it('keeps only the newest queued action so a stale pause cannot undo a resume', async () => {
    const { service, submitted, completion, delivered } = createGoalService({
      transport: 'promptMeta',
    });
    const internals = service as unknown as {
      currentTurnBySession: Map<SessionId, string>;
      clearCurrentTurn: (sessionId: SessionId, turnId?: string) => void;
    };
    internals.currentTurnBySession.set(goalSessionId, 'draining-turn');

    await service.controlSessionGoal({ ...goalArgs, action: 'pause' });
    await service.controlSessionGoal({ ...goalArgs, action: 'resume' });

    internals.clearCurrentTurn(goalSessionId, 'draining-turn');
    await submitted.promise;
    expect(delivered).toEqual([expect.objectContaining({ goalControl: { action: 'resume' } })]);
    const released = service.waitForTurnRelease(goalSessionId, 'turn-1');
    completion.resolve();
    await released;
  });
});

describe('SessionExecutionService initialization deadline', () => {
  it('fails a turn whose initialization dependency never returns, and stops its presence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const harness = createDeadlineHarness({
        sessionId: 'session-stalled-init',
        // The observed production failure: a cloud identity lookup that never
        // settled, leaving createSession pending forever.
        onCreateSession: () => new Promise(() => {}),
      });
      const turn = harness.start();
      await harness.settle();

      // Well inside the 180s budget the turn is still initializing and still
      // heartbeating — the watchdog must not fire early.
      await harness.advance(170_000);
      expect(harness.getHistory()[0]?.status).toBe('processing');
      const heartbeatsBeforeStall = harness.heartbeatsFor('session-stalled-init').length;
      expect(heartbeatsBeforeStall).toBeGreaterThan(1);

      await harness.advance(20_000);
      await turn;

      // The user sees an explicit failure naming the stalled stage, not silence.
      expect(harness.deps.recordChatFailure).toHaveBeenCalledWith(
        harness.sessionDoc,
        'session_init_failed',
        expect.stringContaining('stopped making progress')
      );
      expect(harness.getHistory()[0]?.status).toBe('failed');
      expect(harness.sessionDoc.setStatus.mock.calls.at(-1)?.[0]).toEqual(
        SessionStatusFactory.idle()
      );

      // Presence is gone, and the 10s heartbeat that woke every subscriber for
      // 1h51m in production has stopped for good.
      expect(harness.presenceEvents.at(-1)).toEqual({
        kind: 'clear',
        sessionId: 'session-stalled-init',
      });
      const heartbeatsAtFailure = harness.heartbeatsFor('session-stalled-init').length;
      await harness.advance(600_000);
      expect(harness.heartbeatsFor('session-stalled-init').length).toBe(heartbeatsAtFailure);

      // The turn runtime is released, so the session stops counting as active
      // and becomes collectable again.
      expect(
        harness.service.getExecutionSnapshot('session-stalled-init' as SessionId).hasActiveTurn
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the retry after a stall start a fresh create instead of the wedged one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const promptStarted = createDeferred<void>();
      const promptDone = createDeferred<object>();
      let staleProgress: ((phase: SessionActivePresencePhase, detail?: string) => void) | undefined;
      const agentClient = {
        isCreated: vi.fn(() => true),
        cancel: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          promptStarted.resolve();
          return await promptDone.promise;
        }),
        currentModel: undefined,
      };
      const harness = createDeadlineHarness({
        sessionId: 'session-stall-then-retry',
        onCreateSession: (config, attempt) => {
          if (attempt === 1) staleProgress = config.onPresencePhase;
          // First attempt wedges forever; the second is a healthy create.
          return attempt === 1
            ? new Promise(() => {})
            : Promise.resolve({
                sessionId: 'session-stall-then-retry' as SessionId,
                acpSessionId: 'acp-1' as ACPSessionId,
                agentClient,
                terminalManager: {} as unknown,
                getWorkdir: () => '/tmp',
                getGitHubCredentials: () => nativeSessionCredentials,
                getHostWorkdir: () => '/tmp',
                getParentSessionId: () => undefined,
                exec: vi.fn(async () => ''),
                terminate: vi.fn(async () => {}),
                updateGitIdentity: vi.fn(),
                createAgent: vi.fn(async () => 'acp-1'),
                applyExecutionPlaneLimits: vi.fn(async () => {}),
              });
        },
      });

      const stalledTurn = harness.start();
      await harness.settle();
      await harness.advance(190_000);
      await stalledTurn;

      expect(harness.getHistory()[0]?.status).toBe('failed');
      // The wedged create must not be left in the deduplication map, or the
      // retry below is handed the same promise and stalls again.
      expect(harness.pendingCreates.size).toBe(0);

      // Retrying is sending the message again. It has to actually run.
      harness.appendUserTurn('turn-user-2');
      const retryTurn = harness.start('turn-user-2');
      await harness.settle();
      await promptStarted.promise;
      staleProgress?.('managed-runtime', 'Synthetic stale progress');
      expect(harness.heartbeatsFor('session-stall-then-retry').at(-1)?.status).toEqual({
        type: 'running',
      });
      promptDone.resolve({});
      await retryTurn;

      expect(agentClient.prompt).toHaveBeenCalled();
      expect(harness.getHistory()[1]?.status).toBe('handled');
      // Only the first turn failed; the retry did not stall a second time.
      expect(harness.deps.recordChatFailure).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stage that reports progress alive past its budget, and fails it once it goes silent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let reportProgress!: (detail: string) => void;
      const harness = createDeadlineHarness({
        sessionId: 'session-runtime-download',
        // A managed-runtime download: the real SessionManager reports percent
        // through `onPresencePhase`, which is this stage's only progress signal.
        onCreateSession: (config) =>
          new Promise(() => {
            config.onPresencePhase?.('managed-runtime', 'Downloading Kimi runtime 1%');
            reportProgress = (detail) => config.onPresencePhase?.('managed-runtime', detail);
          }),
        stallBudgetsMs: { 'managed-runtime': 60_000 },
      });
      const turn = harness.start();
      await harness.settle();

      // A slow but healthy download: far past the 60s budget in wall-clock, yet
      // never silent for a whole budget, so it must survive.
      for (let percent = 2; percent <= 10; percent += 1) {
        await harness.advance(50_000);
        reportProgress(`Downloading Kimi runtime ${percent}%`);
      }
      expect(harness.getHistory()[0]?.status).toBe('processing');

      // Now the transfer wedges: no further progress for a full budget.
      await harness.advance(70_000);
      await turn;

      expect(harness.deps.recordChatFailure).toHaveBeenCalledWith(
        harness.sessionDoc,
        'session_init_failed',
        expect.stringContaining('Downloading Kimi runtime 10%')
      );
      expect(harness.getHistory()[0]?.status).toBe('failed');
      expect(harness.presenceEvents.at(-1)).toEqual({
        kind: 'clear',
        sessionId: 'session-runtime-download',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Operation Inbox execution boundary', () => {
  describe('machine identity restore admission', () => {
    const pendingState = async (f: ReturnType<typeof inboxExecutionFixture>) => ({
      history: await (await createSessionBackend(f.doc)).readHistory(),
      meta: await f.doc.getMetaState(),
      pending: f.store.inbox.pending('workspace-1'),
    });
    const expectUnexecuted = async (
      f: ReturnType<typeof inboxExecutionFixture>,
      before: Awaited<ReturnType<typeof pendingState>>,
      delivered: ContentBlock[][]
    ) => {
      expect(await pendingState(f)).toEqual(before);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        false
      );
      expect(delivered).toEqual([]);
    };

    it('preserves a queued chat released after restore seals intake', async () => {
      const delivered: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        delivered.push(blocks);
        return { stopReason: 'end_turn' };
      });
      const processor = new MessageProcessor(createSilentLogger(), 1);
      const entered = createDeferred();
      const release = createDeferred();
      try {
        await f.accept();
        const before = await pendingState(f);
        processor.enqueue(
          {
            type: 'machine/status',
            machineId: 'machine-1' as MachineId,
            workspaceId: f.message.workspaceId,
          },
          async () => {
            entered.resolve();
            await release.promise;
          }
        );
        await entered.promise;
        processor.enqueue(f.message, async () => f.service.continueSession(f.message));
        f.service.stopNewIdentityRestoreExecutions();
        processor.stop();
        release.resolve();
        await processor.drain();
        await expectUnexecuted(f, before, delivered);
      } finally {
        release.resolve();
        await processor.drain();
        await f.close();
      }
    });

    it.each(['create', 'chat'] as const)(
      'preserves %s input when restore seals while its document opens',
      async (mode) => {
        const delivered: ContentBlock[][] = [];
        const f = inboxExecutionFixture(async (blocks) => {
          delivered.push(blocks);
          return { stopReason: 'end_turn' };
        });
        const entered = createDeferred();
        const release = createDeferred();
        let running: Promise<void> | undefined;
        try {
          await f.accept();
          const before = await pendingState(f);
          const open = vi
            .spyOn(f.deps.workspaceDocument, 'getOrCreateSessionDoc')
            .mockImplementationOnce(async () => {
              entered.resolve();
              await release.promise;
              return f.doc;
            });
          running =
            mode === 'create'
              ? f.service.startSession({ ...f.message, type: 'session/create' })
              : f.service.continueSession(f.message);
          await entered.promise;
          f.service.stopNewIdentityRestoreExecutions();
          release.resolve();
          await running;
          open.mockRestore();
          await expectUnexecuted(f, before, delivered);
        } finally {
          release.resolve();
          await running;
          await f.close();
        }
      }
    );

    it('rechecks after Inbox preparation before registering a prepared Turn', async () => {
      const delivered: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        delivered.push(blocks);
        return { stopReason: 'end_turn' };
      });
      const entered = createDeferred();
      const release = createDeferred();
      let running: Promise<void> | undefined;
      try {
        await f.accept();
        const before = await pendingState(f);
        const read = f.doc.getDocState.bind(f.doc);
        vi.spyOn(f.doc, 'getDocState').mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return read();
        });
        running = f.service.dispatchPreparedSessionTurn({
          sessionId: f.message.sessionId,
          sessionDoc: f.doc,
          userTurnId: f.message.userTurnId,
          invocation: {
            sourceTurnId: f.message.userTurnId,
            requesterUserId: 'user-1',
            inputConfig: f.message.acpSessionConfig,
          },
          dispatchSource: 'rpc',
          accessPromise: Promise.resolve({ outcome: 'allowed' }),
          requestPromise: Promise.resolve({ mode: 'continue', request: f.message }),
          onAccessAllowed: async () => {},
          onAccessDenied: async () => {},
          onAccessIndeterminate: async () => {},
        });
        await entered.promise;
        f.service.stopNewIdentityRestoreExecutions();
        release.resolve();
        await running;
        await expectUnexecuted(f, before, delivered);
      } finally {
        release.resolve();
        await running;
        await f.close();
      }
    });

    it('refuses restore for a registered Turn before active presence is published', async () => {
      const access = createDeferred<{
        outcome: 'indeterminate';
        cause: 'network';
        error: string;
      }>();
      const deps = createBaseDeps({});
      const service = new SessionExecutionService(deps);
      // Exercise the real Handler recovery gate with an intentionally absent
      // presence lease: the registered execution owner alone must refuse restore.
      const handler: MessageHandler = Object.assign(Object.create(MessageHandler.prototype), {
        executionService: service,
        sessionActivePresence: { activeSessionCount: () => 0 },
        baseMachineLifecycleCapability: { canRemoteRestart: true },
        onProcessLifecycleAction: () => {},
        machineId: 'machine-1',
        userId: 'owner-user',
        isMachineIdentityRestoreIdle: (): boolean => handler.isIdentityRestoreExecutionIdle(),
      });
      const sessionId = 'restore-pre-presence' as SessionId;
      const running = service.dispatchPreparedSessionTurn({
        sessionId,
        sessionDoc: {} as SessionDocument,
        userTurnId: 'pending-input',
        invocation: {
          sourceTurnId: 'pending-input',
          requesterUserId: 'owner-user',
          inputConfig: {},
        },
        dispatchSource: 'rpc',
        accessPromise: access.promise,
        requestPromise: new Promise<never>(() => {}),
        onAccessAllowed: async () => {},
        onAccessDenied: async () => {},
        onAccessIndeterminate: async () => {},
      });
      try {
        expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(true);
        expect(handler.isIdentityRestoreExecutionIdle()).toBe(false);
        const response = await (
          handler as unknown as {
            prepareMachineRestart(args: {
              restoreMachineId: string;
              requesterUserId: string;
              requestToken: string;
              requestId: string;
            }): Promise<{ accepted: boolean; error?: string }>;
          }
        ).prepareMachineRestart({
          restoreMachineId: 'old-machine',
          requesterUserId: 'owner-user',
          requestToken: 'synthetic-unverified-request',
          requestId: 'active-turn-recovery',
        });
        expect(response.accepted).toBe(false);
        expect(response.error).toContain('Stop all tasks');
        expect(service.getExecutionSnapshot(sessionId).hasActiveTurn).toBe(true);
      } finally {
        access.resolve({ outcome: 'indeterminate', cause: 'network', error: 'offline' });
        await running;
      }
      expect(handler.isIdentityRestoreExecutionIdle()).toBe(true);
    });

    it('executes and settles ordinary input when recovery is not sealed', async () => {
      const delivered: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        delivered.push(blocks);
        return { stopReason: 'end_turn' };
      });
      try {
        await f.accept();
        expect(f.service.isMachineIdentityRestoreIdle()).toBe(true);
        await f.service.continueSession(f.message);
        expect(delivered).toEqual([[{ type: 'text', text: 'CURRENT_REQUEST' }]]);
        expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
          true
        );
        const history = await (await createSessionBackend(f.doc)).readHistory();
        expect(history.find((turn) => turn.id === 'human-input')?.status).toBe('handled');
        expect(f.service.isMachineIdentityRestoreIdle()).toBe(true);
      } finally {
        await f.close();
      }
    });
  });

  it.each([
    'automation-first',
    'cancelled-accepted',
    'schedule-first',
    'concurrent',
    'schedule-concurrent',
    'unassociated',
    'resumed',
  ] as const)('accepts only the first associated quota continuation (%s)', async (first) => {
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const ledger = new AutomationLedger({ kind: 'memory' }, 'workspace-1', 'machine-1');
    const sessionId = f.message.sessionId;
    const reset = Date.parse('2026-10-12T05:00:00Z');
    const identity = quotaReservationIdentity('workspace-1', sessionId, reset, 'human-input');
    const scheduleId = identity.scheduleId;
    const run = {
      workspaceId: 'workspace-1',
      sessionId,
      scheduleId,
      manual: false,
      message: { inputBlocks: [{ type: 'text', text: 'continue' }] },
      definition: {
        scheduleId,
        activationId: first === 'resumed' ? 'resumed-activation' : identity.activationId,
        activeFrom: reset + 1000,
        trigger: { kind: 'once', at: new Date(reset + 1000).toISOString() },
        destination: { kind: 'existing_session', sessionId },
      },
    } as unknown as import('../src/lib/schedules/schedule-store').ScheduleRun<
      import('../src/lib/prepared-session-input').PreparedSessionInput
    >;
    const scheduledTurn = {
      id: 'scheduled-turn',
      role: 'user' as const,
      userId: 'user-1',
      status: 'prepared' as const,
      timestamp: '2026-10-12T00:00:00Z',
      items: [{ type: 'text' as const, text: 'continue' }],
      inputConfig: f.message.acpSessionConfig,
      finished: true,
      fileDiff: [],
    };
    const prepared = {
      sessionId,
      userTurn: scheduledTurn,
      meta: {},
    } as unknown as import('../src/lib/prepared-session-input').PreparedSessionInput;
    const workId = 'quota-work';
    const admissionEntered = createDeferred();
    const releaseAdmission = createDeferred();
    const scheduleEntered = createDeferred();
    const releaseSchedule = createDeferred();
    try {
      await f.deps.workspaceDocument.repo.upsertDocMeta(getSessionRoomId(sessionId), {
        latestUserMsgId: 'human-input',
      });
      await (await createSessionBackend(f.doc)).appendHistoryTurn(scheduledTurn);
      configureSessionPolicies(ledger, sessionId, 'user-1', { recoverCapacity: true }, 1);
      ledger.recordWork(
        {
          id: workId,
          ownerUserId: 'user-1',
          updatedAt: 2,
          sessionId,
          turnId: 'human-input',
          nativeSessionId: 'acp-inbox',
          bindingId: capabilityConfigId,
          fingerprint: 'frozen-launch',
          inputRef: 'human-input',
          confirmedBoundary: 'assistant:human-input',
          unresolvedEffects: false,
          release: 'released',
          state: 'blocked_on_capacity',
          attempts: 0,
        },
        {
          id: workId,
          source: 'session/test',
          type: 'provider.quota.exhausted',
          version: 1,
          subject: workId,
          observedAt: 2,
          scope: { workspaceId: 'workspace-1', sessionId },
          data: { workId },
          provenance: 'callback',
          completeness: 'observed',
          depth: 0,
        }
      );
      const delivery = ledger.deliveries()[0];
      if (!delivery) throw new Error('missing quota delivery');
      const intent = internalPolicy(delivery)[0];
      if (!intent) throw new Error('missing recovery intent');
      const receipt = ledger.accept(delivery, intent, 3);
      expect(ledger.claimWork(workId, receipt.id)).toBe(true);
      const origin = {
        invocationId: receipt.id,
        ruleId: receipt.rule.id,
        ruleRevision: receipt.rule.revision,
        eventRef: 'event',
        authorizationUserId: 'user-1',
        workIntentId: workId,
      };
      f.service.setAutomationAdmission(
        async () => true,
        () => true,
        async () => {
          if (first === 'concurrent') {
            admissionEntered.resolve();
            await releaseAdmission.promise;
          }
          return (await f.doc.getMetaState())?.latestUserMsgId === 'human-input';
        }
      );
      const automatic = () =>
        f.service.acceptAutomationInput({
          sessionId,
          turnId: receipt.turnId,
          userId: 'user-1',
          config: { ...f.message.acpSessionConfig, _lodyAutomation: origin },
        });
      const authority = {
        guardInput: (
          id: SessionId,
          userId: string,
          body: () => Promise<'dispatched' | 'discarded'>
        ) => f.service.guardAutomationAction([id], userId, body),
        inputAccepted: (id: SessionId, userId: string, turnId: string) =>
          f.service.automationInputAccepted(id, userId, turnId),
      } as unknown as import('../src/session/session-automation-authority').SessionAutomationAuthority;
      const scheduled = () =>
        dispatchQuotaSchedule({
          run,
          prepared,
          userId: 'user-1',
          ledger,
          manager: f.deps.workspaceDocument,
          authority,
        });
      if (first === 'automation-first' || first === 'cancelled-accepted') {
        expect(await automatic()).toBe(true);
        if (first === 'cancelled-accepted') {
          f.store.inbox.abandonInput('workspace-1', sessionId, receipt.turnId);
          expect(
            f.store.inbox.inputKind(
              { workspaceId: 'workspace-1', sessionId, userId: 'user-1' },
              receipt.turnId
            )
          ).toBeUndefined();
        }
        const reopened = new LodyOperationStore(f.storePath);
        try {
          expect(
            reopened.inbox.acceptedAutomationInput(
              { workspaceId: 'workspace-1', sessionId, userId: 'user-1' },
              receipt.turnId
            )
          ).toBe(true);
        } finally {
          reopened.close();
        }
        expect(await scheduled()).toBe('discarded');
        expect((await f.doc.getMetaState())?.latestUserMsgId).toBe('human-input');
      } else if (first === 'schedule-first' || first === 'resumed') {
        expect(await scheduled()).toBe('dispatched');
        expect(await automatic()).toBe(false);
        expect((await f.doc.getMetaState())?.latestUserMsgId).toBe('scheduled-turn');
      } else if (first === 'concurrent') {
        const accepted = automatic();
        await admissionEntered.promise;
        const attempted = scheduled();
        expect(
          await f.service.guardAutomationAction(
            ['other-session' as SessionId],
            'user-1',
            async () => 'independent'
          )
        ).toBe('independent');
        releaseAdmission.resolve();
        expect(await accepted).toBe(true);
        expect(await attempted).toBe('discarded');
      } else if (first === 'schedule-concurrent') {
        const repo = f.deps.workspaceDocument.repo;
        const upsert = repo.upsertDocMeta.bind(repo);
        vi.spyOn(repo, 'upsertDocMeta').mockImplementation(async (...args) => {
          scheduleEntered.resolve();
          await releaseSchedule.promise;
          return upsert(...args);
        });
        const attempted = scheduled();
        await scheduleEntered.promise;
        const accepted = automatic();
        releaseSchedule.resolve();
        expect(await attempted).toBe('dispatched');
        expect(await accepted).toBe(false);
      } else {
        await f.deps.workspaceDocument.repo.upsertDocMeta(getSessionRoomId(sessionId), {
          latestUserMsgId: 'newer-user-input',
        });
        expect(await scheduled()).toBe('discarded');
        expect((await f.doc.getMetaState())?.latestUserMsgId).toBe('newer-user-input');
      }
    } finally {
      releaseAdmission.resolve();
      releaseSchedule.resolve();
      ledger.close();
      await f.close();
    }
  });

  it.each([true, false])(
    'checks the live private provider binding at final automation admission (match=%s)',
    async (matches) => {
      const prompts: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        prompts.push(blocks);
        return { stopReason: 'end_turn' };
      });
      const origin = {
        invocationId: 'invocation',
        ruleId: 'rule',
        ruleRevision: 1,
        eventRef: 'event',
        authorizationUserId: 'user-1',
        workIntentId: 'work',
        nativeSessionId: 'acp-inbox',
      };
      const observed: Array<string | undefined> = [];
      f.service.setAutomationAdmission(
        async () => true,
        (_session, _turn, _origin, binding) => {
          observed.push(binding?.fingerprint);
          return matches && binding?.fingerprint === 'frozen-launch';
        },
        async () => true
      );
      try {
        await f.service.continueSession({
          ...f.message,
          acpSessionConfig: { ...f.message.acpSessionConfig, _lodyAutomation: origin },
        });
        expect(observed).toEqual(['frozen-launch']);
        expect(prompts).toHaveLength(matches ? 1 : 0);
        expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
        const input = (await (await createSessionBackend(f.doc)).readHistory()).find(
          (turn) => turn.id === f.message.userTurnId
        );
        expect(input?.status).toBe(matches ? 'handled' : 'failed');
        expect(JSON.stringify(input?.inputConfig)).not.toContain('frozen-launch');
      } finally {
        await f.close();
      }
    }
  );

  it.each([
    ['denied', 'failed'],
    // `seen` stays dispatchable for the watcher's retry.
    ['pending', 'seen'],
  ] as const)(
    'admits encrypted automation input only on verified evidence (%s)',
    async (evidence, status) => {
      const prompts: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        prompts.push(blocks);
        return { stopReason: 'end_turn' };
      });
      const origin = {
        invocationId: 'invocation',
        ruleId: 'rule',
        ruleRevision: 1,
        eventRef: 'event',
        authorizationUserId: 'user-1',
      };
      let admitted = 0;
      f.service.setAutomationAdmission(async () => {
        admitted += 1;
        return true;
      });
      Object.assign((f.service as unknown as { deps: object }).deps, {
        encryptedExecution: {
          automationEvidence: () => Effect.succeed(evidence),
          claim: () =>
            Effect.succeed(
              evidence === 'pending' ? { state: 'pending-evidence' } : { state: 'denied' }
            ),
          complete: () => Effect.void,
        },
      });
      try {
        await f.service.continueSession({
          ...f.message,
          acpSessionConfig: { ...f.message.acpSessionConfig, _lodyAutomation: origin },
        });
        expect(admitted).toBe(0);
        expect(prompts).toHaveLength(0);
        const input = (await (await createSessionBackend(f.doc)).readHistory()).find(
          (turn) => turn.id === f.message.userTurnId
        );
        expect(input?.status).toBe(status);
      } finally {
        await f.close();
      }
    }
  );

  it.each([true, false])(
    'checks current worktree HEAD before delivering CI evidence (match=%s)',
    async (matches) => {
      const prompts: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        prompts.push(blocks);
        return { stopReason: 'end_turn' };
      });
      const head = 'a'.repeat(40);
      f.session.exec = async (...args: unknown[]) => {
        const command = JSON.stringify(args);
        return command.includes('--is-inside-work-tree')
          ? 'true'
          : command.includes('HEAD')
            ? head
            : '';
      };
      f.service.setAutomationAdmission(
        async () => true,
        () => true
      );
      try {
        await f.service.continueSession({
          ...f.message,
          acpSessionConfig: {
            ...f.message.acpSessionConfig,
            _lodyAutomation: {
              invocationId: 'ci',
              ruleId: 'wait',
              ruleRevision: 1,
              eventRef: 'ci-result',
              authorizationUserId: 'user-1',
              expectedHeads: [
                { repository: 'owner/repo', headSha: matches ? head : 'b'.repeat(40) },
              ],
            },
          },
        });
        expect(prompts).toHaveLength(matches ? 1 : 0);
        const input = (await (await createSessionBackend(f.doc)).readHistory()).find(
          (turn) => turn.id === f.message.userTurnId
        );
        expect(input?.status).toBe(matches ? 'handled' : 'failed');
      } finally {
        await f.close();
      }
    }
  );

  it('keeps a parent archive barrier unavailable until its child execution releases', async () => {
    const started = createDeferred();
    const finish = createDeferred();
    const f = inboxExecutionFixture(async () => {
      started.resolve();
      await finish.promise;
      return { stopReason: 'end_turn' };
    });
    const parentId = 'parent' as SessionId;
    const originalMeta = f.doc.getMetaState.bind(f.doc);
    f.doc.getMetaState = async () =>
      ({ ...(await originalMeta()), parentSessionId: parentId }) as SessionMeta;
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await started.promise;
      expect(f.service.tryAcquireSessionRewriteBarrier(parentId)).toBeNull();
      finish.resolve();
      await running;
      const release = f.service.tryAcquireSessionRewriteBarrier(parentId);
      expect(release).toBeTypeOf('function');
      release?.();
    } finally {
      finish.resolve();
      await f.close();
    }
  });

  it('keeps the parent archive barrier while a failed child release still owns raw prompt work', async () => {
    const started = createDeferred();
    const finish = createDeferred();
    const nativeCompletion = createDeferred();
    const cleanup = createDeferred();
    const f = inboxExecutionFixture(async () => {
      started.resolve();
      await finish.promise;
      return { stopReason: 'end_turn' };
    });
    const parentId = 'parent' as SessionId;
    const originalMeta = f.doc.getMetaState.bind(f.doc);
    f.doc.getMetaState = async () =>
      ({ ...(await originalMeta()), parentSessionId: parentId }) as SessionMeta;
    Object.assign(f.client, { pendingPromptCompletion: nativeCompletion.promise });
    f.session.terminate = async () => {
      await cleanup.promise;
    };
    try {
      await f.accept();
      const running = f.service.continueSession(f.message);
      await started.promise;
      const execution = f.service as unknown as {
        turnRuntimeBySession: Map<SessionId, { releaseFailure?: unknown; turnId: string }>;
        freeTurnSlot(runtime: { releaseFailure?: unknown; turnId: string }): void;
      };
      const owner = execution.turnRuntimeBySession.get(f.message.sessionId);
      if (!owner) throw new Error('missing child execution');
      owner.releaseFailure = new Error('unconfirmed child release');
      execution.freeTurnSlot(owner);
      expect(f.service.tryAcquireSessionRewriteBarrier(parentId)).toBeNull();
      finish.resolve();
      await running;
      expect(f.service.tryAcquireSessionRewriteBarrier(parentId)).toBeNull();
      nativeCompletion.resolve();
      await nativeCompletion.promise;
      const release = f.service.tryAcquireSessionRewriteBarrier(parentId);
      expect(release).toBeTypeOf('function');
      release?.();
    } finally {
      finish.resolve();
      nativeCompletion.resolve();
      cleanup.resolve();
      await f.close();
    }
  });

  it('upgrades an existing capacity setting without changing its enabled state', () => {
    const ledger = new AutomationLedger({ kind: 'memory' }, 'workspace-1', 'machine-1');
    try {
      configureSessionPolicies(ledger, 'session-1', 'user-1', { recoverCapacity: true }, 1);
      const rule = ledger.rules()[0];
      if (!rule) throw new Error('missing recovery rule');
      const {
        revision,
        ownerUserId: _ownerUserId,
        ownerMachineId: _ownerMachineId,
        activationSequence: _activationSequence,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...draft
      } = rule;
      ledger.upsert(
        { ...draft, selector: { types: ['provider.quota.exhausted'] } },
        'user-1',
        2,
        revision
      );
      upgradeCapacityPolicies(ledger, 'user-1', 3);
      expect(ledger.rule(rule.id)).toMatchObject({
        enabled: true,
        selector: { types: ['provider.quota.exhausted', 'provider.model.overloaded'] },
      });
    } finally {
      ledger.close();
    }
  });

  it.each([
    { error: 'usageLimitExceeded', failure: 'quota_exhausted', event: 'provider.quota.exhausted' },
    {
      error: 'serverOverloaded',
      failure: 'provider_overloaded',
      event: 'provider.model.overloaded',
    },
  ])(
    'recovers a staged $failure result after its delivery acknowledgement is lost',
    async ({ error, failure, event }) => {
      const submitted: ContentBlock[][] = [];
      const f = inboxExecutionFixture(async (blocks) => {
        submitted.push(blocks);
        throw new RequestError(-32603, 'capacity unavailable', { codexErrorInfo: error });
      });
      const filename = path.join(path.dirname(f.storePath), 'automations.sqlite');
      let ledger = new AutomationLedger(
        { kind: 'disk', path: filename },
        'workspace-1',
        'machine-1'
      );
      configureSessionPolicies(ledger, f.message.sessionId, 'user-1', { recoverCapacity: true }, 0);
      const scope = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
      };
      let stagedBeforeRelease = false;
      try {
        f.service.setAutomationObservations({
          stage: (fact) => {
            ledger.stageTurn(fact);
            stagedBeforeRelease =
              f.store.inbox.executionRelease(scope, fact.assistantTurnId) === undefined;
          },
          turn: async () => {
            throw new Error('lost post-release delivery');
          },
          capacity: async () => {},
        });
        await f.accept();
        await f.service.continueSession(f.message);
        expect(stagedBeforeRelease).toBe(true);
        const staged = ledger.stagedTurns();
        expect(staged).toHaveLength(1);
        expect(staged[0]?.fact).toMatchObject({
          capacityFailure: failure,
          released: false,
          finalized: true,
          nativeSessionId: 'acp-inbox',
          outcome: 'failed',
        });
        ledger.close();
        ledger = new AutomationLedger({ kind: 'disk', path: filename }, 'workspace-1', 'machine-1');
        const failures: unknown[] = [];
        await reconcileSessionTurnsLegacy(
          ledger,
          f.deps.workspaceDocument,
          (fact) => f.store.inbox.executionRelease(scope, fact.assistantTurnId),
          (cause) => failures.push(cause)
        );
        expect(failures).toEqual([]);
        expect(ledger.stagedTurns()).toEqual([]);
        const workId = (await import('../src/automations/storage/ledger')).automationIdentity(
          f.message.sessionId,
          'human-input',
          'assistant:human-input',
          'pending-work'
        );
        expect(ledger.work(workId)).toMatchObject({
          state: 'blocked_on_capacity',
          release: 'released',
          nativeSessionId: 'acp-inbox',
          unresolvedEffects: false,
          inputRef: 'human-input',
        });
        const delivery = ledger.deliveries().find((item) => item.event.type === event);
        if (!delivery) throw new Error('missing recovery delivery');
        expect(internalPolicy(delivery)).toMatchObject([
          { action: { kind: 'agent.invoke', parameters: { input: { ref: workId } } } },
        ]);
        if (failure === 'provider_overloaded') {
          const fact = staged[0]?.fact;
          if (!fact) throw new Error('missing staged observation');
          let previousId = workId;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const turnId = `retry-${attempt}`;
            const invocationId = `invocation-${attempt}`;
            expect(ledger.claimWork(previousId, invocationId)).toBe(true);
            await f.deps.workspaceDocument.repo.upsertDocMeta('fixture', {
              latestUserMsgId: turnId,
            });
            await observeSessionTurnLegacy(ledger, f.deps.workspaceDocument, {
              ...fact,
              turnId,
              released: true,
              observedAt: fact.observedAt + attempt * 1000,
              inputConfig: {
                ...fact.inputConfig,
                _lodyAutomation: {
                  invocationId,
                  ruleId: 'rule',
                  ruleRevision: 1,
                  eventRef: 'event',
                  authorizationUserId: 'user-1',
                  workIntentId: previousId,
                },
              },
            });
            previousId = (await import('../src/automations/storage/ledger')).automationIdentity(
              f.message.sessionId,
              turnId,
              fact.assistantTurnId,
              'pending-work'
            );
            expect(ledger.work(previousId)).toMatchObject({
              attempts: attempt,
              state: attempt === 3 ? 'failed' : 'blocked_on_capacity',
              notBefore: fact.observedAt + attempt * 1000 + 5_000 * 2 ** Math.min(attempt, 2),
            });
          }
          expect(ledger.claimWork(previousId, 'extra')).toBe(false);
        }
        expect(submitted).toHaveLength(1);
        expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      } finally {
        f.service.setAutomationObservations(undefined);
        ledger.close();
        await f.close();
      }
    }
  );

  it('starts dispatch and executes ordinary human input when the Inbox database cannot open', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(blocks);
      return { stopReason: 'end_turn' };
    });
    let watching = false;
    const dispatchWatcher = {
      start: async () => {
        watching = true;
      },
    };
    const coordinator = new LodyOperationCoordinator({
      workspaceId: f.message.workspaceId,
      machineId: f.message.machineId as MachineId,
      userId: f.message.userId,
      workspaceDocument: f.deps.workspaceDocument,
      executionService: f.service,
      dispatchWatcher: dispatchWatcher as never,
      logger: createSilentLogger(),
      storeFactory: () => {
        throw new Error('SQLITE_FULL');
      },
      materializeTarget: async () => {
        throw new Error('must not materialize while degraded');
      },
    });
    try {
      await MessageHandler.prototype.startSessionDispatchWatcher.call({
        sessionDispatchWatcher: dispatchWatcher,
        operationCoordinator: coordinator,
      } as never);
      expect(watching).toBe(true);
      await f.accept();
      await f.service.continueSession(f.message);
      expect(
        received
          .flat()
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
      ).toEqual(['CURRENT_REQUEST']);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      const history = await (await createSessionBackend(f.doc)).readHistory();
      expect(history.find((turn) => turn.id === 'human-input')?.status).toBe('handled');
      expect(
        history.some((turn) => turn.role === 'assistant' && turn.userTurnId === 'human-input')
      ).toBe(true);
    } finally {
      await coordinator.stop();
      await f.close();
    }
  });

  it('preserves a live execution while a later input waits', async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(blocks);
      started.resolve();
      await finish.promise;
      return { stopReason: 'end_turn' };
    });
    let running: Promise<unknown> | undefined;
    try {
      await f.accept();
      running = f.service.continueSession(f.message);
      await started.promise;
      const before = f.store.inbox.activeExecution('workspace-1', f.message.sessionId);
      await f.service.continueSession({ ...f.message, userTurnId: 'waiting-input' });
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toEqual(before);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(true);
      const notices = (await (await createSessionBackend(f.doc)).readHistory())
        .flatMap((turn) => turn.items ?? [])
        .filter((item) => item.type === 'system_notice' && item.name === 'chat_failed');
      expect(notices).toEqual([]);
      expect(received).toEqual([[{ type: 'text', text: 'CURRENT_REQUEST' }]]);
    } finally {
      finish.resolve();
      await running;
      await f.close();
    }
  });

  it('does not retire a live Inbox execution when admission registers a replacement runtime', async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(structuredClone(blocks));
      if (received.length === 1) {
        started.resolve();
        await finish.promise;
      }
      return { stopReason: 'end_turn' };
    });
    let running: Promise<unknown> | undefined;
    try {
      await f.accept();
      running = f.service.continueSession(f.message);
      await started.promise;
      const prior = f.store.inbox.activeExecution('workspace-1', f.message.sessionId);
      expect(prior).toMatchObject({ executionId: 'assistant:human-input', inputId: 'human-input' });
      // Retire only the facade registration; transport and the SQLite owner remain live.
      const internals = f.service as unknown as {
        releaseTurnRuntime(sessionId: SessionId, turnId: string): void;
      };
      internals.releaseTurnRuntime(f.message.sessionId, 'assistant:human-input');
      const config = { ...f.message.acpSessionConfig, prompt: 'WAITING_REQUEST' };
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'waiting-input',
          role: 'user',
          userId: 'user-1',
          status: 'pending',
          inputConfig: config,
          timestamp: '2026-10-29T00:00:00Z',
          items: [{ type: 'text', text: config.prompt }],
          fileDiff: [],
          finished: true,
        },
      });
      await f.service.acceptInboxHumanInput({
        sessionId: f.message.sessionId,
        inputId: 'waiting-input',
        userId: 'user-1',
        config,
      });
      const attempt = await f.service
        .continueSession({ ...f.message, userTurnId: 'waiting-input', acpSessionConfig: config })
        .catch((cause: unknown) => cause);
      expect(f.store.inbox.activeExecution('workspace-1', f.message.sessionId)).toEqual(prior);
      expect(received).toEqual([[{ type: 'text', text: 'CURRENT_REQUEST' }]]);
      expect(attempt).toBeInstanceOf(InboxExecutionRejected);
      finish.resolve();
      await running;
      await f.service.continueSession({
        ...f.message,
        userTurnId: 'waiting-input',
        acpSessionConfig: config,
      });
      expect(received).toEqual([
        [{ type: 'text', text: 'CURRENT_REQUEST' }],
        [{ type: 'text', text: 'WAITING_REQUEST' }],
      ]);
    } finally {
      finish.resolve();
      await running;
      await f.close();
    }
  });

  it('retires a crashed input without replay and closes its leftover assistant entry', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(blocks);
      return { stopReason: 'end_turn' };
    });
    try {
      const old = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
        inputId: f.message.userTurnId,
        kind: 'task' as const,
        config: f.message.acpSessionConfig,
      };
      expect(f.store.inbox.accept(old)).toBe(true);
      expect(f.store.inbox.begin(old, 'assistant:human-input')).toBe(true);
      // The crashed run left its assistant entry open.
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'assistant:human-input',
          role: 'assistant',
          userTurnId: 'human-input',
          timestamp: '2026-10-12T00:00:01Z',
          items: [{ type: 'text', text: 'partial answer' }],
          fileDiff: [],
        },
      });
      // Restart retires the interrupted input and records its unknown outcome.
      f.store.inbox.activate('workspace-1', 'owner');
      await f.service.continueSession(f.message);
      // The rejected run settles its input, so nothing owns the leftover entry any more.
      const backend = await createSessionBackend(f.doc);
      expect((await backend.readTurn('human-input')).turn).toMatchObject({ status: 'failed' });
      expect((await backend.readTurn('assistant:human-input')).turn).toMatchObject({
        finished: true,
        endedAt: expect.any(Number),
      });
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, old.inputId)).toBe(true);
      const db = new Database(f.storePath);
      try {
        expect(
          db
            .prepare(
              'SELECT active_execution,active_input,blocked FROM inbox_sessions WHERE session_id=?'
            )
            .get(f.message.sessionId)
        ).toEqual({
          active_execution: null,
          active_input: null,
          blocked: 0,
        });
        expect(
          db
            .prepare('SELECT outcome FROM inbox_releases WHERE session_id=?')
            .all(f.message.sessionId)
        ).toEqual([{ outcome: 'failed' }]);
      } finally {
        db.close();
      }
      expect(received).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('continues a Turn a process end interrupted on this Machine once with `continue`, never replaying it', async () => {
    const received: ContentBlock[][] = [];
    const f = inboxExecutionFixture(async (blocks) => {
      received.push(blocks);
      return { stopReason: 'end_turn' };
    });
    const repo = f.deps.workspaceDocument.repo as unknown as {
      upsertDocMeta: (id: string, patch: Partial<SessionMeta>) => Promise<void>;
    };
    try {
      const old = {
        workspaceId: 'workspace-1',
        sessionId: f.message.sessionId,
        userId: 'user-1',
        inputId: f.message.userTurnId,
        kind: 'task' as const,
        config: f.message.acpSessionConfig,
      };
      expect(f.store.inbox.accept(old)).toBe(true);
      expect(f.store.inbox.begin(old, 'assistant:human-input')).toBe(true);
      // The interrupted run left its dispatch claim in metadata and its entry open.
      await repo.upsertDocMeta('', {
        latestUserMsgId: 'human-input',
        processingUserMsgId: 'human-input',
      });
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: {
          id: 'assistant:human-input',
          role: 'assistant',
          userTurnId: 'human-input',
          timestamp: '2026-10-12T00:00:01Z',
          items: [{ type: 'text', text: 'partial answer' }],
          fileDiff: [],
        },
      });
      f.store.inbox.activate('workspace-1', 'owner');
      await f.service.continueSession(f.message);
      const backend = await createSessionBackend(f.doc);
      // Settled like Stop, not as a send-again failure.
      expect((await backend.readTurn('human-input')).turn).toMatchObject({ status: 'canceled' });
      expect((await backend.readTurn('assistant:human-input')).turn).toMatchObject({
        finished: true,
      });
      expect((await backend.readTurn('lody-continue-human-input')).turn).toMatchObject({
        role: 'user',
        author: { v: 1, kind: 'system' },
        items: [{ type: 'text', text: 'continue' }],
      });
      // A second dispatch of the stale input adds no further continuation.
      await repo.upsertDocMeta('', { processingUserMsgId: 'human-input' });
      await f.service.continueSession(f.message);
      const history = await backend.readHistory();
      expect(history.filter((turn) => turn.id.startsWith('lody-continue-'))).toHaveLength(1);
      expect(received).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('notifies once after five children, partial summaries and a follow-up delegation finish', async () => {
    const summaries = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
    let summaryCount = 0;
    let promptCount = 0;
    const facts: TurnOutcomeFact[] = [];
    const f = inboxExecutionFixture(
      async () => {
        promptCount++;
        const invocation = f.service.getActiveInvocationContext(f.message.sessionId)!;
        expect(invocation.notificationOriginTurnIds).toEqual(['human-input']);
        if (promptCount === 1) {
          for (let i = 0; i < 5; i++)
            f.add(`child-${i}`, 0, invocation.notificationOriginTurnIds, false);
        } else if (promptCount === 3) {
          f.add('follow-up', 1, invocation.notificationOriginTurnIds, false);
        }
        return { stopReason: 'end_turn' };
      },
      undefined,
      () => summaries[summaryCount++]!.resolve()
    );
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      // Success is published only after the consumed batch is durably settled.
      expect(f.store.inbox.historyReceipts('workspace-1').every((b) => b.state === 'settled')).toBe(
        true
      );
      facts.push(fact);
    };
    const finish = (id: string) =>
      f.store.finish(f.message.sessionId, id, { type: 'result', value: { items: [] } });
    try {
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: { kind: 'user' } });
      expect(facts).toEqual([]);
      finish('child-0');
      await f.wake();
      await summaries[0]!.promise;
      expect(facts).toEqual([]);
      for (let i = 1; i < 5; i++) finish(`child-${i}`);
      await f.wake();
      await summaries[1]!.promise;
      expect(facts).toEqual([]);
      finish('follow-up');
      await f.wake();
      await summaries[2]!.promise;
      expect(promptCount).toBe(4);
      await f.service.drainInboxExecutions();
      expect(facts).toEqual([
        expect.objectContaining({ audience: { kind: 'user' }, outcome: { kind: 'succeeded' } }),
      ]);
      expect(facts[0]!.turnId).not.toBe('human-input');
      expect(facts[0]!.originTurnIds).toEqual(['human-input']);
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'keeps delegated summaries silent and surfaces user summary errors (user=%s)',
    async (human) => {
      const complete = createDeferred<void>();
      let prompts = 0;
      const facts: TurnOutcomeFact[] = [];
      const f = inboxExecutionFixture(
        async () => {
          if (++prompts === 1) {
            const origins = f.service.getActiveInvocationContext(
              f.message.sessionId
            )!.notificationOriginTurnIds;
            f.add('child', 0, origins, false);
            f.add('still-pending', 0, origins, false);
          } else throw new Error('summary failed');
          return { stopReason: 'end_turn' };
        },
        undefined,
        () => complete.resolve()
      );
      f.deps.turnFinalization.onTurnOutcome = async (fact) => {
        facts.push(fact);
      };
      try {
        await f.accept();
        await f.service.continueSession(f.message, {
          notificationAudience: human
            ? { kind: 'user' }
            : { kind: 'agent', sessionId: 'caller' as SessionId, turnId: 'caller-turn' },
        });
        expect(facts.flatMap((fact) => projectTurnAttention(fact) ?? [])).toEqual([]);
        f.store.finish(f.message.sessionId, 'child', { type: 'result', value: { items: [] } });
        await f.wake();
        await complete.promise;
        const attention = facts.flatMap((fact) => projectTurnAttention(fact) ?? []);
        expect(attention).toEqual(human ? [expect.objectContaining({ outcome: 'failed' })] : []);
      } finally {
        await f.close();
      }
    }
  );

  it('binds inherited origins to their recipient and checks the new requester after steer', async () => {
    const started = createDeferred<void>();
    const originalDone = createDeferred<unknown>();
    const steerDone = createDeferred<unknown>();
    const f = inboxExecutionFixture(async () => {
      started.resolve();
      return await originalDone.promise;
    });
    Object.assign(f.client, {
      getAcknowledgedSteerCapability: () => ({
        provider: 'claudeCode',
        appliedNotificationMethod: 'claude/steerApplied',
        upstreamTurn: 'handoff',
        configPolicy: 'apply',
      }),
      steerPrompt: () => ({
        completion: steerDone.promise,
        outcome: Promise.resolve({
          outcome: 'applied',
          application: { steerId: 'steer', release: () => {} },
        }),
      }),
    });
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      f.add('old-user-result', 0, ['old-user-request']);
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await started.promise;
      const source = (await (await createSessionBackend(f.doc)).readHistory())[0]!;
      await f.doc.sessionData.commands.applyHistoryAction({
        kind: 'upsert-turn',
        turn: { ...source, id: 'steer-input', userId: 'user-2', status: 'pending' },
      });
      expect(
        await f.service.steerSession({
          sessionId: f.message.sessionId,
          expectedTurnId: 'assistant:human-input',
          userTurnId: 'steer-input',
          userId: 'user-2',
          timestamp: '2026-10-12T00:00:00Z',
          inputConfig: f.message.acpSessionConfig,
        })
      ).toMatchObject({ applied: true });
      f.service.setTurnNotificationAudience(f.message.sessionId, 'steer-input', { kind: 'user' });
      expect(f.service.getActiveInvocationContext(f.message.sessionId)).toMatchObject({
        requesterUserId: 'user-2',
        notificationOriginTurnIds: ['steer-input'],
      });
      f.add('new-user-child', 0, ['steer-input'], false, 'user-2');
      originalDone.resolve({ stopReason: 'end_turn' });
      steerDone.resolve({ stopReason: 'end_turn' });
      await running;
      expect(facts).toEqual([]);
    } finally {
      originalDone.resolve({});
      steerDone.resolve({});
      await f.close();
    }
  });

  it('releases before a stalled batch history projection and keeps the committed outcome', async () => {
    const settling = createDeferred<void>();
    const settle = createDeferred<void>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const apply = f.doc.sessionData.commands.applyHistoryAction.bind(f.doc.sessionData.commands);
    vi.spyOn(f.doc.sessionData.commands, 'applyHistoryAction').mockImplementation(
      async (action) => {
        if (action.kind === 'operation-batch-status' && action.status === 'settled') {
          settling.resolve();
          await settle.promise;
        }
        return await apply(action);
      }
    );
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      f.add('result', 0, ['human-input']);
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await settling.promise;
      expect(f.store.inbox.inputEnded('workspace-1', f.message.sessionId, 'human-input')).toBe(
        true
      );
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      await f.service.cancelSession({
        sessionId: f.message.sessionId,
        turnId: 'assistant:human-input',
        machineId: 'machine-1',
        workspaceId: 'workspace-1' as WorkspaceId,
      });
      settle.resolve();
      await running;
      expect(facts.map((fact) => fact.outcome)).toEqual([{ kind: 'succeeded' }]);
      expect(facts.flatMap((fact) => projectTurnAttention(fact) ?? [])).toHaveLength(1);
    } finally {
      settle.resolve();
      await f.close();
    }
  });

  it('publishes unread and success only after finalization, release and history sync', async () => {
    const finalizing = createDeferred<void>();
    const finalized = createDeferred<void>();
    const confirming = createDeferred<void>();
    const synced = createDeferred<boolean>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    let presence = false;
    const facts: TurnOutcomeFact[] = [];
    f.deps.startSessionActivePresence = () => {
      presence = true;
    };
    f.deps.clearSessionActivePresence = () => {
      presence = false;
    };
    f.deps.workspaceDocument.getRemoteStreamsGeneration = () => 1;
    f.doc.waitUntilSynced = async () => {
      confirming.resolve();
      return synced.promise;
    };
    f.deps.turnFinalization.finalizeACPState = async (_id, turnId) => {
      finalizing.resolve();
      await finalized.promise;
      await (
        await createSessionBackend(f.doc)
      ).applyHistoryAction({ kind: 'finish-assistant', turnId, endedAt: 100 });
    };
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      expect(presence).toBe(false);
      facts.push(fact);
    };
    try {
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await finalizing.promise;
      expect(presence).toBe(true);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
      finalized.resolve();
      await confirming.promise;
      await running;
      expect(presence).toBe(false);
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
      expect(facts).toEqual([]);
      synced.resolve(true);
      await f.service.drainInboxExecutions();
      expect((await f.doc.getMetaState())?.lastMessageAt).toEqual(expect.any(Number));
      expect(facts.map((fact) => fact.outcome)).toEqual([{ kind: 'succeeded' }]);
    } finally {
      finalized.resolve();
      synced.resolve(true);
      await f.close();
    }
  });

  it('history finalization failure releases the slot and emits failure attention without unread success', async () => {
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const facts: TurnOutcomeFact[] = [];
    f.deps.turnFinalization.finalizeACPState = async () => {
      throw new Error('history storage unavailable');
    };
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: { kind: 'user' } });
      await f.service.drainInboxExecutions();
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(facts.map((fact) => fact.outcome.kind)).toEqual(['failed']);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('shutdown ends a pending sync waiter and late sync cannot publish completion', async () => {
    const confirming = createDeferred<void>();
    const synced = createDeferred<boolean>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    const facts: TurnOutcomeFact[] = [];
    f.deps.workspaceDocument.getRemoteStreamsGeneration = () => 1;
    f.doc.waitUntilSynced = async () => {
      confirming.resolve();
      return synced.promise;
    };
    f.deps.turnFinalization.onTurnOutcome = async (fact) => {
      facts.push(fact);
    };
    try {
      await f.accept();
      await f.service.continueSession(f.message, { notificationAudience: { kind: 'user' } });
      await confirming.promise;
      f.service.stopCompletionPublication();
      await f.service.drainInboxExecutions();
      synced.resolve(true);
      expect(facts).toEqual([]);
      expect((await f.doc.getMetaState())?.lastMessageAt).toBeUndefined();
    } finally {
      synced.resolve(true);
      await f.close();
    }
  });

  it('releases the execution slot while a notification transport is still pending', async () => {
    const sending = createDeferred<void>();
    const delivered = createDeferred<void>();
    const f = inboxExecutionFixture(async () => ({ stopReason: 'end_turn' }));
    f.deps.turnFinalization.onTurnOutcome = async () => {
      sending.resolve();
      await delivered.promise;
    };
    try {
      await f.accept();
      const running = f.service.continueSession(f.message, {
        notificationAudience: { kind: 'user' },
      });
      await sending.promise;
      expect(f.service.getExecutionSnapshot(f.message.sessionId).hasActiveTurn).toBe(false);
      expect(f.store.hasPendingWorkForRequester(f.message.workspaceId, f.message.sessionId)).toBe(
        false
      );
      await running;
      delivered.resolve();
    } finally {
      delivered.resolve();
      await f.close();
    }
  });

  it('runs the next automatic batch while the previous batch notification is still sending', async () => {
    const sending = createDeferred<void>();
    const delivered = createDeferred<void>();
    const secondSent = createDeferred<void>();
    const secondPrompt = createDeferred<void>();
    const secondBatchDone = createDeferred<void>();
    let prompts = 0;
    let batches = 0;
    const f = inboxExecutionFixture(
      async () => {
        if (++prompts === 2) secondPrompt.resolve();
        return { stopReason: 'end_turn' };
      },
      undefined,
      () => {
        if (++batches === 2) secondBatchDone.resolve();
      }
    );
    let sends = 0;
    f.deps.turnFinalization.onTurnOutcome = async () => {
      if (++sends === 1) {
        sending.resolve();
        await delivered.promise;
      } else {
        secondSent.resolve();
      }
    };
    try {
      f.add('first', 0, ['request-a']);
      await f.wake();
      await sending.promise;
      f.add('second', 0, ['request-b']);
      await f.wake();
      await secondPrompt.promise;
      await secondBatchDone.promise;
      await secondSent.promise;
      expect(sends).toBe(2);
      delivered.resolve();
      await f.service.drainInboxExecutions();
    } finally {
      delivered.resolve();
      await f.close();
    }
  });
});
