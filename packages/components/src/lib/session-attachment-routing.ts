/** Decide locality before asking for authentication or reading attachment bytes. */
export function resolveAttachmentRoute(args: {
  native: boolean;
  localMachineId: string | null;
  targetMachineId: string | null;
}): 'local' | 'transfer' {
  if (!args.targetMachineId) throw new Error('Attachment execution target is unavailable');
  if (!args.native) return 'transfer';
  if (!args.localMachineId) throw new Error('Local execution identity is not ready');
  return args.targetMachineId === args.localMachineId ? 'local' : 'transfer';
}
