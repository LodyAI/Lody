import type { MachineId, MachineMeta, SessionInputBlock } from '@lody/shared';

/** Older strict image schemas reject these fields even after cloud publication. */
export async function validateExtendedImageTarget(args: {
  blocks: readonly SessionInputBlock[];
  targetMachineId: string | null | undefined;
  readMachine(machineId: MachineId): Promise<MachineMeta | undefined>;
}): Promise<void> {
  const extended = args.blocks.some(
    (block) =>
      block.type === 'image' &&
      (block.transport !== undefined ||
        block.machineId !== undefined ||
        block.localImageId !== undefined)
  );
  if (!extended) return;
  const machine = args.targetMachineId
    ? await args.readMachine(args.targetMachineId as MachineId)
    : undefined;
  if (machine?.protocolCapabilities?.localImages !== 1)
    throw new Error('Update the target daemon to send images with local identity');
}

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
