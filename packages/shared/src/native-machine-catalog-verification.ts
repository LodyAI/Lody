import { z } from 'zod';
import {
  parseMachineCatalogIpcCommand,
  MACHINE_CATALOG_COMMAND_MAX_BYTES,
} from './machine-catalog-ipc';
import { sha256Hex } from './incremental-sha256';
import type { AgentConfigMeta } from './schema';

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NATIVE_MACHINE_CATALOG_VERIFICATION_MAX_BYTES =
  MACHINE_CATALOG_COMMAND_MAX_BYTES + 8 * 1024;
const binding = z.object({ accountId: id, workspaceId: id, machineId: id }).strict();
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, field]) => field !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, field]) => [key, canonical(field)])
        )
      : value;
/** Digest the exact validated candidate, including private fields; only the digest
 * crosses back from the helper. It grants no persisted row or verification cache. */
export function nativeMachineCatalogCandidateDigest(candidate: AgentConfigMeta): string {
  const command = parseMachineCatalogIpcCommand(
    { kind: 'create-agent', config: candidate },
    candidate.machineId
  );
  if (command.kind !== 'create-agent') throw new Error('Invalid candidate');
  return sha256Hex(new TextEncoder().encode(JSON.stringify(canonical(command.config))));
}
export const nativeMachineCatalogVerificationInputSchema = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    binding,
    expectedGeneration: id,
    candidateSha256: digest,
    candidate: z.unknown(),
  })
  .strict()
  .transform((input, context) => {
    try {
      if (
        new TextEncoder().encode(JSON.stringify(input)).byteLength >
        NATIVE_MACHINE_CATALOG_VERIFICATION_MAX_BYTES
      )
        throw new Error();
      const command = parseMachineCatalogIpcCommand(
        { kind: 'create-agent', config: input.candidate },
        input.binding.machineId
      );
      if (
        command.kind !== 'create-agent' ||
        nativeMachineCatalogCandidateDigest(command.config) !== input.candidateSha256
      )
        throw new Error();
      return { ...input, candidate: command.config };
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid bound provider verification input' });
      return z.NEVER;
    }
  });
const receipt = z.object({
  version: z.literal(1),
  requestId: z.uuid(),
  binding,
  expectedGeneration: id,
  candidateSha256: digest,
  configId: id,
});
export const nativeMachineCatalogVerificationReceiptSchema = z.discriminatedUnion('verified', [
  receipt.extend({ verified: z.literal(true) }).strict(),
  receipt
    .extend({ verified: z.literal(false), reason: z.enum(['verification_failed', 'cancelled']) })
    .strict(),
]);
export type NativeMachineCatalogVerificationInput = z.infer<
  typeof nativeMachineCatalogVerificationInputSchema
>;
export type NativeMachineCatalogVerificationReceipt = z.infer<
  typeof nativeMachineCatalogVerificationReceiptSchema
>;
