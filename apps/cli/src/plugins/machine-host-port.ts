import type { ChildToHostFrame, HostToChildFrame } from '@lody/shared/plugins/ipc-protocol';
type Request = Extract<ChildToHostFrame, { type: 'host_call' }>;
export type MachineHostOrigin =
  | { type: 'start' }
  | { type: 'service' }
  | { type: 'uninstall' }
  | { type: 'event'; frame: Omit<Extract<HostToChildFrame, { type: 'event' }>, 'contextId'> }
  | {
      type: 'invoke';
      execute?: DispatchMachineHostCall;
      frame: Extract<HostToChildFrame, { type: 'invoke' }>;
    };
export interface MachineHostCall {
  pluginId: string;
  workspaceId: string;
  machineId: string;
  instanceId: number;
  origin: MachineHostOrigin;
  op: Request['op'];
  payload: Request['payload'];
}
/** The executor validates capability, target and active authorization at the write boundary. */
export type DispatchMachineHostCall = (
  call: MachineHostCall,
  signal: AbortSignal
) => Promise<unknown>;

/** An interactive RPC signer authorizes invocation, not new machine-signed inputs. */
export function encryptedPluginDispatch(
  dispatch: DispatchMachineHostCall
): DispatchMachineHostCall {
  return async (call, signal) => {
    if (
      call.origin.type === 'invoke' &&
      call.origin.frame.kind !== 'tool' &&
      call.op === 'lody.execute' &&
      [
        'sessionCreate',
        'sessionSend',
        'sessionRespondInteraction',
        'sessionStop',
        'sessionArchive',
        'sessionFork',
      ].includes(call.payload.descriptorId ?? '')
    )
      throw Object.assign(
        new Error('Unrooted plugin invocation cannot originate encrypted inputs'),
        { code: 'forbidden' }
      );
    return dispatch(call, signal);
  };
}
