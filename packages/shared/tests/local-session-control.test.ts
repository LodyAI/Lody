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
  it('lets desktop prepare and resolve local images across both IPC guards', () => {
    const scope = { machineId: 'machine-1', workspaceId: 'workspace-1', sessionId: 'session-1' };
    const image = {
      imageId: '33333333-3333-4333-8333-333333333333',
      mimeType: 'image/png',
      sizeBytes: 8,
      fileName: 'screenshot.png',
      transport: 'local',
      machineId: scope.machineId,
    };
    const prepare = {
      ...scope,
      type: 'session/image-prepare-local',
      imageId: image.imageId,
      fileName: image.fileName,
      mimeType: image.mimeType,
    };
    for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
      for (const source of [{ path: '/tmp/screenshot.png' }, { base64: 'iVBORw0KGgo=' }]) {
        expect(validate({ ...prepare, source })).toBe(true);
        expect(validate({ ...prepare, source, machineId: '' })).toBe(false);
        expect(validate({ ...prepare, source, imageId: 'invalid' })).toBe(false);
        expect(validate({ ...prepare, source, mimeType: 'text/plain' })).toBe(false);
      }
      for (const source of [
        undefined,
        {},
        { path: '' },
        { base64: '' },
        { base64: 1 },
        { path: '/tmp/image.png', base64: 'iVBORw0KGgo=' },
      ]) {
        expect(validate({ ...prepare, source })).toBe(false);
      }
      const resolve = { ...scope, type: 'session/image-resolve-local', image };
      expect(validate(resolve)).toBe(true);
      expect(validate({ ...resolve, image: { ...image, sizeBytes: -1 } })).toBe(false);
    }
    for (const validate of [isLocalSessionControlResponse, isLocalSessionControlResponseCjs]) {
      const prepared = {
        type: 'session/image-prepare-local_response',
        sessionId: scope.sessionId,
        success: true,
        image,
      };
      const resolved = {
        type: 'session/image-resolve-local_response',
        sessionId: scope.sessionId,
        success: true,
        path: '/tmp/screenshot.png',
      };
      expect(validate(prepared)).toBe(true);
      expect(validate(resolved)).toBe(true);
      expect(validate({ ...prepared, image: undefined })).toBe(false);
      expect(validate({ ...prepared, image: { ...image, mimeType: 'text/plain' } })).toBe(false);
      expect(validate({ ...resolved, path: undefined })).toBe(false);
      expect(validate({ ...resolved, path: '' })).toBe(false);
      for (const type of [prepared.type, resolved.type]) {
        expect(
          validate({
            type,
            sessionId: scope.sessionId,
            success: false,
            error: 'source_unavailable',
          })
        ).toBe(true);
      }
    }
  });

  it('accepts a selected authentication method only on start in both validators', () => {
    const base = {
      type: 'machine/acp-authenticate',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      requestId: 'request-1',
    };
    const start = { ...base, action: 'start', configId: 'config-1' };
    const controls = [
      { ...base, action: 'cancel', authenticationRequestId: 'auth-1' },
      {
        ...base,
        action: 'submit-code',
        authenticationRequestId: 'auth-1',
        authorizationCode: 'synthetic-code',
      },
      {
        ...base,
        action: 'submit-input',
        authenticationRequestId: 'auth-1',
        interactionId: 'interaction-1',
        authenticationInput: JSON.stringify({ action: 'accept' }),
      },
    ];
    for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
      expect(validate(start)).toBe(true);
      expect(validate({ ...start, methodId: 'sorbet:opencode-go:api_key' })).toBe(true);
      for (const methodId of ['', ' ', 'x'.repeat(1025), 1, null]) {
        expect(validate({ ...start, methodId })).toBe(false);
      }
      for (const control of controls) {
        expect(validate(control)).toBe(true);
        expect(validate({ ...control, methodId: 'sorbet:opencode-go:api_key' })).toBe(false);
      }
    }
  });

  it('transports local DSH Provider discovery without workspace or launch inputs', () => {
    const request = { type: 'machine/dsh-providers', machineId: 'machine-1' };
    const response = {
      type: 'machine/dsh-providers_response',
      providers: [{ id: 'provider-1', name: 'DSH' }],
    };
    for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
      expect(validate(request)).toBe(true);
      expect(validate({ ...request, command: 'arbitrary' })).toBe(false);
    }
    for (const validate of [isLocalSessionControlResponse, isLocalSessionControlResponseCjs]) {
      expect(validate(response)).toBe(true);
      expect(validate({ ...response, providers: [{ id: 1 }] })).toBe(false);
    }
  });

  it('accepts builtin Sorbet sessions in TS and CJS validators', () => {
    const request = {
      type: 'session/create',
      sessionId: 'session-builtin',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'builtin',
        agentType: 'sorbet',
        prompt: 'hello',
      },
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };
    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
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
});

it('carries a model-reading refresh and its progress through both local validators', () => {
  const request = {
    type: 'machine/acp-capabilities-refresh' as const,
    machineId: 'machine-1',
    workspaceId: 'workspace-1',
    configId: 'config-1',
    force: true,
    readModelOptions: true,
  };
  const progress = {
    type: 'machine/acp-binary-progress' as const,
    machineId: 'machine-1',
    agentType: 'dimcode',
    status: 'reading-model-options',
    configId: 'config-1',
    modelId: 'deepseek-flash',
    modelName: 'DeepSeek Flash',
    modelIndex: 2,
    modelCount: 40,
  };
  for (const [isRequest, isResponse] of [
    [isLocalSessionControlRequest, isLocalSessionControlResponse],
    [isLocalSessionControlRequestCjs, isLocalSessionControlResponseCjs],
  ] as const) {
    expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, readModelOptions: false })).toBe(false);
    expect(isResponse(progress)).toBe(true);
    expect(isResponse({ ...progress, modelIndex: 0 })).toBe(false);
  }
});

it('routes Provider quota refresh by persisted config only in both local validators', () => {
  const request = {
    type: 'machine/provider-rate-limits-refresh',
    machineId: 'm',
    workspaceId: 'w',
    configId: 'c',
  };
  for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, configId: '' })).toBe(false);
    expect(validate({ ...request, env: { KEY: 'synthetic' } })).toBe(false);
    expect(validate({ ...request, customAcp: { command: 'example' } })).toBe(false);
  }
  for (const validate of [isLocalSessionControlResponse, isLocalSessionControlResponseCjs]) {
    expect(
      validate({
        type: 'machine/provider-rate-limits-refresh_response',
        machineId: 'm',
        configId: 'c',
        success: true,
      })
    ).toBe(true);
    expect(
      validate({
        type: 'machine/provider-rate-limits-refresh_response',
        machineId: 'm',
        configId: 'c',
        success: 'yes',
      })
    ).toBe(false);
  }
});

it('carries local-only attachment preparation through both native validators', () => {
  const attachment = {
    type: 'local_attachment',
    machineId: 'machine',
    path: '/tmp/image.png',
    kind: 'image',
    fileName: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 4,
  };
  const scope = { machineId: 'machine', workspaceId: 'workspace', sessionId: 'session' };
  for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
    expect(
      validate({
        ...scope,
        type: 'session/attachment-prepare',
        path: '/tmp/image.png',
        kind: 'image',
        fileName: 'image.png',
        mimeType: 'image/png',
      })
    ).toBe(true);
  }
  for (const validate of [isLocalSessionControlResponse, isLocalSessionControlResponseCjs]) {
    expect(
      validate({
        type: 'session/attachment-prepare_response',
        sessionId: 'session',
        success: true,
        attachment,
      })
    ).toBe(true);
    expect(
      validate({ type: 'session/attachment-prepare_response', sessionId: 'session', success: true })
    ).toBe(false);
  }
});
