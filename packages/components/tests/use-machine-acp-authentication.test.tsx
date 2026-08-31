// @vitest-environment jsdom

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, WorkspaceId } from '@lody/shared';

import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { useMachineAcpAuthentication } from '../src/hooks/use-machine-acp-authentication';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type AuthenticationController = ReturnType<typeof useMachineAcpAuthentication>;

function Probe(props: {
  runtime: WorkspaceRuntime;
  workspaceId: WorkspaceId;
  onResult: (value: AuthenticationController) => void;
}) {
  props.onResult(useMachineAcpAuthentication(props.runtime, props.workspaceId));
  return null;
}

describe('useMachineAcpAuthentication', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it('cancels the CLI login when the response registry times out', async () => {
    const sendControl = vi.fn();
    const unsubscribe = vi.fn();
    const runtime = {
      sendControl,
      subscribeMachineAcpAuthenticationProgress: vi.fn(() => unsubscribe),
      waitForMachineAcpAuthenticateResponse: vi.fn(async () => null),
    } as unknown as WorkspaceRuntime;
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    let controller: AuthenticationController | undefined;

    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });

    const attempt = controller!.startAuthentication({
      machineId,
      cliType: 'builtin',
      agentType: 'kimi',
      onProgress: vi.fn(),
    });

    await expect(attempt.promise).rejects.toThrow('Authentication timed out');
    expect(sendControl).toHaveBeenCalledTimes(2);
    expect(sendControl.mock.calls[0]?.[0]).toMatchObject({
      type: 'machine/acp-authenticate',
      requestId: attempt.requestId,
      action: 'start',
    });
    expect(sendControl.mock.calls[1]?.[0]).toMatchObject({
      type: 'machine/acp-authenticate',
      requestId: attempt.requestId,
      action: 'cancel',
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('rejects a not-running start response instead of reporting authentication success', async () => {
    const sendControl = vi.fn();
    const runtime = {
      sendControl,
      subscribeMachineAcpAuthenticationProgress: vi.fn(),
      waitForMachineAcpAuthenticateResponse: vi.fn(async () => ({
        success: true,
        disposition: 'not-running' as const,
      })),
    } as unknown as WorkspaceRuntime;
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    let controller: AuthenticationController | undefined;

    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });

    const attempt = controller!.startAuthentication({
      machineId,
      cliType: 'builtin',
      agentType: 'kimi',
    });

    await expect(attempt.promise).rejects.toThrow('Authentication failed');
    expect(sendControl.mock.calls.map(([message]) => message.action)).toEqual(['start', 'cancel']);
  });

  it('cancels an active CLI login when the owning panel unmounts', async () => {
    let resolveResponse!: (response: {
      type: 'machine/acp-authenticate_response';
      machineId: MachineId;
      requestId: string;
      agentType: string;
      success: true;
      disposition: 'cancelled';
    }) => void;
    const responsePromise = new Promise<Parameters<typeof resolveResponse>[0]>((resolve) => {
      resolveResponse = resolve;
    });
    const sendControl = vi.fn();
    const runtime = {
      sendControl,
      subscribeMachineAcpAuthenticationProgress: vi.fn(),
      waitForMachineAcpAuthenticateResponse: vi.fn(() => responsePromise),
    } as unknown as WorkspaceRuntime;
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    let controller: AuthenticationController | undefined;

    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });

    const attempt = controller!.startAuthentication({
      machineId,
      cliType: 'builtin',
      agentType: 'kimi',
    });
    await act(async () => {
      root?.unmount();
      root = undefined;
    });

    expect(sendControl.mock.calls.map(([message]) => message.action)).toEqual(['start', 'cancel']);
    resolveResponse({
      type: 'machine/acp-authenticate_response',
      machineId,
      requestId: attempt.requestId,
      agentType: 'kimi',
      success: true,
      disposition: 'cancelled',
    });
    await expect(attempt.promise).resolves.toMatchObject({ disposition: 'cancelled' });
  });

  it('submits a browser authorization code to the active CLI login', async () => {
    const sendControl = vi.fn();
    const runtime = {
      sendControl,
      waitForMachineAcpAuthenticateResponse: vi.fn(async () => ({
        success: true,
        disposition: 'input-accepted' as const,
      })),
    } as unknown as WorkspaceRuntime;
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    let controller: AuthenticationController | undefined;

    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });

    await controller!.submitAuthorizationCode({
      machineId,
      cliType: 'builtin',
      agentType: 'claude',
      authenticationRequestId: 'auth-claude',
      authorizationCode: 'browser-code',
    });

    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'machine/acp-authenticate',
        action: 'submit-code',
        authenticationRequestId: 'auth-claude',
        authorizationCode: 'browser-code',
      })
    );
  });

  it('submits an ACP authentication form response to the active remote login', async () => {
    const sendControl = vi.fn();
    const runtime = {
      sendControl,
      waitForMachineAcpAuthenticateResponse: vi.fn(async () => ({
        success: true,
        disposition: 'input-accepted' as const,
      })),
    } as unknown as WorkspaceRuntime;
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    let controller: AuthenticationController | undefined;

    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });

    await controller!.submitAuthenticationInput({
      machineId,
      cliType: 'registry',
      agentType: 'custom-agent',
      authenticationRequestId: 'auth-custom',
      interactionId: 'form-1',
      input: { action: 'accept', content: { code: 'secret-code', account: 'work' } },
    });

    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'machine/acp-authenticate',
        action: 'submit-input',
        authenticationRequestId: 'auth-custom',
        interactionId: 'form-1',
        authenticationInput: JSON.stringify({
          action: 'accept',
          content: { code: 'secret-code', account: 'work' },
        }),
      })
    );
  });
});
