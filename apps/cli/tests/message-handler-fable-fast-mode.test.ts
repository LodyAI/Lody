import { describe, expect, it, vi } from 'vitest';

import type { ACPSessionId, AcpConfigOptionValue, SessionId, WorkspaceId } from '@lody/shared';
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

type ApplyAcpModeAndModel = (
  session: {
    sessionId: SessionId;
    acpSessionId: ACPSessionId;
    agentClient: {
      isCreated: () => boolean;
      getConfigOptions: () => Array<{ id: string; category?: string }>;
      setSessionMode: (sessionId: ACPSessionId, modeId: string) => Promise<void>;
      unstable_setSessionModel: (sessionId: ACPSessionId, modelId: string) => Promise<void>;
      setSessionConfigOption: (
        sessionId: ACPSessionId,
        configId: string,
        value: AcpConfigOptionValue
      ) => Promise<void>;
    };
  },
  config: {
    agentType?: string;
    modelId?: string;
    configOptionValues?: Record<string, AcpConfigOptionValue>;
  },
  context: { sessionDoc: unknown }
) => Promise<void>;

function createHarness() {
  const workspaceDocument = {
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
    },
    getOrCreateSessionDoc: vi.fn(),
    isTransportConnected: vi.fn(() => true),
  };
  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(),
  };
  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    createSilentLogger(),
    {
      token: 'token',
      workspaceId: 'workspace-1' as WorkspaceId,
      userId: 'user-1',
      machineId: 'machine-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    }
  );
  const setSessionConfigOption = vi.fn(async () => {});
  const unstableSetSessionModel = vi.fn(async () => {});
  const session = {
    sessionId: 'session-1' as SessionId,
    acpSessionId: 'acp-session-1' as ACPSessionId,
    agentClient: {
      isCreated: () => true,
      getConfigOptions: () => [
        { id: 'model', category: 'model' },
        { id: 'fast', category: 'model_config' },
      ],
      setSessionMode: vi.fn(async () => {}),
      unstable_setSessionModel: unstableSetSessionModel,
      setSessionConfigOption,
    },
  };

  const applyAcpModeAndModel = (
    handler as unknown as {
      applyAcpModeAndModel: ApplyAcpModeAndModel;
    }
  ).applyAcpModeAndModel.bind(handler);

  return {
    apply: (
      targetSession: Parameters<ApplyAcpModeAndModel>[0],
      config: Parameters<ApplyAcpModeAndModel>[1]
    ) => applyAcpModeAndModel(targetSession, config, { sessionDoc: {} }),
    session,
    setSessionConfigOption,
    unstableSetSessionModel,
  };
}

describe('MessageHandler Claude Fable Fast mode compatibility', () => {
  it.each(['fast', 'fast-mode'])('does not send %s=false to a Fable model', async (configId) => {
    const { apply, session, setSessionConfigOption } = createHarness();

    await apply(session, {
      agentType: 'claude',
      modelId: 'claude-fable-5[1m]',
      configOptionValues: { [configId]: false },
    });

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('recognizes Fable when the target model is carried as a config option', async () => {
    const { apply, session, setSessionConfigOption, unstableSetSessionModel } = createHarness();

    await apply(session, {
      agentType: 'claude',
      configOptionValues: {
        model: 'claude-fable-5',
        fast: false,
      },
    });

    expect(unstableSetSessionModel).toHaveBeenCalledWith('acp-session-1', 'claude-fable-5');
    expect(setSessionConfigOption).not.toHaveBeenCalledWith('acp-session-1', 'fast', false);
  });

  it.each([
    {
      name: 'enabled Fast mode on Fable',
      agentType: 'claude',
      modelId: 'claude-fable-5',
      value: true,
    },
    {
      name: 'disabled Fast mode on another Claude model',
      agentType: 'claude',
      modelId: 'opus[1m]',
      value: false,
    },
  ])('still sends $name', async ({ agentType, modelId, value }) => {
    const { apply, session, setSessionConfigOption } = createHarness();

    await apply(session, {
      agentType,
      modelId,
      configOptionValues: { fast: value },
    });

    expect(setSessionConfigOption).toHaveBeenCalledWith('acp-session-1', 'fast', value);
  });
});
