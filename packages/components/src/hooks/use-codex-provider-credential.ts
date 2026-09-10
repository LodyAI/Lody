import { useCallback } from 'react';
import type { AgentConfigId, MachineId, WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { useMachineAcpAuthentication } from './use-machine-acp-authentication';

export function useCodexProviderCredential(
  runtime: WorkspaceRuntime | null,
  workspaceId: WorkspaceId | null
) {
  const { startAuthentication, submitAuthenticationInput, cancelAuthentication } =
    useMachineAcpAuthentication(runtime, workspaceId);

  return useCallback(
    async (args: {
      machineId: MachineId;
      configId: AgentConfigId;
      credentialRevision: string;
      apiKey: string;
    }): Promise<void> => {
      let inputSubmitted = false;
      let rejectInput: (error: unknown) => void = () => {};
      const inputFailure = new Promise<never>((_resolve, reject) => {
        rejectInput = reject;
      });
      const authentication = startAuthentication({
        machineId: args.machineId,
        configId: args.configId,
        purpose: 'provision-provider-credential',
        credentialRevision: args.credentialRevision,
        onProgress: (progress) => {
          if (
            progress.status !== 'input-required' ||
            !progress.interactionId ||
            inputSubmitted ||
            !progress.form?.fields.some((field) => field.id === 'apiKey' && field.type === 'secret')
          ) {
            return;
          }
          inputSubmitted = true;
          void submitAuthenticationInput({
            machineId: args.machineId,
            authenticationRequestId: progress.requestId,
            interactionId: progress.interactionId,
            input: { action: 'accept', content: { apiKey: args.apiKey } },
          }).catch((error: unknown) => {
            cancelAuthentication({
              machineId: args.machineId,
              authenticationRequestId: progress.requestId,
            });
            rejectInput(error);
          });
        },
      });
      const response = await Promise.race([authentication.promise, inputFailure]);
      if (response.disposition !== 'authenticated' || response.capabilitiesRefreshed !== true) {
        throw new Error(response.error ?? 'Codex credential verification failed');
      }
    },
    [cancelAuthentication, startAuthentication, submitAuthenticationInput]
  );
}
