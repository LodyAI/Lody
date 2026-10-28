import {
  LocalMachineRpcRequestSchema,
  LocalMachineRpcResponseSchema,
  type LocalMachineRpcRequest,
  type LocalMachineRpcResponse,
} from '@lody/shared/local-machine-rpc';
import { CodeCollabV2RpcContentEnvelopeSchema } from '@lody/shared';
import { isE2eeReadQuery, type E2eeQueryResult } from '@lody/shared/e2ee-rpc';
import {
  isOwnerScopedEncryptedRpcMethod,
  decryptCodeCollabV2RpcPayload,
  encryptCodeCollabV2RpcPayload,
} from './rpc';

/** Adapt the ordinary method client's in-process owner envelope to the one
 * shared encrypted feature DTO. These envelopes are not a second wire format. */
export async function callEncryptedReadFeature(options: {
  workspaceId: string;
  machineId: string;
  method: string;
  params: unknown;
  timeoutMs: number;
  request: (request: LocalMachineRpcRequest) => Promise<LocalMachineRpcResponse>;
}): Promise<E2eeQueryResult> {
  if (!isE2eeReadQuery(options.method, options.params)) throw new Error('e2ee_query_method');
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
    timeoutMs: Math.min(options.timeoutMs, 60_000),
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
