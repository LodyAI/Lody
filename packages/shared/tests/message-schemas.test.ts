import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MessageContentSchema,
  normalizeSessionTurnInputConfig,
  LocalProjectControlRequestSchema,
  LocalProjectControlResponseSchema,
  LocalSessionControlResponseSchema,
  BuiltinRuntimeOverridesSchema,
  CliTypeSchema,
  MachineAcpAuthenticateRequestSchema,
  MachineAcpAuthenticateResponseSchema,
  MachineAcpAuthenticationProgressMessageSchema,
  MachineAcpBinaryProgressMessageSchema,
  safeParseLocalSessionControlRequest,
  safeParseServerReceiveMessage,
  safeParseServerToMachine,
  MachineAcpCapabilitiesRefreshRequestSchema,
  MachineAcpCapabilitiesRefreshResponseSchema,
  ServerToClientSchema,
  SessionCancelRequestSchema,
  SessionChatRequestSchema,
  SessionCreateRequestSchema,
  SessionSteerRequestSchema,
  SessionSteerResponseSchema,
  SessionImageUploadResponseSchema,
  SessionIdSchema,
  SessionImagePayloadSchema,
} from '../src/message-schemas';
import { ACP_CAPABILITY_CACHE_VERSION, type SessionImagePayload } from '../src/ai';
import { ACP_AUTHENTICATION_FORM_MAX_BYTES } from '../src/acp-authentication-limits';
import type { SessionId } from '../src/ids';

describe('branded id schemas', () => {
  it('preserves the SessionId domain type through parsing', () => {
    const sessionId = SessionIdSchema.parse('session-1');
    const image = SessionImagePayloadSchema.parse({
      imageId: 'image-1',
      mimeType: 'image/png',
      sizeBytes: 1,
      storageSessionId: 'session-1',
    });

    expect(sessionId).toBe('session-1');
    expectTypeOf(sessionId).toEqualTypeOf<SessionId>();
    expectTypeOf(image).toMatchTypeOf<SessionImagePayload>();
    expectTypeOf(image.storageSessionId).toEqualTypeOf<SessionId | undefined>();
  });
});

describe('message-schemas system_notice', () => {
  it('accepts resume_from_external_chat_history notice', () => {
    const result = MessageContentSchema.safeParse({
      type: 'system_notice',
      name: 'resume_from_external_chat_history',
      meta: {
        truncated: true,
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts chat_failed notice with reason meta', () => {
    const result = MessageContentSchema.safeParse({
      type: 'system_notice',
      name: 'chat_failed',
      meta: {
        reason: 'session_not_found',
        message: 'Session not found',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta).toEqual({
        reason: 'session_not_found',
        message: 'Session not found',
      });
    }
  });

  it('accepts an actionable diagnostic code on a generic chat failure reason', () => {
    const result = MessageContentSchema.safeParse({
      type: 'system_notice',
      name: 'chat_failed',
      meta: {
        reason: 'turn_pre_prompt_failed',
        code: 'git_executable_not_found',
        message: 'Git is unavailable',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta).toEqual({
        reason: 'turn_pre_prompt_failed',
        code: 'git_executable_not_found',
        message: 'Git is unavailable',
      });
    }
  });

  it('rejects chat_failed notice without reason', () => {
    const result = MessageContentSchema.safeParse({
      type: 'system_notice',
      name: 'chat_failed',
      meta: {
        message: 'Session not found',
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts image_group content', () => {
    const result = MessageContentSchema.safeParse({
      type: 'image_group',
      images: [
        {
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'page.png',
          sizeBytes: 1024,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts normalized provider-neutral goal content', () => {
    const result = MessageContentSchema.safeParse({
      type: 'goal',
      threadId: 'thread-1',
      objective: 'ship the release',
      status: 'blocked',
      tokenBudget: 42_000,
      tokensUsed: 12_000,
    });

    expect(result.success).toBe(true);
  });

  it.each(['budgetLimited', 'cleared'])('accepts legacy full %s goal content', (status) => {
    const result = MessageContentSchema.safeParse({
      type: 'goal',
      threadId: 'thread-1',
      turnId: null,
      objective: 'ship the release',
      status,
      tokenBudget: 1000,
      tokensUsed: 750,
      timeUsedSeconds: 42,
      createdAt: 100,
      updatedAt: 200,
    });

    expect(result.success).toBe(true);
  });
});

describe('message-schemas session steer', () => {
  it('accepts a turn-scoped steer request and response', () => {
    expect(
      SessionSteerRequestSchema.safeParse({
        type: 'session/steer',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        expectedTurnId: 'assistant:user-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction' },
      }).success
    ).toBe(true);
    expect(
      SessionSteerResponseSchema.safeParse({
        type: 'session/steer_response',
        sessionId: 'session-1',
        userTurnId: 'user-2',
        applied: false,
        disposition: 'unsupported',
      }).success
    ).toBe(true);
    expect(
      SessionSteerResponseSchema.safeParse({
        type: 'session/steer_response',
        sessionId: 'session-1',
        userTurnId: 'user-2',
        accepted: true,
        disposition: 'accepted',
      }).success
    ).toBe(false);
  });

  it('rejects a steer request without the expected active turn', () => {
    expect(
      SessionSteerRequestSchema.safeParse({
        type: 'session/steer',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        userTurnId: 'user-2',
        userId: 'user-1',
        timestamp: '2026-07-11T00:00:00.000Z',
        inputConfig: { prompt: 'change direction' },
      }).success
    ).toBe(false);
  });
});

describe('message-schemas image upload response', () => {
  it('rejects empty uploaded image lists', () => {
    const result = SessionImageUploadResponseSchema.safeParse({
      type: 'session/image-upload_response',
      sessionId: 'session-1',
      success: true,
      images: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects uploaded image lists larger than the per-request limit', () => {
    const result = SessionImageUploadResponseSchema.safeParse({
      type: 'session/image-upload_response',
      sessionId: 'session-1',
      success: true,
      images: Array.from({ length: 9 }, (_, index) => ({
        imageId: `img-${index}`,
        mimeType: 'image/png',
        fileName: `image-${index}.png`,
        sizeBytes: 1024,
        downloadUrl: `https://example.com/image-${index}.png`,
      })),
    });

    expect(result.success).toBe(false);
  });
});

describe('message-schemas machine ACP capabilities refresh', () => {
  it('accepts builtin Kimi runtime fields', () => {
    expect(CliTypeSchema.safeParse('kimi').success).toBe(true);
    expect(CliTypeSchema.safeParse('grok').success).toBe(true);
    expect(BuiltinRuntimeOverridesSchema.safeParse({ kimiPath: '/opt/kimi' }).success).toBe(true);
    expect(BuiltinRuntimeOverridesSchema.safeParse({ grokPath: '/opt/grok' }).success).toBe(true);
  });

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

  it('preserves the complete capability used to converge the renderer after refresh', () => {
    const response = {
      type: 'machine/acp-capabilities-refresh_response',
      machineId: 'machine-1',
      configId: 'config-1',
      cliType: 'registry',
      agentType: 'deepseek',
      success: true,
      capability: {
        cliType: 'registry',
        agentType: 'deepseek',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        provenance: 'runtime',
        sourceVersion: 'registry:deepseek:test',
        modes: [],
        models: [{ modelId: 'kimi-k3', name: 'Kimi K3' }],
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'kimi-k3',
            options: [{ value: 'kimi-k3', name: 'Kimi K3' }],
          },
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'max',
            options: ['low', 'high', 'max'].map((value) => ({ value, name: value })),
          },
        ],
        modelReasoningEfforts: { 'kimi-k3': ['low', 'high', 'max'] },
        sessionFork: false,
        fetchedAt: 1,
      },
    };

    expect(MachineAcpCapabilitiesRefreshResponseSchema.parse(response).capability).toEqual(
      response.capability
    );
  });
});

describe('message-schemas machine ACP authentication', () => {
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

    expect(MachineAcpAuthenticateRequestSchema.safeParse(request).success).toBe(true);
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

describe('message-schemas machine ACP binary progress', () => {
  it('accepts download progress on server and local-control response channels', () => {
    const progress = {
      type: 'machine/acp-binary-progress' as const,
      machineId: 'machine-1',
      agentType: 'codex',
      status: 'downloading' as const,
      downloadedBytes: 512,
      totalBytes: 1024,
      percent: 50,
      platformArch: 'darwin-arm64',
      version: '0.32.0',
    };

    expect(MachineAcpBinaryProgressMessageSchema.safeParse(progress).success).toBe(true);
    expect(ServerToClientSchema.safeParse(progress).success).toBe(true);
    expect(LocalSessionControlResponseSchema.safeParse(progress).success).toBe(true);
  });

  it('rejects out-of-range progress percentages', () => {
    expect(
      MachineAcpBinaryProgressMessageSchema.safeParse({
        type: 'machine/acp-binary-progress',
        machineId: 'machine-1',
        agentType: 'codex',
        status: 'downloading',
        percent: 101,
      }).success
    ).toBe(false);
  });
});

describe('message-schemas local project control', () => {
  it('accepts list-dir error responses', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: false,
      type: 'local-project/list-dir',
      error: 'path_invalid',
      message: 'Project directory path escapes project root.',
    });

    expect(result.success).toBe(true);
  });

  it('accepts list-skills requests and responses', () => {
    expect(
      LocalProjectControlRequestSchema.safeParse({
        type: 'local-project/list-skills',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
        skillDirs: ['.agents/skills', '.claude/skills'],
        requestedByUserId: 'user-1',
      }).success
    ).toBe(true);

    expect(
      LocalProjectControlResponseSchema.safeParse({
        ok: true,
        type: 'local-project/list-skills',
        result: {
          groups: [
            {
              dir: '.agents/skills',
              scope: 'project',
              skills: [
                {
                  id: '.agents/skills/review',
                  name: 'review',
                  relativePath: '.agents/skills/review/SKILL.md',
                  isSymlink: false,
                },
              ],
              truncated: false,
            },
          ],
          contentFingerprint: 'fingerprint',
        },
      }).success
    ).toBe(true);

    expect(
      LocalProjectControlRequestSchema.safeParse({
        type: 'local-project/list-global-skills',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        requestedByUserId: 'user-1',
      }).success
    ).toBe(true);

    expect(
      LocalProjectControlResponseSchema.safeParse({
        ok: true,
        type: 'local-project/list-global-skills',
        result: {
          groups: [
            {
              scope: 'global',
              dir: '~/.codex/skills',
              skills: [
                {
                  id: '~/.codex/skills/review',
                  name: 'review',
                  relativePath: '~/.codex/skills/review/SKILL.md',
                  absolutePath: '/home/user/.codex/skills/review/SKILL.md',
                  isSymlink: false,
                },
              ],
              truncated: false,
            },
          ],
          contentFingerprint: 'fingerprint',
        },
      }).success
    ).toBe(true);
  });
});

describe('message-schemas acpSessionConfig', () => {
  it('requires turnId in session/cancel requests', () => {
    const result = SessionCancelRequestSchema.safeParse({
      type: 'session/cancel',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      turnId: 'assistant-turn-1',
    });

    expect(result.success).toBe(true);
  });

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

  it('accepts session/create meta.fromFeedbackPostId', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      meta: {
        fromFeedbackPostId: 'post-123',
      },
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
        chatMode: 'agent',
      },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(true);
  });

  it('accepts optional session/create userTurnId', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
      },
      userTurnId: 'turn-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(true);
  });

  it('accepts configOptionValues in acpSessionConfig', () => {
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
          fast_mode: true,
        },
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

  it('rejects empty session/create meta.fromFeedbackPostId', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      meta: {
        fromFeedbackPostId: '   ',
      },
      acpSessionConfig: {
        prompt: 'hello',
        cliType: 'builtin',
        agentType: 'codex',
        chatMode: 'agent',
      },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(false);
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
  it('keeps valid fields and drops invalid ones', () => {
    const normalized = normalizeSessionTurnInputConfig({
      prompt: '  hello  ',
      cliType: 'builtin',
      agentType: 'codex',
      modelId: 'gpt-5',
      configOptionValues: {
        approval: 'never',
        $cid: 'cid:21@8796158212915367241:Map',
      },
      resume: 'acp-1',
      inputBlocks: [{ type: 'text', text: 'hello' }],
      taskToolsEnabled: false,
      issuePRMentions: 'invalid',
    });

    expect(normalized).toEqual({
      prompt: 'hello',
      cliType: 'builtin',
      agentType: 'codex',
      modelId: 'gpt-5',
      configOptionValues: {
        approval: 'never',
      },
      resume: 'acp-1',
      inputBlocks: [{ type: 'text', text: 'hello' }],
      taskToolsEnabled: false,
    });
  });
});

describe('message-schemas branch', () => {
  it('rejects session/chat project without branch', () => {
    const result = SessionChatRequestSchema.safeParse({
      type: 'session/chat',
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
      userTurnId: 'turn-1',
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(false);
  });

  it('accepts local project with githubRepoFullName binding', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      project: {
        kind: 'local',
        localProjectId: 'local-project-1',
        branch: 'main',
        githubRepoFullName: 'owner/repo',
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

    expect(result.success).toBe(true);
  });

  it('accepts local project without branch', () => {
    const result = SessionCreateRequestSchema.safeParse({
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
        chatMode: 'agent',
      },
      userId: 'user-1',
      userName: 'User',
      userEmail: 'user@example.com',
    });

    expect(result.success).toBe(true);
  });

  it('accepts local project worktree selection', () => {
    const result = SessionCreateRequestSchema.safeParse({
      type: 'session/create',
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      project: {
        kind: 'local',
        localProjectId: 'local-project-1',
        useWorktree: true,
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

    expect(result.success).toBe(true);
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

  it('accepts legacy top-level githubRepo/branch fields and normalizes to project', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/create',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        githubRepo: 'owner/repo',
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

  it('preserves local githubRepoFullName binding after normalization', () => {
    const result = safeParseServerToMachine(
      JSON.stringify({
        type: 'session/create',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        project: {
          kind: 'local',
          localProjectId: 'local-project-1',
          branch: 'main',
          githubRepoFullName: 'owner/repo',
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
        branch: 'main',
        githubRepoFullName: 'owner/repo',
      });
    }
  });
});

describe('safeParseLocalSessionControlRequest', () => {
  it('accepts session/image-upload without workspaceId', () => {
    const result = safeParseLocalSessionControlRequest(
      JSON.stringify({
        type: 'session/image-upload',
        machineId: 'machine-1',
        sessionId: 'session-1',
        paths: ['/tmp/page.png'],
      })
    );

    expect(result.success).toBe(true);
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

  it('drops unexpected legacy chatMode values before validating session/chat', () => {
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
          cliType: 'builtin',
          agentType: 'codex',
          chatMode: 'full-auto',
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

  it('rejects invalid non-legacy cliType even when agentType is legacy', () => {
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
          cliType: 'foo',
          agentType: 'codex',
        },
        userTurnId: 'turn-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(false);
  });
});

describe('safeParseServerReceiveMessage legacy project compatibility', () => {
  it('accepts legacy session/create with githubRepo + branch-less project', () => {
    const result = safeParseServerReceiveMessage(
      JSON.stringify({
        type: 'session/create',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        githubRepo: 'owner/repo',
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

  it('accepts legacy session/create with local branch-less project', () => {
    const result = safeParseServerReceiveMessage(
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

  it('accepts legacy session/chat acpSessionConfig with cliType=claude and no agentType', () => {
    const result = safeParseServerReceiveMessage(
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
      expect(result.data.acpSessionConfig.agentType).toBe('claude');
    }
  });

  it('prefers legacy agentType in session/chat when both legacy cliType and agentType are present', () => {
    const result = safeParseServerReceiveMessage(
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

  it('rejects invalid non-legacy cliType in session/chat even when agentType is legacy', () => {
    const result = safeParseServerReceiveMessage(
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
          cliType: 'foo',
          agentType: 'codex',
        },
        userTurnId: 'turn-1',
        userId: 'user-1',
        userName: 'User',
        userEmail: 'user@example.com',
      })
    );

    expect(result.success).toBe(false);
  });
});
