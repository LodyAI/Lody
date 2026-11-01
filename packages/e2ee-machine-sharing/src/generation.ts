import { Effect, Result } from 'effect';
import {
  decodeRecord,
  verifyLedgerEffect,
  verifyMachineSharingGeneration,
  type LedgerView,
  type MachineSharingAdmission,
  type Bytes,
} from '@lody/e2ee-core/protocol';

/** Local originals select the candidate replacement chain. Core authenticates every
 * position and link; neither remote generation metadata nor this selection grants authority. */
export const machineSharingGenerationFromHistory = Effect.fnUntraced(function* (input: {
  ledger: LedgerView;
  machineId: string;
  device: Bytes.SigningPublicKey;
  originals: readonly MachineSharingAdmission[];
}) {
  const admissions = new Map<string, { step: MachineSharingAdmission; replaces: string | null }>();
  const hex = (key: Bytes.SigningPublicKey) => Buffer.from(key.toBytes()).toString('hex');
  for (const step of input.originals) {
    const decoded = yield* Effect.fromResult(decodeRecord(step.record));
    const body = decoded.body;
    if (
      body.type === 'ordinary' &&
      body.operation.type === 'admitDevice' &&
      body.operation.kind === 'machine' &&
      body.operation.machineId === input.machineId
    ) {
      admissions.set(hex(body.operation.signingPublicKey), {
        step,
        replaces: body.operation.replaces ? hex(body.operation.replaces) : null,
      });
    }
  }
  const admissionChain: MachineSharingAdmission[] = [];
  let device: string | null = hex(input.device);
  while (device !== null && admissionChain.length <= 4096) {
    const admission = admissions.get(device);
    if (!admission) break;
    admissionChain.unshift(admission.step);
    device = admission.replaces;
  }
  const candidate = { ...input, admissionChain };
  const checked = verifyMachineSharingGeneration(candidate);
  if (Result.isSuccess(checked)) return checked.success;
  // Compaction may omit checkpoints. Replaying retained local originals at the
  // same authenticated endpoint qualifies evidence without changing the workspace's view/pin.
  const ledger = yield* verifyLedgerEffect({
    anchor: input.ledger.genesis,
    records: input.originals.map((step) => step.record),
    checkpoint: { head: input.ledger.head, length: input.ledger.length },
  });
  return yield* Effect.fromResult(verifyMachineSharingGeneration({ ...candidate, ledger }));
});
