import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import type { Logger } from '@/utils/logger';

const connectionMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
  unstable_forkSession: vi.fn(),
  closeSession: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: 1,
  ClientSideConnection: class {
    readonly initialize = connectionMocks.initialize;
    readonly newSession = connectionMocks.newSession;
    readonly loadSession = connectionMocks.loadSession;
    readonly resumeSession = connectionMocks.resumeSession;
    readonly setSessionConfigOption = connectionMocks.setSessionConfigOption;
    readonly unstable_forkSession = connectionMocks.unstable_forkSession;
    readonly closeSession = connectionMocks.closeSession;
    readonly cancel = connectionMocks.cancel;
  },
}));

import { AgentClient } from './agent-client';

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => undefined),
  };
  return logger;
}

function readInitializeClientCapabilitiesMeta(): unknown {
  const request = connectionMocks.initialize.mock.calls[0]?.[0] as
    | { clientCapabilities?: { _meta?: unknown } }
    | undefined;
  return request?.clientCapabilities?._meta;
}

async function startWithIdentity(identity: {
  cliType: 'builtin' | 'registry' | 'custom';
  agentType: string;
}): Promise<void> {
  const client = new AgentClient({
    logger: createLogger(),
    sessionId: `session-${identity.cliType}-${identity.agentType}` as SessionId,
    terminalManager: {} as never,
    agentConfig: identity,
    onUpdateMessage: vi.fn(),
    onRequestPermission: vi.fn(),
  });
  await client.startSession({} as never, '/workdir');
}

describe('AgentClient initialize clientCapabilities._meta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionMocks.initialize.mockResolvedValue({ agentCapabilities: {} });
    connectionMocks.newSession.mockResolvedValue({ sessionId: 'acp-session-1' });
  });

  it('advertises parameterizedModelPicker for registry Cursor', async () => {
    await startWithIdentity({ cliType: 'registry', agentType: 'cursor' });

    expect(readInitializeClientCapabilitiesMeta()).toEqual({
      parameterizedModelPicker: true,
    });
  });

  it('omits parameterizedModelPicker for custom Cursor', async () => {
    await startWithIdentity({ cliType: 'custom', agentType: 'cursor' });

    expect(readInitializeClientCapabilitiesMeta()).toBeUndefined();
  });

  it('omits parameterizedModelPicker for a builtin agent', async () => {
    await startWithIdentity({ cliType: 'builtin', agentType: 'claude' });

    expect(readInitializeClientCapabilitiesMeta()).toBeUndefined();
  });
});
