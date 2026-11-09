/** Decide locality before asking for authentication or reading attachment bytes. */
export function resolveAttachmentRoute(args: {
  native: boolean;
  localMachineId: string | null;
  targetMachineId: string | null;
}): 'local' | 'transfer' {
  if (!args.targetMachineId) throw new Error('Attachment execution target is unavailable');
  return args.native && args.targetMachineId === args.localMachineId ? 'local' : 'transfer';
}
