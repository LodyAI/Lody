import { hasEmptyModelSelectOption } from '@lody/shared';
import {
  nativeMachineCatalogVerificationInputSchema,
  nativeMachineCatalogVerificationReceiptSchema,
  type NativeMachineCatalogVerificationReceipt,
} from '@lody/shared/native-machine-catalog-verification';
import { fetchAcpCapabilities } from '@/agent/acp-capabilities';
import { getCodexProfileStore } from '@/agent/codex-profile-store';
import type { Logger } from '@/utils/logger';

const quiet = (): Logger => ({
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  trace() {},
  setLevel() {},
  setDebug() {},
  child: () => quiet(),
  close: async () => {},
});
/** Main owns the enclosing helper process group. No Repo, Flock, publication or
 * renderer-provided test result participates in this live candidate probe. */
export async function verifyNativeMachineCatalogCandidate(
  raw: unknown,
  signal: AbortSignal
): Promise<NativeMachineCatalogVerificationReceipt> {
  const input = nativeMachineCatalogVerificationInputSchema.parse(raw);
  const candidate = input.candidate;
  const receipt = {
    version: 1 as const,
    requestId: input.requestId,
    binding: input.binding,
    expectedGeneration: input.expectedGeneration,
    candidateSha256: input.candidateSha256,
    configId: candidate.id,
  };
  try {
    signal.throwIfAborted();
    const profiles = getCodexProfileStore();
    if (
      !candidate.codexAuth &&
      (await profiles.isAccountBound({
        workspaceId: input.binding.workspaceId,
        machineId: candidate.machineId,
        configId: candidate.id,
      }))
    )
      throw new Error('Existing account reference is required');
    const profile = candidate.codexAuth
      ? await profiles.resolve(input.binding.workspaceId, candidate)
      : undefined;
    signal.throwIfAborted();
    const result = await fetchAcpCapabilities(
      candidate.cliType,
      candidate.agentType,
      quiet(),
      candidate.env,
      candidate.customAcp,
      candidate.runtimeOverrides,
      {
        agentConfigId: candidate.id,
        magpieGatewayUrl: candidate.magpieGatewayUrl,
        codexProfile: profile ? { profile } : undefined,
        verifyCodexCredential: !!profile && profile.profile.mode === 'api-key',
        signal,
        parentOwnsProcessGroup: true,
      }
    );
    signal.throwIfAborted();
    if (hasEmptyModelSelectOption(result.configOptions)) throw new Error('No usable models');
    return nativeMachineCatalogVerificationReceiptSchema.parse({ ...receipt, verified: true });
  } catch {
    return nativeMachineCatalogVerificationReceiptSchema.parse({
      ...receipt,
      verified: false,
      reason: signal.aborted ? 'cancelled' : 'verification_failed',
    });
  }
}
