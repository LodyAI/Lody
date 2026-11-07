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
import { ACP_INPUT_OUTCOME_UNKNOWN } from '../providers/acp-interaction-client';

export class AcpInputOutcomeUnknownError extends Error {}

export type MachineAcpAuthenticationArgs = {
  machineId: MachineId;
  configId: AgentConfigId;
  /**
   * Sign-in method the reader picked from the agent's advertised list. Sent only
   * to Machines that understand it; elsewhere the daemon shows its own picker.
   */
  methodId?: string;
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
  finish?: (response: MachineAcpAuthenticateResponse) => void;
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
      const requestId = crypto.randomUUID();
      const response = runtime.waitForMachineAcpAuthenticateResponse(args.machineId, requestId, {
        timeoutMs: 10000,
      });
      void response
        .then((result) => {
          if (
            result?.success &&
            (result.disposition === 'cancelled' || result.disposition === 'not-running')
          ) {
            activeAuthenticationsRef.current
              .get(args.authenticationRequestId)
              ?.finish?.({
                ...result,
                requestId: args.authenticationRequestId,
                disposition: 'cancelled',
              });
          }
        })
        .catch(() => {
          /* Cancellation remains unconfirmed; retain the original owner. */
        });
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        machineId: args.machineId,
        workspaceId,
        requestId,
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
        let finish!: (response: MachineAcpAuthenticateResponse) => void;
        const cancelled = new Promise<MachineAcpAuthenticateResponse>((resolve) => {
          finish = resolve;
        });
        const activeAuthentication: ActiveMachineAcpAuthentication = {
          machineId: args.machineId,
          authenticationRequestId: requestId,
          finish,
        };
        activeAuthenticationsRef.current.set(requestId, activeAuthentication);
        const unsubscribe = args.onProgress
          ? runtime.subscribeMachineAcpAuthenticationProgress(
              args.machineId,
              requestId,
              (message) => {
                if (activeAuthenticationsRef.current.get(requestId) === activeAuthentication)
                  args.onProgress?.(message);
              }
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
            ...(args.methodId ? { methodId: args.methodId } : {}),
          });
          const response = await Promise.race([responsePromise, cancelled]);
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
      if (
        !response ||
        response.error === ACP_INPUT_OUTCOME_UNKNOWN ||
        response.disposition === 'not-running'
      ) {
        throw new AcpInputOutcomeUnknownError(
          t(
            'agents.authentication.inputOutcomeUnknown',
            'The response may have been received. Wait for sign-in to finish or cancel and start again.'
          )
        );
      }
      if (!response.success || response.disposition !== 'input-accepted') {
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
      if (
        !response ||
        response.error === ACP_INPUT_OUTCOME_UNKNOWN ||
        response.disposition === 'not-running'
      ) {
        throw new AcpInputOutcomeUnknownError(
          t(
            'agents.authentication.inputOutcomeUnknown',
            'The response may have been received. Wait for sign-in to finish or cancel and start again.'
          )
        );
      }
      if (!response.success || response.disposition !== 'input-accepted') {
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
