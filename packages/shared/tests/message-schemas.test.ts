import { describe, expect, it } from 'vitest';

import {
  normalizeSessionTurnInputConfig,
  SessionHistoryInputConfigSchema,
  LocalSessionControlResponseSchema,
  MachineAcpAuthenticateRequestSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  safeParseLocalSessionControlRequest,
  safeParseServerToMachine,
  MachineAcpCapabilitiesRefreshRequestSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  ServerToClientSchema,
  SessionCreateRequestSchema,
} from '../src/message-schemas';

import { ACP_AUTHENTICATION_FORM_MAX_BYTES } from '../src/acp-authentication-limits';

describe('message-schemas machine ACP capabilities refresh', () => {
  it('accepts only a persisted config reference for capability probing', () => {
    const request = {
      type: 'machine/acp-capabilities-refresh',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      configId: 'config-1',
    };

    expect(MachineAcpCapabilitiesRefreshRequestSchema.safeParse(request).success).toBe(true);
    expect(
      MachineAcpCapabilitiesRefreshRequestSchema.safeParse({
        ...request,
        cliType: 'registry',
        agentType: 'env-agent',
        customAcp: { command: '/tmp/untrusted-acp' },
        env: { ACP_PROVIDER_TOKEN: 'attacker-controlled' },
        runtimeOverrides: { kimiPath: '/tmp/untrusted-kimi' },
      }).success
    ).toBe(false);
  });
});

describe('message-schemas machine ACP authentication', () => {
  it('carries more than 32 advertised authentication methods through RPC', () => {
    const authMethods = Array.from({ length: 46 }, (_, index) => ({
      type: 'agent',
      id: `provider-${index}`,
      name: `Provider ${index}`,
    }));
    const progress = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'sorbet',
      status: 'auth-methods',
      interactionId: 'choice-1',
      authMethods,
    };
    expect(MachineAcpAuthenticationProgressMessageSchema.safeParse(progress).success).toBe(true);
    expect(
      MachineAcpCapabilitiesRefreshResponseSchema.safeParse({
        type: 'machine/acp-capabilities-refresh_response',
        machineId: 'machine-1',
        configId: 'config-1',
        cliType: 'builtin',
        agentType: 'sorbet',
        success: false,
        authRequired: true,
        authMethods,
      }).success
    ).toBe(true);
  });

  it('accepts config-bound starts and request-bound follow-ups', () => {
    const request = {
      type: 'machine/acp-authenticate',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      requestId: 'auth-1',
      action: 'start',
      configId: 'config-1',
    };
    const forgedStart = {
      ...request,
      cliType: 'registry',
      agentType: 'custom-agent',
      customAcp: { command: '/tmp/untrusted-acp' },
      env: { TOKEN: 'attacker-controlled' },
      runtimeOverrides: { kimiPath: '/tmp/untrusted-kimi' },
    };
    const progress = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'kimi',
      status: 'authorization',
      authorizationUrl: 'https://www.kimi.com/code/authorize_device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      expiresInSeconds: 1800,
    };
    const submitCode = {
      type: 'machine/acp-authenticate',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      requestId: 'auth-input-1',
      action: 'submit-code',
      authenticationRequestId: 'auth-1',
      authorizationCode: 'browser-code',
    };
    const response = {
      type: 'machine/acp-authenticate_response',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'kimi',
      success: true,
      disposition: 'authenticated',
      capabilitiesRefreshed: false,
      authRequired: true,
      authMethods: [{ type: 'terminal', args: ['--login'] }],
      error: 'Authentication required',
    };
    const methodProgress = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'custom-agent',
      status: 'auth-methods',
      interactionId: 'method-choice-1',
      authMethods: [{ type: 'agent', id: 'oauth', name: 'Browser' }],
    };
    const formProgress = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'custom-agent',
      status: 'input-required',
      interactionId: 'form-1',
      message: 'Complete sign-in',
      form: {
        fields: [
          { id: 'code', type: 'secret', label: 'Code', required: true },
          {
            id: 'account',
            type: 'select',
            label: 'Account',
            required: true,
            options: [{ value: 'work', label: 'Work' }],
          },
        ],
      },
    };
    const submitInput = {
      type: 'machine/acp-authenticate',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      requestId: 'auth-input-2',
      action: 'submit-input',
      authenticationRequestId: 'auth-1',
      interactionId: 'form-1',
      authenticationInput: JSON.stringify({
        action: 'accept',
        content: { code: 'one-time-code', account: 'work' },
      }),
    };
    const runtimeDownloadProgress = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'codex',
      status: 'runtime-download',
      runtimeName: 'codex',
      runtimePhase: 'downloading',
      runtimePercent: 42,
    };

    expect(MachineAcpAuthenticateRequestSchema.safeParse(request).success).toBe(true);
    // A method picked from the advertised list travels on the start request.
    expect(
      MachineAcpAuthenticateRequestSchema.safeParse({ ...request, methodId: 'oauth' }).success
    ).toBe(true);
    for (const methodId of ['', '   ', 'x'.repeat(1025)]) {
      expect(MachineAcpAuthenticateRequestSchema.safeParse({ ...request, methodId }).success).toBe(
        false
      );
    }
    expect(MachineAcpAuthenticateRequestSchema.safeParse(forgedStart).success).toBe(false);
    expect(MachineAcpAuthenticateRequestSchema.safeParse(submitCode).success).toBe(true);
    expect(MachineAcpAuthenticateRequestSchema.safeParse(submitInput).success).toBe(true);
    expect(
      MachineAcpAuthenticateRequestSchema.safeParse({
        type: 'machine/acp-authenticate',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        requestId: 'auth-cancel-1',
        action: 'cancel',
        authenticationRequestId: 'auth-1',
        customAcp: { command: '/tmp/untrusted-acp' },
      }).success
    ).toBe(false);
    expect(MachineAcpAuthenticationProgressMessageSchema.safeParse(progress).success).toBe(true);
    expect(MachineAcpAuthenticationProgressMessageSchema.safeParse(methodProgress).success).toBe(
      true
    );
    expect(MachineAcpAuthenticationProgressMessageSchema.safeParse(formProgress).success).toBe(
      true
    );
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse(runtimeDownloadProgress).success
    ).toBe(true);
    // runtime-download progress requires the runtime identity it reports on.
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...runtimeDownloadProgress,
        runtimeName: undefined,
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...runtimeDownloadProgress,
        runtimePhase: undefined,
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...runtimeDownloadProgress,
        runtimePercent: 101,
      }).success
    ).toBe(false);
    expect(MachineAcpAuthenticateResponseSchema.safeParse(response).success).toBe(true);
    expect(LocalSessionControlResponseSchema.safeParse(response).success).toBe(true);
    expect(safeParseLocalSessionControlRequest(JSON.stringify(request)).success).toBe(true);
    expect(safeParseLocalSessionControlRequest(JSON.stringify(submitCode)).success).toBe(true);
    expect(ServerToClientSchema.safeParse(progress).success).toBe(true);
  });

  it('rejects unsafe authorization schemes and incomplete interaction progress', () => {
    const base = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'custom-agent',
    };

    for (const authorizationUrl of ['javascript:alert(1)', 'file:///tmp/credential']) {
      expect(
        MachineAcpAuthenticationProgressMessageSchema.safeParse({
          ...base,
          status: 'authorization',
          authorizationUrl,
        }).success
      ).toBe(false);
    }
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'authorization',
        authorizationUrl: 'http://127.0.0.1:8787/callback',
      }).success
    ).toBe(true);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'authorization',
        authorizationUrl: 'https://provider.example.test/oauth',
        requiresAuthorizationConsent: true,
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'auth-methods',
        interactionId: 'methods-1',
        authMethods: [{ type: 'env_var', id: 'legacy-env', name: 'Legacy environment' }],
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'auth-methods',
        interactionId: 'methods-1',
        authMethods: [
          { type: 'agent', id: 'oauth', name: 'Browser' },
          { type: 'agent', id: 'oauth', name: 'Duplicate' },
        ],
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'auth-methods',
        interactionId: 'methods-1',
        authMethods: [{ type: 'agent', name: 'Missing id' }],
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'input-required',
        interactionId: 'form-1',
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'input-required',
        interactionId: 'form-1',
        form: {
          fields: [
            {
              id: 'token',
              type: 'secret',
              label: 'Token',
              required: true,
              defaultValue: 'must-not-be-retained',
            },
          ],
        },
      }).success
    ).toBe(false);
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        ...base,
        status: 'input-required',
        interactionId: 'form-1',
        form: {
          fields: [
            {
              id: 'account',
              type: 'select',
              label: 'Account',
              required: true,
              options: [{ value: 'work', label: 'Work' }],
              defaultValue: 'missing',
            },
          ],
        },
      }).success
    ).toBe(false);
  });

  it('rejects a form whose valid individual fields exceed the total byte budget', () => {
    const options = Array.from({ length: 20 }, (_, index) => ({
      value: `${String(index).padStart(2, '0')}-${'x'.repeat(16_380)}`,
      label: `Option ${index}`,
    }));
    const form = {
      fields: [
        {
          id: 'account',
          type: 'select',
          label: 'Account',
          required: true,
          options,
        },
      ],
    };
    expect(new TextEncoder().encode(JSON.stringify(form)).byteLength).toBeGreaterThan(
      ACP_AUTHENTICATION_FORM_MAX_BYTES
    );
    expect(
      MachineAcpAuthenticationProgressMessageSchema.safeParse({
        type: 'machine/acp-authentication-progress',
        machineId: 'machine-1',
        requestId: 'auth-1',
        agentType: 'custom-agent',
        status: 'input-required',
        interactionId: 'form-1',
        form,
      }).success
    ).toBe(false);
  });
});

describe('message-schemas acpSessionConfig', () => {
  it('accepts forward-compatible extra keys in acpSessionConfig', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      project: {
        kind: 'github',
        repoFullName: 'owner/repo',
        branch: 'main',
      },
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
        issuePRMentions: [
          {
            type: 'issue',
            title: 'Fix crash',
            url: 'https://github.com/org/repo/issues/1',
            number: 1,
          },
        ],
        // Simulate a newer web field unknown to an older machine binary.
        futureField: { enabled: true },
      },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(true);
  });

  it('drops Loro Mirror container ids from configOptionValues', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
        configOptionValues: {
          approval: 'never',
          $cid: 'cid:21@8796158212915367241:Map',
        },
      },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acpSessionConfig.configOptionValues).toEqual({
        approval: 'never',
      });
    }
  });

  it('rejects session/create project without branch', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      project: {
        kind: 'github',
        repoFullName: 'owner/repo',
      },
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
      },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(false);
  });
});

describe('normalizeSessionTurnInputConfig', () => {
  it('drops provider launch fields from turn input', () => {
    const injected = {
      prompt: 'hello',
      cliType: 'builtin',
      agentType: 'pi',
      modelId: 'pi',
      customAcp: { command: '/tmp/injected-acp' },
      runtimeOverrides: { piExtensions: ['/tmp/injected.ts'] },
    };

    expect(normalizeSessionTurnInputConfig(injected)).toEqual({
      prompt: 'hello',
      cliType: 'builtin',
      agentType: 'pi',
      modelId: 'pi',
    });

    const stored = SessionHistoryInputConfigSchema.safeParse(injected);
    expect(stored.success).toBe(true);
    expect(stored.data).toEqual({
      prompt: 'hello',
      cliType: 'builtin',
      agentType: 'pi',
      modelId: 'pi',
    });
  });
});

describe('safeParseServerToMachine legacy project compatibility', () => {
  it('accepts legacy nested `project` branch field and normalizes it', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/chat',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        project: {
          kind: 'github',
          repoFullName: 'owner/repo',
          project: 'main',
        },
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: 'codex',
        },
        userTurnId: 'turn-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('session/chat');
      expect(result.data.project).toEqual({
        kind: 'github',
        repoFullName: 'owner/repo',
        branch: 'main',
      });
    }
  });

  it('accepts legacy top-level repoFullName/branch fields and normalizes to project', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/create',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        repoFullName: 'owner/repo',
        branch: 'main',
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: 'codex',
        },
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('session/create');
      expect(result.data.project).toEqual({
        kind: 'github',
        repoFullName: 'owner/repo',
        branch: 'main',
      });
    }
  });

  it('accepts legacy top-level githubRepo without branch and defaults to main', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/create',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        githubRepo: 'owner/repo',
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: 'codex',
        },
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('session/create');
      expect(result.data.project).toEqual({
        kind: 'github',
        repoFullName: 'owner/repo',
        branch: 'main',
      });
    }
  });

  it('accepts legacy local project without branch and preserves missing branch', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/create',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        project: {
          kind: 'local',
          localProjectId: 'local-project-1',
        },
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'builtin',
          agentType: 'codex',
        },
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('session/create');
      expect(result.data.project).toEqual({
        kind: 'local',
        localProjectId: 'local-project-1',
      });
    }
  });
});

describe('safeParseServerToMachine legacy acpSessionConfig compatibility', () => {
  it('accepts legacy acpSessionConfig with only agentType and normalizes cliType=builtin', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/chat',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        project: {
          kind: 'github',
          repoFullName: 'owner/repo',
          branch: 'main',
        },
        acpSessionConfig: {
          prompt: 'hello',
          agentType: 'codex',
          chatMode: 'agent',
        },
        userTurnId: 'turn-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('session/chat');
      expect(result.data.acpSessionConfig.cliType).toBe('builtin');
      expect(result.data.acpSessionConfig.agentType).toBe('codex');
      expect(result.data.acpSessionConfig).not.toHaveProperty('chatMode');
    }
  });

  it('accepts mixed legacy acpSessionConfig with cliType=codex and no agentType', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/chat',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        project: {
          kind: 'github',
          repoFullName: 'owner/repo',
          branch: 'main',
        },
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'codex',
        },
        userTurnId: 'turn-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('session/chat');
      expect(result.data.acpSessionConfig.cliType).toBe('builtin');
      expect(result.data.acpSessionConfig.agentType).toBe('codex');
    }
  });

  it('prefers legacy agentType when both legacy cliType and agentType are present', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/chat',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        project: {
          kind: 'github',
          repoFullName: 'owner/repo',
          branch: 'main',
        },
        acpSessionConfig: {
          prompt: 'hello',
          cliType: 'claude',
          agentType: 'codex',
        },
        userTurnId: 'turn-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('session/chat');
      expect(result.data.acpSessionConfig.cliType).toBe('builtin');
      expect(result.data.acpSessionConfig.agentType).toBe('codex');
    }
  });
});
