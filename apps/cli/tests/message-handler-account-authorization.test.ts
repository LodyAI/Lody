import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MachineAccountProfilesRequest,
  MachineAccountProfilesResponse,
  MachineAcpAuthenticateRequest,
  MachineAcpAuthenticateResponse,
  SessionAccountSwitchRequest,
  SessionAccountSwitchResponse,
} from '@lody/shared';
import { MessageHandler, type MessageDispatchContext } from '../src/lib/message-handler';
import type { SessionExecutionService } from '../src/session/session-execution-service';

const profiles = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock('../src/agent/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/account-profiles')>()),
  listAccountProfiles: profiles.list,
  createAccountProfile: profiles.create,
}));

type HandlerHost = {
  handleMessage: MessageHandler['handleMessage'];
  handleAccountProfiles(
    message: MachineAccountProfilesRequest,
    context?: MessageDispatchContext
  ): Promise<MachineAccountProfilesResponse>;
  handleAccountSwitch(
    message: SessionAccountSwitchRequest,
    context?: MessageDispatchContext
  ): Promise<SessionAccountSwitchResponse>;
  authenticateMachineAcpAndResumeSetup(
    message: MachineAcpAuthenticateRequest,
    options?: Parameters<SessionExecutionService['authenticateMachineAcp']>[1],
    context?: MessageDispatchContext
  ): Promise<MachineAcpAuthenticateResponse>;
};

const local: MessageDispatchContext = { source: 'local', send: () => {} };
const remote: MessageDispatchContext = { source: 'runtime', send: () => {} };
const profileRequest: MachineAccountProfilesRequest = {
  type: 'machine/account-profiles',
  machineId: 'machine',
  workspaceId: 'workspace',
  requestId: 'profiles',
  configId: 'config',
  cliType: 'builtin',
  agentType: 'codex',
  action: 'list',
};
const switchRequest: SessionAccountSwitchRequest = {
  type: 'session/account-switch',
  machineId: 'machine',
  workspaceId: 'workspace',
  requestId: 'switch',
  sessionId: 'session',
  accountProfileId: 'profile',
};
const start: MachineAcpAuthenticateRequest = {
  type: 'machine/acp-authenticate',
  machineId: 'machine',
  workspaceId: 'workspace',
  requestId: 'login',
  configId: 'config',
  action: 'start',
  accountProfileId: 'profile',
};
const success: MachineAcpAuthenticateResponse = {
  type: 'machine/acp-authenticate_response',
  machineId: 'machine',
  requestId: 'login',
  agentType: 'codex',
  success: true,
  disposition: 'authenticated',
};

function harness() {
  const getAgentConfigById = vi.fn(async () => ({
    agentType: 'codex',
    cliType: 'builtin',
    machineId: 'machine',
  }));
  const authenticate = vi.fn<SessionExecutionService['authenticateMachineAcp']>(
    async () => success
  );
  const switchAccount = vi.fn<SessionExecutionService['switchAccount']>(async () => ({
    sessionId: 'session',
    acpSessionId: 'native-session',
    accountProfileId: 'profile',
    continuation: false,
  }));
  const verifyMachineAccess = vi.fn(async () => ({ outcome: 'allowed' as const }));
  const resumeAfterAuthentication = vi.fn(async () => {});
  const handler = Object.assign(Object.create(MessageHandler.prototype), {
    machineId: 'machine',
    workspaceId: 'workspace',
    userId: 'owner',
    localAccountAuthenticationRequests: new Set<string>(),
    workspaceDocument: { getAgentConfigById },
    executionService: { authenticateMachineAcp: authenticate, switchAccount },
    providerSetupManager: { resumeAfterAuthentication },
    verifyMachineAccess,
    logger: { debug: () => {} },
  }) as HandlerHost;
  return {
    handler,
    getAgentConfigById,
    authenticate,
    switchAccount,
    verifyMachineAccess,
    resumeAfterAuthentication,
  };
}

describe('account operation source authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries trusted local context through the public message dispatcher', async () => {
    const h = harness();
    const replies: unknown[] = [];
    const context: MessageDispatchContext = {
      source: 'local',
      send: (reply) => replies.push(reply),
    };
    profiles.list.mockResolvedValue([]);
    await h.handler.handleMessage(profileRequest, context);
    await h.handler.handleMessage(switchRequest, context);
    await h.handler.handleMessage(start, context);
    expect(replies).toEqual([
      expect.objectContaining({ type: 'machine/account-profiles_response', success: true }),
      expect.objectContaining({ type: 'session/account-switch_response', success: true }),
      success,
    ]);
  });

  it.each(['list', 'create'] as const)(
    'rejects remote profile %s before reading configuration or accounts',
    async (action) => {
      const h = harness();
      const spoofed = {
        ...profileRequest,
        action,
        label: 'Work',
        source: 'local',
        requestedByUserId: 'owner',
      };
      for (const context of [undefined, remote]) {
        expect(await h.handler.handleAccountProfiles(spoofed, context)).toMatchObject({
          success: false,
          error: 'Account profiles require a local connection to this machine.',
        });
      }
      expect(h.getAgentConfigById).not.toHaveBeenCalled();
      expect(profiles.list).not.toHaveBeenCalled();
      expect(profiles.create).not.toHaveBeenCalled();
    }
  );

  it('returns profiles and creates an account through local dispatch', async () => {
    const h = harness();
    const profile = { id: 'profile', label: 'Work' };
    profiles.list.mockResolvedValue([profile]);
    profiles.create.mockResolvedValue(profile);
    expect(await h.handler.handleAccountProfiles(profileRequest, local)).toMatchObject({
      success: true,
      profiles: [profile],
    });
    expect(
      await h.handler.handleAccountProfiles(
        { ...profileRequest, action: 'create', label: 'Work' },
        local
      )
    ).toMatchObject({ success: true, profiles: [profile] });
  });

  it('rejects remote account switching even with spoofed owner and source fields', async () => {
    const h = harness();
    const spoofed = { ...switchRequest, source: 'local', requestedByUserId: 'owner' };
    for (const context of [undefined, remote]) {
      expect(await h.handler.handleAccountSwitch(spoofed, context)).toMatchObject({
        success: false,
        error: 'Account switching requires a local connection to this machine.',
      });
    }
    expect(h.switchAccount).not.toHaveBeenCalled();
    expect(h.verifyMachineAccess).not.toHaveBeenCalled();
  });

  it('binds local switch verification to the daemon user and checks target IDs', async () => {
    const h = harness();
    h.switchAccount.mockImplementation(async (_message, options) => {
      if (!options) throw new Error('Missing trusted switch authorization');
      const access = await options.verifyAccess({
        ...switchRequest,
        localProjectId: 'project',
      });
      expect(access).toEqual({ outcome: 'allowed' });
      return {
        sessionId: 'session',
        acpSessionId: 'native-session',
        accountProfileId: 'profile',
        continuation: false,
      };
    });
    expect(await h.handler.handleAccountSwitch(switchRequest, local)).toMatchObject({
      success: true,
      accountProfileId: 'profile',
    });
    expect(h.verifyMachineAccess).toHaveBeenCalledWith({
      sessionId: 'session',
      localProjectId: 'project',
      requesterUserId: 'owner',
    });
    h.switchAccount.mockClear();
    for (const override of [{ machineId: 'other' }, { workspaceId: 'other' }]) {
      expect(
        await h.handler.handleAccountSwitch({ ...switchRequest, ...override }, local)
      ).toMatchObject({ success: false });
    }
    expect(h.switchAccount).not.toHaveBeenCalled();
  });

  it.each(['profile', 'system-default'])(
    'rejects remote explicit account authentication for %s',
    async (accountProfileId) => {
      const h = harness();
      const spoofed = { ...start, accountProfileId, source: 'local', requestedByUserId: 'owner' };
      for (const context of [undefined, remote]) {
        expect(
          await h.handler.authenticateMachineAcpAndResumeSetup(spoofed, {}, context)
        ).toMatchObject({
          success: false,
          disposition: 'error',
          error: 'Account authentication requires a local connection to this machine.',
        });
      }
      expect(h.authenticate).not.toHaveBeenCalled();
    }
  );

  it('protects a pending local account login from remote cancellation and input', async () => {
    const h = harness();
    let complete = (_response: MachineAcpAuthenticateResponse) => {};
    h.authenticate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = h.handler.authenticateMachineAcpAndResumeSetup(start, {}, local);
    const controls: MachineAcpAuthenticateRequest[] = [
      { ...start, action: 'cancel', authenticationRequestId: 'login' },
      {
        ...start,
        action: 'submit-code',
        authenticationRequestId: 'login',
        authorizationCode: 'synthetic-code',
      },
      {
        ...start,
        action: 'submit-input',
        authenticationRequestId: 'login',
        interactionId: 'form',
        authenticationInput: 'synthetic-input',
      },
    ];
    h.authenticate.mockClear();
    for (const control of controls) {
      expect(
        await h.handler.authenticateMachineAcpAndResumeSetup(control, {}, remote)
      ).toMatchObject({ success: false, disposition: 'error' });
    }
    expect(h.authenticate).not.toHaveBeenCalled();
    for (const control of controls) {
      expect(await h.handler.authenticateMachineAcpAndResumeSetup(control, {}, local)).toEqual(
        success
      );
    }
    complete(success);
    expect(await pending).toEqual(success);
    expect(h.resumeAfterAuthentication).not.toHaveBeenCalled();
  });

  it('preserves legacy default provider authentication and setup resumption', async () => {
    const h = harness();
    const legacy: MachineAcpAuthenticateRequest = { ...start, accountProfileId: undefined };
    expect(await h.handler.authenticateMachineAcpAndResumeSetup(legacy)).toEqual(success);
    expect(h.resumeAfterAuthentication).toHaveBeenCalledWith('config');
    expect(
      await h.handler.authenticateMachineAcpAndResumeSetup({
        ...legacy,
        action: 'cancel',
        authenticationRequestId: 'legacy-login',
      })
    ).toEqual(success);
  });

  it('retains local login ownership across duplicate starts and releases it after completion', async () => {
    const h = harness();
    let complete = (_response: MachineAcpAuthenticateResponse) => {};
    h.authenticate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = h.handler.authenticateMachineAcpAndResumeSetup(start, {}, local);
    h.authenticate.mockResolvedValueOnce({ ...success, success: false, disposition: 'error' });
    await h.handler.authenticateMachineAcpAndResumeSetup(start, {}, local);
    h.authenticate.mockResolvedValueOnce({ ...success, success: false, disposition: 'error' });
    await h.handler.authenticateMachineAcpAndResumeSetup(
      { ...start, accountProfileId: undefined },
      {},
      local
    );
    const cancel: MachineAcpAuthenticateRequest = {
      ...start,
      action: 'cancel',
      authenticationRequestId: 'login',
    };
    h.authenticate.mockClear();
    expect(await h.handler.authenticateMachineAcpAndResumeSetup(cancel, {}, remote)).toMatchObject({
      success: false,
      disposition: 'error',
    });
    expect(h.authenticate).not.toHaveBeenCalled();
    complete(success);
    await pending;
    h.authenticate.mockResolvedValueOnce({
      ...success,
      success: false,
      disposition: 'not-running',
    });
    expect(await h.handler.authenticateMachineAcpAndResumeSetup(cancel, {}, remote)).toMatchObject({
      disposition: 'not-running',
    });
  });
});
