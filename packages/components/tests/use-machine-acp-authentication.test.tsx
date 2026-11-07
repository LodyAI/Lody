// @vitest-environment jsdom

// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId, WorkspaceId } from '@lody/shared';

import type { WorkspaceRuntime } from '../src/atoms/runtime';
import {
  AcpInputOutcomeUnknownError,
  useMachineAcpAuthentication,
} from '../src/hooks/use-machine-acp-authentication';

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

  it.each(['not-running', 'cancelled'] as const)(
    'finishes a silently dropped start after cancel returns %s and fences late progress',
    async (disposition) => {
      let resolveStart!: (value: any) => void;
      let progress!: (value: any) => void;
      const onProgress = vi.fn();
      const runtime = {
        sendControl: vi.fn(),
        subscribeMachineAcpAuthenticationProgress: vi.fn((_machine, _request, listener) => {
          progress = listener;
          return () => {};
        }),
        waitForMachineAcpAuthenticateResponse: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveStart = resolve;
              })
          )
          .mockResolvedValueOnce({ success: true, disposition })
          .mockResolvedValueOnce({ success: true, disposition: 'authenticated' }),
      } as unknown as WorkspaceRuntime;
      let controller!: AuthenticationController;
      await act(async () => {
        root?.render(
          createElement(Probe, {
            runtime,
            workspaceId: 'workspace-1' as WorkspaceId,
            onResult: (value) => {
              controller = value;
            },
          })
        );
      });
      const args = { machineId: 'machine-1' as MachineId, configId: 'config-1' as AgentConfigId };
      const original = controller.startAuthentication({ ...args, onProgress });
      controller.cancelAuthentication({
        machineId: args.machineId,
        authenticationRequestId: original.requestId,
      });
      await expect(original.promise).resolves.toMatchObject({ disposition: 'cancelled' });
      progress({ status: 'authenticated' });
      expect(onProgress).not.toHaveBeenCalled();
      const retry = controller.startAuthentication(args);
      resolveStart({ success: true, disposition: 'authenticated' });
      await expect(retry.promise).resolves.toMatchObject({ disposition: 'authenticated' });
    }
  );

  it.each([null, { success: false, disposition: 'error', error: 'Rejected' }])(
    'retains the original owner when cancellation is unconfirmed (%j)',
    async (cancelResponse) => {
      let resolveStart!: (value: any) => void;
      let resolveCancel!: (value: any) => void;
      let controller!: AuthenticationController;
      const runtime = {
        sendControl: vi.fn(),
        waitForMachineAcpAuthenticateResponse: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveStart = resolve;
              })
          )
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveCancel = resolve;
              })
          ),
      } as unknown as WorkspaceRuntime;
      await act(async () => {
        root?.render(
          createElement(Probe, {
            runtime,
            workspaceId: 'workspace-1' as WorkspaceId,
            onResult: (value) => {
              controller = value;
            },
          })
        );
      });
      const machineId = 'machine-1' as MachineId;
      const attempt = controller.startAuthentication({
        machineId,
        configId: 'config-1' as AgentConfigId,
      });
      let settled = false;
      void attempt.promise.then(() => {
        settled = true;
      });
      controller.cancelAuthentication({ machineId, authenticationRequestId: attempt.requestId });
      await act(async () => {
        resolveCancel(cancelResponse);
      });
      expect(settled).toBe(false);
      resolveStart({ success: true, disposition: 'authenticated' });
      await expect(attempt.promise).resolves.toMatchObject({ disposition: 'authenticated' });
    }
  );

  it('reports a lost submit response as unknown rather than safe to retry', async () => {
    const runtime = {
      sendControl: vi.fn(),
      waitForMachineAcpAuthenticateResponse: vi.fn(async () => null),
    } as unknown as WorkspaceRuntime;
    let controller: AuthenticationController | undefined;
    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId: 'workspace-1' as WorkspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });
    await expect(
      controller!.submitAuthorizationCode({
        machineId: 'machine-1' as MachineId,
        authenticationRequestId: 'request',
        authorizationCode: 'synthetic',
      })
    ).rejects.toBeInstanceOf(AcpInputOutcomeUnknownError);
    await expect(
      controller!.submitAuthenticationInput({
        machineId: 'machine-1' as MachineId,
        authenticationRequestId: 'request',
        interactionId: 'question',
        input: { action: 'accept' },
      })
    ).rejects.toBeInstanceOf(AcpInputOutcomeUnknownError);
  });

  it('does not report a finished authentication as a failed submission', async () => {
    const runtime = {
      sendControl: vi.fn(),
      waitForMachineAcpAuthenticateResponse: vi.fn(async () => ({
        success: true,
        disposition: 'not-running',
      })),
    } as unknown as WorkspaceRuntime;
    let controller: AuthenticationController | undefined;
    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId: 'workspace-1' as WorkspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });
    await expect(
      controller!.submitAuthenticationInput({
        machineId: 'machine-1' as MachineId,
        authenticationRequestId: 'request',
        interactionId: 'question',
        input: { action: 'accept' },
      })
    ).rejects.toBeInstanceOf(AcpInputOutcomeUnknownError);
  });

  it('preserves a confirmed submit rejection', async () => {
    const runtime = {
      sendControl: vi.fn(),
      waitForMachineAcpAuthenticateResponse: vi.fn(async () => ({
        success: false,
        disposition: 'error',
        error: 'Rejected by machine',
      })),
    } as unknown as WorkspaceRuntime;
    let controller: AuthenticationController | undefined;
    await act(async () => {
      root?.render(
        createElement(Probe, {
          runtime,
          workspaceId: 'workspace-1' as WorkspaceId,
          onResult: (value) => {
            controller = value;
          },
        })
      );
    });
    await expect(
      controller!.submitAuthorizationCode({
        machineId: 'machine-1' as MachineId,
        authenticationRequestId: 'request',
        authorizationCode: 'synthetic',
      })
    ).rejects.toThrow('Rejected by machine');
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
      configId: 'config-kimi' as AgentConfigId,
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
      action: 'cancel',
      authenticationRequestId: attempt.requestId,
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
      configId: 'config-kimi' as AgentConfigId,
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
      configId: 'config-kimi' as AgentConfigId,
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
});
