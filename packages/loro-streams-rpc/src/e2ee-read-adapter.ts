import {
  LocalMachineRpcRequestSchema,
  LocalMachineRpcResponseSchema,
  type LocalMachineRpcRequest,
  type LocalMachineRpcResponse,
} from '@lody/shared/local-machine-rpc';
import { CodeCollabV2RpcContentEnvelopeSchema } from '@lody/shared';
import { z } from 'zod';
import {
  isE2eeReadQuery,
  isE2eeRemoteControlMethod,
  type E2eeQueryResult,
} from '@lody/shared/e2ee-rpc';
import {
  isOwnerScopedEncryptedRpcMethod,
  decryptCodeCollabV2RpcPayload,
  encryptCodeCollabV2RpcPayload,
} from './rpc';

export const isEncryptedMachineClientMethod = (method: string, params: unknown): boolean =>
  isE2eeReadQuery(method, params) || isE2eeRemoteControlMethod(method);

/** Adapt the ordinary method client's in-process owner envelope to the one
 * shared encrypted feature DTO. These envelopes are not a second wire format. */
export async function callEncryptedReadFeature(options: {
  workspaceId: string;
  machineId: string;
  method: string;
  params: unknown;
  timeoutMs: number;
  request: (request: LocalMachineRpcRequest) => Promise<LocalMachineRpcResponse>;
  /** Whether the target advertised `e2eeRemoteControl`; refused before signing if not. */
  supportsRemoteControl: () => Promise<boolean>;
}): Promise<E2eeQueryResult> {
  if (!isEncryptedMachineClientMethod(options.method, options.params))
    throw new Error('e2ee_query_method');
  if (isE2eeRemoteControlMethod(options.method) && !(await options.supportsRemoteControl())) {
    const steer =
      options.method === 'session/steer'
        ? z
            .object({ sessionId: z.string(), userTurnId: z.string() })
            .safeParse(options.params)
        : undefined;
    return steer?.success
      ? {
          result: {
            type: 'session/steer_response',
            ...steer.data,
            applied: false,
            disposition: 'unsupported',
            error: 'This machine cannot receive an encrypted steer.',
          },
        }
      : {
          error: {
            code: 'e2ee_machine_update_required',
            message: 'Update Lody on the target machine to control it in an encrypted workspace.',
          },
        };
  }
  const read = isE2eeReadQuery(options.method, options.params);
  let owner: string | undefined;
  let params = options.params;
  if (isOwnerScopedEncryptedRpcMethod(options.method)) {
    const envelope = CodeCollabV2RpcContentEnvelopeSchema.parse(params);
    owner = envelope.ownerSessionId;
    params = await decryptCodeCollabV2RpcPayload(envelope, owner);
  }
  const request = LocalMachineRpcRequestSchema.parse({
    workspaceId: options.workspaceId,
    machineId: options.machineId,
    method: options.method,
    params,
    timeoutMs: Math.min(options.timeoutMs, read ? 60_000 : 840_000),
    ...(owner ? { ownerSessionId: owner } : {}),
  });
  const response = LocalMachineRpcResponseSchema.parse(await options.request(request));
  if (!response.ok)
    return {
      error: {
        code: response.code ?? 'e2ee_query_failed',
        message: response.error,
        ...(response.data === undefined
          ? {}
          : {
              data: owner
                ? await encryptCodeCollabV2RpcPayload(owner, response.data)
                : response.data,
            }),
      },
    };
  return {
    result: owner ? await encryptCodeCollabV2RpcPayload(owner, response.result) : response.result,
  };
}
