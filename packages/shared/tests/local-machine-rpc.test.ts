import { describe, expect, it } from 'vitest';
import {
  LocalMachineRpcResponseSchema,
  LocalMachineRpcRequestSchema,
  safeParseLocalMachineRpcRequest,
} from '../src/local-machine-rpc';

describe('local Machine RPC', () => {
  it('retains selected roots across file RPC parsing and defaults legacy requests to main at dispatch', () => {
    for (const [method, params] of [
      ['code-collab/get-file-index', { sessionId: 's' }],
      ['code-collab/open-text', { sessionId: 's', path: 'a.txt' }],
      ['code-collab/lsp-definition', { sessionId: 's', path: 'a.txt' }],
      ['code-collab/lsp-references', { sessionId: 's', path: 'a.txt' }],
      ['file/preview', { v: 3, sessionId: 's', path: 'a.txt' }],
    ] as const) {
      const request = { machineId: 'm', workspaceId: 'w', method, params };
      expect(LocalMachineRpcRequestSchema.parse(request)).toEqual(request);
      const rooted = { ...request, params: { ...params, rootId: 'member:docs' } };
      expect(LocalMachineRpcRequestSchema.parse(rooted)).toEqual(rooted);
      expect(
        LocalMachineRpcRequestSchema.safeParse({
          ...request,
          params: { ...params, rootId: '../host' },
        }).success
      ).toBe(false);
    }
  });

  it('accepts a registered local member reference and validates the path-free probe result', () => {
    const request = {
      machineId: 'm',
      workspaceId: 'w',
      method: 'project/probe-local-member',
      params: { localProjectId: 'local' },
    };
    expect(LocalMachineRpcRequestSchema.parse(request)).toEqual(request);
    expect(
      LocalMachineRpcRequestSchema.safeParse({
        ...request,
        params: { ...request.params, rootPath: '/host' },
      }).success
    ).toBe(false);
    const response = {
      ok: true,
      result: {
        type: 'project/probe-local-member',
        repoFullName: 'acme/api',
        isGit: true,
        submodules: [{ path: 'proto', url: '../proto.git', repoFullName: 'acme/proto' }],
      },
    };
    expect(LocalMachineRpcResponseSchema.parse(response)).toEqual(response);
    expect(
      LocalMachineRpcResponseSchema.safeParse({
        ok: true,
        result: { ...response.result, rootPath: '/host' },
      }).success
    ).toBe(false);
  });
  it('allows Pi discovery by saved config reference but never caller launch inputs', () => {
    const request = {
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      method: 'machine/pi-extensions',
      params: { configId: 'pi-config' },
    };
    expect(safeParseLocalMachineRpcRequest(JSON.stringify(request)).success).toBe(true);
    for (const fields of [
      { command: 'pi' },
      { env: { NODE_OPTIONS: '--require untrusted' } },
      { path: '/untrusted' },
    ]) {
      expect(
        safeParseLocalMachineRpcRequest(
          JSON.stringify({ ...request, params: { ...request.params, ...fields } })
        ).success
      ).toBe(false);
    }
    const response = {
      ok: true,
      result: {
        success: true,
        discovery: { version: 1, agentDir: '/fixture', extensions: [], warnings: [] },
      },
    };
    expect(LocalMachineRpcResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects draft content and environment variables in session preparation', () => {
    const result = safeParseLocalMachineRpcRequest(
      JSON.stringify({
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method: 'session/prepare',
        params: {
          preparationId: 'prepare-1',
          sessionId: 'session-1',
          requestedByUserId: 'user-1',
          agentConfigId: 'config-1',
          cliType: 'builtin',
          agentType: 'codex',
          prompt: 'private draft',
          env: { API_KEY: 'secret' },
        },
      })
    );

    expect(result.success).toBe(false);
  });

  it('drops sensitive ACP option values from session preparation', () => {
    const result = safeParseLocalMachineRpcRequest(
      JSON.stringify({
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method: 'session/prepare',
        params: {
          preparationId: 'prepare-1',
          sessionId: 'session-1',
          requestedByUserId: 'user-1',
          agentConfigId: 'config-1',
          cliType: 'builtin',
          agentType: 'codex',
          runConfig: {
            configOptionValues: {
              effort: 'high',
              api_key: 'private',
              authToken: 'private',
            },
          },
        },
      })
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        params: {
          runConfig: {
            configOptionValues: {
              effort: 'high',
            },
          },
        },
      },
    });
  });
});

it('accepts typed memory operations and rejects caller-provided commands', () => {
  const request = {
    machineId: 'machine',
    workspaceId: 'workspace',
    method: 'machine/memory',
    params: {
      action: 'create',
      providerId: 'nowledge-mem',
      input: { id: 'reviewer', name: 'Reviewer' },
    },
  };
  expect(LocalMachineRpcRequestSchema.safeParse(request).success).toBe(true);
  expect(
    LocalMachineRpcRequestSchema.safeParse({
      ...request,
      params: { ...request.params, command: 'other' },
    }).success
  ).toBe(false);
});
