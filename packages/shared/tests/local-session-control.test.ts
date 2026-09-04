import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  isLocalSessionControlRequest,
  isLocalSessionControlResponse,
} from '../src/node/local-session-control';

const require = createRequire(import.meta.url);
const {
  isLocalSessionControlRequest: isLocalSessionControlRequestCjs,
  isLocalSessionControlResponse: isLocalSessionControlResponseCjs,
} = require('../src/node/local-session-control.cjs') as {
  isLocalSessionControlRequest: (value: unknown) => boolean;
  isLocalSessionControlResponse: (value: unknown) => boolean;
};

describe('local session control node validators', () => {
  it('accepts builtin Kimi sessions in TS and CJS validators', () => {
    const request = {
      type: 'session/create',
      sessionId: 'session-kimi',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'builtin',
        agentType: 'kimi',
        prompt: 'hello',
      },
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };
    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('accepts builtin DeepSeek Harness sessions in TS and CJS validators', () => {
    const request = {
      type: 'session/create',
      sessionId: 'session-deepseek',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'builtin',
        agentType: 'deepseek',
        prompt: 'hello',
      },
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };
    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('keeps ACP authentication messages in sync across TS and CJS validators', () => {
    const request = {
      type: 'machine/acp-authenticate',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      requestId: 'auth-1',
      action: 'start',
      configId: 'config-1',
    };
    const progress = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'kimi',
      status: 'authorization',
      authorizationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      expiresInSeconds: 900,
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
    const inputProgress = {
      type: 'machine/acp-authentication-progress',
      machineId: 'machine-1',
      requestId: 'auth-1',
      agentType: 'custom-agent',
      status: 'input-required',
      interactionId: 'interaction-1',
      message: 'Choose an account',
      form: {
        fields: [
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
      interactionId: 'interaction-1',
      authenticationInput: JSON.stringify({
        action: 'accept',
        content: { account: 'work' },
      }),
    };
    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
    expect(isLocalSessionControlRequest(submitCode)).toBe(true);
    expect(isLocalSessionControlRequestCjs(submitCode)).toBe(true);
    expect(isLocalSessionControlRequest(submitInput)).toBe(true);
    expect(isLocalSessionControlRequestCjs(submitInput)).toBe(true);
    for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
      expect(
        validate({
          ...request,
          customAcp: { command: '/tmp/untrusted-acp' },
          env: { TOKEN: 'attacker-controlled' },
        })
      ).toBe(false);
      expect(
        validate({
          ...submitInput,
          configId: 'config-1',
          runtimeOverrides: { kimiPath: '/tmp/untrusted-kimi' },
        })
      ).toBe(false);
    }
    expect(isLocalSessionControlResponse(progress)).toBe(true);
    expect(isLocalSessionControlResponseCjs(progress)).toBe(true);
    expect(isLocalSessionControlResponse(inputProgress)).toBe(true);
    expect(isLocalSessionControlResponseCjs(inputProgress)).toBe(true);
    expect(isLocalSessionControlResponse(response)).toBe(true);
    expect(isLocalSessionControlResponseCjs(response)).toBe(true);
  });

  it('accepts image upload requests without workspaceId', () => {
    expect(
      isLocalSessionControlRequest({
        type: 'session/image-upload',
        machineId: 'machine-1',
        sessionId: 'session-1',
        paths: ['/tmp/screenshot.png'],
      })
    ).toBe(true);
  });

  it('accepts up to 8 image upload paths and rejects 9', () => {
    const baseRequest = {
      type: 'session/image-upload',
      machineId: 'machine-1',
      sessionId: 'session-1',
    };

    expect(
      isLocalSessionControlRequest({
        ...baseRequest,
        paths: Array.from({ length: 8 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(true);
    expect(
      isLocalSessionControlRequest({
        ...baseRequest,
        paths: Array.from({ length: 9 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(false);
    expect(
      isLocalSessionControlRequestCjs({
        ...baseRequest,
        paths: Array.from({ length: 8 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(true);
    expect(
      isLocalSessionControlRequestCjs({
        ...baseRequest,
        paths: Array.from({ length: 9 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(false);
  });

  it('accepts image upload responses with image groups', () => {
    expect(
      isLocalSessionControlResponse({
        type: 'session/image-upload_response',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        success: true,
        historyEntryId: 'assistant-image-1',
        attachedTo: 'new_entry',
        content: {
          type: 'image_group',
          images: [
            {
              imageId: 'image-1',
              mimeType: 'image/png',
              fileName: 'screenshot.png',
              sizeBytes: 1024,
              width: 1280,
              height: 720,
            },
          ],
        },
        images: [
          {
            imageId: 'image-1',
            mimeType: 'image/png',
            fileName: 'screenshot.png',
            sizeBytes: 1024,
            width: 1280,
            height: 720,
            downloadUrl: 'https://example.com/image-1',
          },
        ],
      })
    ).toBe(true);
  });

  it('accepts file upload requests without workspaceId (ts + cjs)', () => {
    const request = {
      type: 'session/file-upload',
      machineId: 'machine-1',
      sessionId: 'session-1',
      paths: ['/tmp/build.log'],
    };
    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('accepts up to 8 file upload paths and rejects 9 (ts + cjs)', () => {
    const base = {
      type: 'session/file-upload',
      machineId: 'machine-1',
      sessionId: 'session-1',
    };
    const eight = { ...base, paths: Array.from({ length: 8 }, (_, i) => `/tmp/f${i}.bin`) };
    const nine = { ...base, paths: Array.from({ length: 9 }, (_, i) => `/tmp/f${i}.bin`) };
    expect(isLocalSessionControlRequest(eight)).toBe(true);
    expect(isLocalSessionControlRequestCjs(eight)).toBe(true);
    expect(isLocalSessionControlRequest(nine)).toBe(false);
    expect(isLocalSessionControlRequestCjs(nine)).toBe(false);
  });

  it('accepts file upload responses with r2 file blocks (ts + cjs)', () => {
    const response = {
      type: 'session/file-upload_response',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      success: true,
      historyEntryId: 'assistant-file-1',
      attachedTo: 'new_entry',
      files: [
        {
          type: 'file',
          fileId: 'file-1',
          fileName: 'build.log',
          mimeType: 'text/plain',
          sizeBytes: 2048,
          sha256: 'a'.repeat(64),
          textPreview: true,
          transport: 'r2',
          uploadedAt: 1_700_000_000_000,
          downloadUrl: 'https://example.com/files/file-1',
        },
      ],
    };
    expect(isLocalSessionControlResponse(response)).toBe(true);
    expect(isLocalSessionControlResponseCjs(response)).toBe(true);
  });

  it('rejects local-transport file blocks without a machineId (ts + cjs)', () => {
    const response = {
      type: 'session/file-upload_response',
      sessionId: 'session-1',
      success: true,
      files: [
        {
          type: 'file',
          fileId: 'file-1',
          fileName: 'build.log',
          mimeType: 'text/plain',
          sizeBytes: 2048,
          sha256: 'a'.repeat(64),
          textPreview: false,
          transport: 'local',
          uploadedAt: 1_700_000_000_000,
          downloadUrl: 'https://example.com/files/file-1',
        },
      ],
    };
    expect(isLocalSessionControlResponse(response)).toBe(false);
    expect(isLocalSessionControlResponseCjs(response)).toBe(false);
  });

  it('accepts file-send-local requests like file-upload (ts + cjs)', () => {
    const base = {
      type: 'session/file-send-local',
      machineId: 'machine-1',
      sessionId: 'session-1',
    };
    const oneFile = { ...base, workspaceId: 'workspace-1', paths: ['/tmp/build.log'] };
    expect(isLocalSessionControlRequest(oneFile)).toBe(true);
    expect(isLocalSessionControlRequestCjs(oneFile)).toBe(true);

    const eight = { ...base, paths: Array.from({ length: 8 }, (_, i) => `/tmp/f${i}.bin`) };
    const nine = { ...base, paths: Array.from({ length: 9 }, (_, i) => `/tmp/f${i}.bin`) };
    expect(isLocalSessionControlRequest(eight)).toBe(true);
    expect(isLocalSessionControlRequestCjs(eight)).toBe(true);
    expect(isLocalSessionControlRequest(nine)).toBe(false);
    expect(isLocalSessionControlRequestCjs(nine)).toBe(false);
  });

  it('accepts file-send-local responses with local file blocks (ts + cjs)', () => {
    const response = {
      type: 'session/file-send-local_response',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      success: true,
      files: [
        {
          type: 'file',
          fileId: 'file-1',
          fileName: 'build.log',
          mimeType: 'text/plain',
          sizeBytes: 2048,
          sha256: 'a'.repeat(64),
          textPreview: true,
          transport: 'local',
          machineId: 'machine-1',
          uploadedAt: 1_700_000_000_000,
        },
      ],
    };
    expect(isLocalSessionControlResponse(response)).toBe(true);
    expect(isLocalSessionControlResponseCjs(response)).toBe(true);
  });

  it('rejects file-send-local responses whose local block omits machineId (ts + cjs)', () => {
    const response = {
      type: 'session/file-send-local_response',
      sessionId: 'session-1',
      success: true,
      files: [
        {
          type: 'file',
          fileId: 'file-1',
          fileName: 'build.log',
          mimeType: 'text/plain',
          sizeBytes: 2048,
          sha256: 'a'.repeat(64),
          textPreview: false,
          transport: 'local',
          uploadedAt: 1_700_000_000_000,
        },
      ],
    };
    expect(isLocalSessionControlResponse(response)).toBe(false);
    expect(isLocalSessionControlResponseCjs(response)).toBe(false);
  });

  it('accepts branch-less local projects in the cjs validator', () => {
    expect(
      isLocalSessionControlRequestCjs({
        type: 'session/create',
        sessionId: 'session-1',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        project: {
          kind: 'local',
          localProjectId: 'project-1',
        },
        acpSessionConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          prompt: 'hello',
          chatMode: 'agent',
        },
        userId: 'user-1',
        userName: 'Test User',
        userEmail: 'test@example.com',
      })
    ).toBe(true);
  });

  it('accepts local project useWorktree in ts and cjs validators', () => {
    const request = {
      type: 'session/create' as const,
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      project: {
        kind: 'local' as const,
        localProjectId: 'project-1',
        useWorktree: true,
      },
      acpSessionConfig: {
        cliType: 'builtin' as const,
        agentType: 'codex',
        prompt: 'hello',
      },
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('accepts session/create with optional userTurnId in ts and cjs validators', () => {
    const request = {
      type: 'session/create' as const,
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'builtin',
        agentType: 'codex',
        prompt: 'hello',
      },
      userTurnId: 'turn-1',
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('accepts registry Interactive Claude session requests in ts and cjs validators', () => {
    const request = {
      type: 'session/create' as const,
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'registry',
        agentType: 'claude-p',
        prompt: 'hello',
      },
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('rejects builtin Interactive Claude session requests in ts and cjs validators', () => {
    const request = {
      type: 'session/create' as const,
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'builtin',
        agentType: 'claude-p',
        prompt: 'hello',
      },
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };

    expect(isLocalSessionControlRequest(request)).toBe(false);
    expect(isLocalSessionControlRequestCjs(request)).toBe(false);
  });

  it('accepts configOptionValues in ts and cjs validators', () => {
    const request = {
      type: 'session/chat' as const,
      sessionId: 'session-1',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'builtin',
        agentType: 'codex',
        prompt: 'hello',
        configOptionValues: {
          approval: 'never',
          fast_mode: true,
        },
      },
      userTurnId: 'turn-1',
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('accepts config-bound capability refresh and rejects launch fields in ts and cjs', () => {
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      configId: 'config-1',
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
    expect(
      isLocalSessionControlRequest({
        ...request,
        customAcp: { command: '/tmp/untrusted-acp' },
        env: { ACP_PROVIDER_TOKEN: 'attacker-controlled' },
      })
    ).toBe(false);
    expect(
      isLocalSessionControlRequestCjs({
        ...request,
        customAcp: { command: '/tmp/untrusted-acp' },
        env: { ACP_PROVIDER_TOKEN: 'attacker-controlled' },
      })
    ).toBe(false);
  });

  it('accepts machine ping requests and responses in ts and cjs validators', () => {
    const request = {
      type: 'machine/ping' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      requestId: 'ping-1',
    };
    const response = {
      type: 'machine/ping_response' as const,
      machineId: 'machine-1',
      requestId: 'ping-1',
      success: true,
      message: 'pong' as const,
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
    expect(isLocalSessionControlResponse(response)).toBe(true);
    expect(isLocalSessionControlResponseCjs(response)).toBe(true);
  });

  it('accepts Code Collab host start requests in ts and cjs validators', () => {
    const request = {
      type: 'session/code-collab-host-start' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      requestedByUserId: 'user-1',
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('accepts preview candidate reports in ts and cjs validators', () => {
    const request = {
      type: 'session/preview-candidate-report' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      target: {
        protocol: 'http' as const,
        host: '127.0.0.1',
        port: 5173,
      },
      source: {
        toolName: 'lody_report_preview_candidate',
        devServerType: 'vite',
        command: 'pnpm dev',
        cwd: '/tmp/project',
        pid: 123,
      },
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('requires signed request fields for preview creation in ts and cjs validators', () => {
    const request = {
      type: 'session/preview-create' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      requestedByUserId: 'user-1',
      requestId: 'request-1',
      requestToken: 'signed-preview-token',
      target: { protocol: 'http' as const, host: '127.0.0.1', port: 5173 },
      approval: {
        source: 'browser_address' as const,
        targetClass: 'loopback' as const,
        target: { protocol: 'http' as const, host: '127.0.0.1', port: 5173 },
        confirmedByUserId: 'user-1',
        confirmedAt: 1000,
      },
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
    expect(isLocalSessionControlRequest({ ...request, requestToken: '' })).toBe(false);
    expect(isLocalSessionControlRequestCjs({ ...request, requestId: '' })).toBe(false);
  });

  it('accepts preview responses in ts and cjs validators', () => {
    const response = {
      type: 'session/preview-create_response' as const,
      sessionId: 'session-1',
      success: false,
      error: 'tunnel_not_configured',
      message: 'Preview gateway is not configured.',
      connection: {
        status: 'failed',
        target: {
          protocol: 'http' as const,
          host: '127.0.0.1',
          port: 5173,
        },
        error: {
          stage: 'connect',
          errorCode: 'tunnel_not_configured',
          message: 'Preview gateway is not configured.',
          retryable: false,
        },
      },
    };

    expect(isLocalSessionControlResponse(response)).toBe(true);
    expect(isLocalSessionControlResponseCjs(response)).toBe(true);
  });

  it('accepts machine status lifecycle capability in ts and cjs validators', () => {
    const response = {
      type: 'machine/status_response' as const,
      machineId: 'machine-1',
      success: true,
      resources: {
        totalMemoryGB: 16,
        usedMemoryGB: 8,
        freeMemoryGB: 8,
        totalCpus: 8,
        cpuUsagePercent: 25,
      },
      lifecycle: {
        launchMode: 'daemon' as const,
        canRemoteRestart: true,
        canRemoteUpgrade: true,
      },
    };

    expect(isLocalSessionControlResponse(response)).toBe(true);
    expect(isLocalSessionControlResponseCjs(response)).toBe(true);

    expect(
      isLocalSessionControlResponse({
        ...response,
        lifecycle: {
          launchMode: 'electron',
          canRemoteRestart: false,
          canRemoteUpgrade: false,
          reason: 'electron',
        },
      })
    ).toBe(true);
  });

  it('accepts unsupported launch mode lifecycle responses in ts and cjs validators', () => {
    for (const type of ['machine/restart_response', 'machine/upgrade_response'] as const) {
      const response = {
        type,
        machineId: 'machine-1',
        requestId: 'request-1',
        success: false,
        accepted: false,
        disposition: 'unsupported_launch_mode' as const,
        error: 'not daemon supervised',
      };
      expect(isLocalSessionControlResponse(response)).toBe(true);
      expect(isLocalSessionControlResponseCjs(response)).toBe(true);
    }
  });

  it('accepts Code Collab host start responses in ts and cjs validators', () => {
    const response = {
      type: 'session/code-collab-host-start_response' as const,
      sessionId: 'session-1',
      success: true,
      status: 'started',
    };

    expect(isLocalSessionControlResponse(response)).toBe(true);
    expect(isLocalSessionControlResponseCjs(response)).toBe(true);
  });

  it('accepts ACP binary status/install requests in ts and cjs validators', () => {
    for (const type of ['machine/acp-binary-status', 'machine/acp-binary-install'] as const) {
      const request = {
        type,
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        agentType: 'crow-cli',
      };
      expect(isLocalSessionControlRequest(request)).toBe(true);
      expect(isLocalSessionControlRequestCjs(request)).toBe(true);

      // Missing agentType is rejected.
      const invalid = { type, machineId: 'machine-1', workspaceId: 'workspace-1', agentType: '' };
      expect(isLocalSessionControlRequest(invalid)).toBe(false);
      expect(isLocalSessionControlRequestCjs(invalid)).toBe(false);
    }
  });

  it('accepts ACP binary status/install responses in ts and cjs validators', () => {
    const statusResponse = {
      type: 'machine/acp-binary-status_response' as const,
      machineId: 'machine-1',
      agentType: 'crow-cli',
      success: true,
      status: 'installed' as const,
      command: '/home/user/.lody/acp-bin/crow-cli/0.1.24/linux-x86_64/crow-cli',
      platformArch: 'linux-x86_64',
    };
    expect(isLocalSessionControlResponse(statusResponse)).toBe(true);
    expect(isLocalSessionControlResponseCjs(statusResponse)).toBe(true);

    // An out-of-range status string is rejected.
    expect(isLocalSessionControlResponse({ ...statusResponse, status: 'downloading' })).toBe(false);
    expect(isLocalSessionControlResponseCjs({ ...statusResponse, status: 'downloading' })).toBe(
      false
    );

    const installResponse = {
      type: 'machine/acp-binary-install_response' as const,
      machineId: 'machine-1',
      agentType: 'crow-cli',
      success: false,
      error: 'download failed',
    };
    expect(isLocalSessionControlResponse(installResponse)).toBe(true);
    expect(isLocalSessionControlResponseCjs(installResponse)).toBe(true);
  });

  it('accepts ACP binary progress responses in ts and cjs validators', () => {
    const progress = {
      type: 'machine/acp-binary-progress' as const,
      machineId: 'machine-1',
      agentType: 'codex',
      status: 'downloading' as const,
      downloadedBytes: 10,
      totalBytes: 100,
      percent: 10,
      platformArch: 'darwin-arm64',
      version: '0.32.0',
    };

    expect(isLocalSessionControlResponse(progress)).toBe(true);
    expect(isLocalSessionControlResponseCjs(progress)).toBe(true);
    expect(isLocalSessionControlResponse({ ...progress, percent: 101 })).toBe(false);
    expect(isLocalSessionControlResponseCjs({ ...progress, percent: 101 })).toBe(false);
  });
});
