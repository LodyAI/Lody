import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { resolveAccountProfileId } from '../src/account-profiles';
import { machineSupportsAccountProfilesProtocol } from '../src/machine-protocol-capabilities';
import {
  MachineAcpAuthenticateRequestSchema,
  SessionAccountSwitchRequestSchema,
} from '../src/message-schemas';
import {
  isLocalSessionControlRequest,
  isLocalSessionControlResponse,
} from '../src/node/local-session-control';

const require = createRequire(import.meta.url);
const cjs = require('../src/node/local-session-control.cjs');
const accountProfileId = '6b130632-7cce-4db8-97e9-53514b5f241f';
const envelope = { machineId: 'machine', workspaceId: 'workspace', requestId: 'request' };

describe('account protocol compatibility', () => {
  it.each([
    'system-default',
    accountProfileId,
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('accepts the same profile IDs on both transports: %s', (id) => {
    const request = {
      ...envelope,
      type: 'session/account-switch',
      sessionId: 'session',
      accountProfileId: id,
    };
    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(cjs.isLocalSessionControlRequest(request)).toBe(true);
  });

  it('keeps legacy sessions on System Default and legacy daemons unsupported', () => {
    expect(resolveAccountProfileId()).toBe('system-default');
    expect(machineSupportsAccountProfilesProtocol({})).toBe(false);
    expect(
      machineSupportsAccountProfilesProtocol({ protocolCapabilities: { accountProfiles: 1 } })
    ).toBe(true);
  });

  it('carries isolated login and handoff through both local transports', () => {
    const requests = [
      {
        ...envelope,
        type: 'machine/account-profiles',
        configId: 'config-1',
        cliType: 'builtin',
        agentType: 'codex',
        action: 'create',
        label: 'Personal',
      },
      {
        ...envelope,
        type: 'machine/acp-authenticate',
        configId: 'config-1',
        action: 'start',
        accountProfileId,
      },
      { ...envelope, type: 'session/account-switch', sessionId: 'session', accountProfileId },
    ];
    for (const request of requests) {
      expect(isLocalSessionControlRequest(request)).toBe(true);
      expect(cjs.isLocalSessionControlRequest(request)).toBe(true);
    }
    const responses = [
      {
        type: 'machine/account-profiles_response',
        machineId: 'machine',
        requestId: 'request',
        success: true,
        profiles: [{ accountProfileId, label: 'Personal', status: 'unknown' }],
      },
      {
        type: 'session/account-switch_response',
        machineId: 'machine',
        requestId: 'request',
        sessionId: 'session',
        success: true,
        accountProfileId,
        continuation: true,
      },
    ];
    for (const response of responses) {
      expect(isLocalSessionControlResponse(response)).toBe(true);
      expect(cjs.isLocalSessionControlResponse(response)).toBe(true);
    }
  });

  it.each(['../native', 'C:\\Users\\native', '', 'system-default/other'])(
    'rejects a path as an account ID: %s',
    (id) => {
      const request = {
        ...envelope,
        type: 'session/account-switch',
        sessionId: 'session',
        accountProfileId: id,
      };
      expect(SessionAccountSwitchRequestSchema.safeParse(request).success).toBe(false);
      expect(isLocalSessionControlRequest(request)).toBe(false);
      expect(cjs.isLocalSessionControlRequest(request)).toBe(false);
    }
  );

  it('preserves the existing authentication request without an account override', () => {
    const request = {
      ...envelope,
      type: 'machine/acp-authenticate',
      configId: 'config-1',
      action: 'start',
    };
    expect(MachineAcpAuthenticateRequestSchema.parse(request)).toEqual(request);
  });

  it('keeps launch authority in the persisted config and profile selection on login start', () => {
    const start = {
      ...envelope,
      type: 'machine/acp-authenticate',
      action: 'start',
      configId: 'config-1',
      accountProfileId,
    };
    const invalidRequests = [
      { ...start, configId: undefined },
      { ...start, env: { CODEX_HOME: '/caller-selected' } },
      { ...start, customAcp: { command: 'caller-selected' } },
      {
        ...envelope,
        type: 'machine/acp-authenticate',
        action: 'cancel',
        authenticationRequestId: 'login-1',
        accountProfileId,
      },
      {
        ...envelope,
        type: 'machine/account-profiles',
        cliType: 'builtin',
        agentType: 'codex',
        action: 'list',
      },
    ];
    for (const request of invalidRequests) {
      expect(isLocalSessionControlRequest(request)).toBe(false);
      expect(cjs.isLocalSessionControlRequest(request)).toBe(false);
    }
  });
});
