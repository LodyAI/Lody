import { useCallback } from 'react';
import type { AgentConfigId, MachineId, WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { resyncMachineFlockRows } from './use-machine-flock-rows';
import { useMachineAcpAuthentication } from './use-machine-acp-authentication';

export type CodexProviderCredentialProvisionResult = {
  publicationDurability: 'durable' | 'uncertain';
};

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
      setupRevision: string;
      apiKey: string;
    }): Promise<CodexProviderCredentialProvisionResult> => {
      let inputSubmitted = false;
      let rejectInput: (error: unknown) => void = () => {};
      const inputFailure = new Promise<never>((_resolve, reject) => {
        rejectInput = reject;
      });
      const authentication = startAuthentication({
        machineId: args.machineId,
        configId: args.configId,
        purpose: 'provision-provider-credential',
        setupRevision: args.setupRevision,
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
      if (response.disposition !== 'authenticated') {
        throw new Error(response.error ?? 'Codex credential verification failed');
      }
      const publicationDurability = response.publicationDurability ?? 'durable';
      if (publicationDurability === 'uncertain') {
        await resyncMachineFlockRows(runtime, args.machineId);
      }
      return { publicationDurability };
    },
    [cancelAuthentication, runtime, startAuthentication, submitAuthenticationInput]
  );
}
