import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentConfigId,
  MachineAcpAuthenticateResponse,
  MachineAcpAuthenticationProgressMessage,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

export type MachineAcpAuthenticationArgs = {
  machineId: MachineId;
  configId: AgentConfigId;
  onProgress?: (message: MachineAcpAuthenticationProgressMessage) => void;
};

export type MachineAcpAuthenticationCodeArgs = {
  machineId: MachineId;
  authenticationRequestId: string;
  authorizationCode: string;
};

export type MachineAcpAuthenticationInputArgs = {
  machineId: MachineId;
  authenticationRequestId: string;
  interactionId: string;
  input: {
    action: 'accept' | 'decline' | 'cancel';
    methodId?: string;
    content?: Record<string, unknown>;
  };
};

type ActiveMachineAcpAuthentication = {
  machineId: MachineId;
  authenticationRequestId: string;
};

export function useMachineAcpAuthentication(
  runtime: WorkspaceRuntime | null,
  workspaceId: WorkspaceId | null
) {
  const { t } = useTranslation();
  const activeAuthenticationsRef = useRef(new Map<string, ActiveMachineAcpAuthentication>());

  const cancelAuthentication = useCallback(
    (args: ActiveMachineAcpAuthentication): void => {
      if (!runtime || workspaceId == null) return;
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        machineId: args.machineId,
        workspaceId,
        requestId: crypto.randomUUID(),
        action: 'cancel',
        authenticationRequestId: args.authenticationRequestId,
      });
    },
    [runtime, workspaceId]
  );

  useEffect(
    () => () => {
      const activeAuthentications = [...activeAuthenticationsRef.current.values()];
      activeAuthenticationsRef.current.clear();
      for (const authentication of activeAuthentications) {
        try {
          cancelAuthentication(authentication);
        } catch {
          // The runtime may already be disposed while the panel unmounts.
        }
      }
    },
    [cancelAuthentication]
  );

  const startAuthentication = useCallback(
    (args: MachineAcpAuthenticationArgs) => {
      const requestId = crypto.randomUUID();
      const promise = (async (): Promise<MachineAcpAuthenticateResponse> => {
        if (!runtime || workspaceId == null) {
          throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
        }
        const activeAuthentication: ActiveMachineAcpAuthentication = {
          machineId: args.machineId,
          authenticationRequestId: requestId,
        };
        activeAuthenticationsRef.current.set(requestId, activeAuthentication);
        const unsubscribe = args.onProgress
          ? runtime.subscribeMachineAcpAuthenticationProgress(
              args.machineId,
              requestId,
              args.onProgress
            )
          : undefined;
        const responsePromise = runtime.waitForMachineAcpAuthenticateResponse(
          args.machineId,
          requestId,
          { timeoutMs: 300000 }
        );
        try {
          runtime.sendControl({
            type: 'machine/acp-authenticate',
            machineId: args.machineId,
            workspaceId,
            requestId,
            action: 'start',
            configId: args.configId,
          });
          const response = await responsePromise;
          if (!response) {
            throw new Error(
              t('agents.authentication.timeout', 'Authentication timed out. Please try again.')
            );
          }
          if (!response.success) {
            const errorMessage =
              typeof response.error === 'string' && response.error.length > 0
                ? response.error
                : t('agents.authentication.failed', 'Authentication failed');
            throw new Error(errorMessage);
          }
          if (response.disposition === 'not-running') {
            throw new Error(t('agents.authentication.failed', 'Authentication failed'));
          }
          if (response.disposition === 'method-required' && !response.authMethods?.length) {
            throw new Error(
              t('agents.authentication.noMethods', 'This agent did not advertise a sign-in method.')
            );
          }
          return response;
        } catch (error) {
          // A response timeout only clears the renderer-side waiter. Explicitly
          // cancel so the CLI releases its per-agent login slot before Retry.
          try {
            cancelAuthentication(activeAuthentication);
          } catch {
            // Preserve the original timeout/response error if the runtime was
            // disposed while sending the best-effort cancellation.
          }
          throw error;
        } finally {
          activeAuthenticationsRef.current.delete(requestId);
          unsubscribe?.();
        }
      })();
      return { requestId, promise };
    },
    [cancelAuthentication, runtime, t, workspaceId]
  );

  const submitAuthorizationCode = useCallback(
    async (args: MachineAcpAuthenticationCodeArgs): Promise<void> => {
      if (!runtime || workspaceId == null) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      const requestId = crypto.randomUUID();
      const responsePromise = runtime.waitForMachineAcpAuthenticateResponse(
        args.machineId,
        requestId,
        { timeoutMs: 10000 }
      );
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        machineId: args.machineId,
        workspaceId,
        requestId,
        action: 'submit-code',
        authenticationRequestId: args.authenticationRequestId,
        authorizationCode: args.authorizationCode,
      });
      const response = await responsePromise;
      if (!response || !response.success || response.disposition !== 'input-accepted') {
        throw new Error(
          response?.error ??
            t(
              'agents.authentication.codeSubmitFailed',
              'Could not submit the authorization code. Please try again.'
            )
        );
      }
    },
    [runtime, t, workspaceId]
  );

  const submitAuthenticationInput = useCallback(
    async (args: MachineAcpAuthenticationInputArgs): Promise<void> => {
      if (!runtime || workspaceId == null) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      const requestId = crypto.randomUUID();
      const responsePromise = runtime.waitForMachineAcpAuthenticateResponse(
        args.machineId,
        requestId,
        { timeoutMs: 10000 }
      );
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        machineId: args.machineId,
        workspaceId,
        requestId,
        action: 'submit-input',
        authenticationRequestId: args.authenticationRequestId,
        interactionId: args.interactionId,
        authenticationInput: JSON.stringify(args.input),
      });
      const response = await responsePromise;
      if (!response || !response.success || response.disposition !== 'input-accepted') {
        throw new Error(
          response?.error ??
            t(
              'agents.authentication.inputSubmitFailed',
              'Could not submit the authentication response. Please try again.'
            )
        );
      }
    },
    [runtime, t, workspaceId]
  );

  return {
    startAuthentication,
    cancelAuthentication,
    submitAuthorizationCode,
    submitAuthenticationInput,
  };
}
