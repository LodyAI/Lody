/** Exact ledger UTF-8 bytes encoded with canonical, unpadded RFC 4648 base64url. */
export function e2eeRpcResource(machineId: string): string {
  if (typeof machineId !== 'string') throw new Error('e2ee_rpc_machine_id');
  const bytes = new TextEncoder().encode(machineId);
  if (
    typeof machineId !== 'string' ||
    bytes.length < 1 ||
    bytes.length > 256 ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== machineId
  )
    throw new Error('e2ee_rpc_machine_id');
  return `rpc:${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
}

/** Dedicated encrypted request stream; the name supplies routing, never authority. */
export const e2eeRpcRequestStream = (workspaceId: string, machineId: string) =>
  `${workspaceId}:e2ee-rpc:req:${e2eeRpcResource(machineId).slice(4)}`;

/** One shared response stream per workspace signing device, never a subscription per call. */
export function e2eeRpcResponseStream(workspaceId: string, requesterDevice: string): string {
  if (!/^[0-9a-f]{64}$/.test(requesterDevice)) throw new Error('e2ee_rpc_signer');
  return `${workspaceId}:e2ee-rpc:res:${requesterDevice}`;
}
