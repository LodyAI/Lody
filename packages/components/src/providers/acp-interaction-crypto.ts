import { createRpcSecretRecipient, encryptRpcSecret } from '@lody/loro-streams-rpc';
import { RpcSecretEnvelopeSchema, RpcSecretPublicKeySchema } from '@lody/shared';
import {
  e2eeAcpInteractionInputContext,
  e2eeAcpInteractionResponseContext,
} from '@lody/shared/e2ee-rpc';

/** Memory-only response key and target-key input sealing for one interaction. */
export async function createAcpInteractionCrypto() {
  const recipient = await createRpcSecretRecipient();
  return {
    responseRecipient: {
      publicKey: recipient.publicKey,
      async open(args: {
        workspaceId: string;
        machineId: string;
        requesterDevice: string;
        interactionRequestId: string;
        requestId: string;
        envelope: unknown;
      }): Promise<unknown> {
        const plaintext = await recipient.decrypt(
          RpcSecretEnvelopeSchema.parse(args.envelope),
          e2eeAcpInteractionResponseContext(args)
        );
        return JSON.parse(plaintext) as unknown;
      },
    },
    async sealInput(args: {
      workspaceId: string;
      machineId: string;
      requesterDevice: string;
      interactionRequestId: string;
      interactionId: string;
      publicKey: unknown;
      input: unknown;
    }) {
      const plaintext = JSON.stringify(args.input);
      if (plaintext === undefined) throw new Error('Invalid ACP interaction input');
      return encryptRpcSecret(
        RpcSecretPublicKeySchema.parse(args.publicKey),
        plaintext,
        e2eeAcpInteractionInputContext(args)
      );
    },
  };
}
