import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workspaceMetaCommandSchema } from '../native-workspace-meta-ipc';
import type {
  createNativeWorkspaceMeta,
  NativeWorkspaceMetaSnapshot,
} from './native-workspace-meta';

type Metadata = ReturnType<typeof createNativeWorkspaceMeta>;
type Binding = Metadata['binding'];
const receiptSchema = z
  .object({
    version: z.literal(1),
    reservationId: z.string().uuid(),
    creationIntentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export class NativeSessionMetadataReservationError extends Error {
  constructor(readonly code: 'invalid_intent' | 'conflict' | 'absence_required') {
    super(`Native Session metadata reservation: ${code}`);
  }
}
function creationPatch(sessionId: string, patch: unknown): Record<string, unknown> {
  try {
    z.string().uuid().parse(sessionId);
    const command = workspaceMetaCommandSchema.parse({
      kind: 'upsert-doc',
      docId: `session-${sessionId}`,
      patch,
    });
    if (command.kind !== 'upsert-doc') throw new Error('Invalid creation');
    const parsed: Record<string, unknown> = structuredClone(command.patch);
    if (
      parsed.id !== sessionId ||
      typeof parsed.machineId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.cliType !== 'string' ||
      typeof parsed.agentType !== 'string' ||
      (parsed.historyBackend !== undefined && parsed.historyBackend !== 'loro')
    )
      throw new Error('Invalid creation');
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
  } catch {
    throw new NativeSessionMetadataReservationError('invalid_intent');
  }
}
/** Hash the validated Node intent, never a renderer's claimed hash or an
 * unvalidated metadata object. Reservation nonce is separately journal-bound. */
export function calculateNativeSessionCreationIntentSha256(input: {
  binding: Binding;
  sessionId: string;
  patch: unknown;
}): string {
  const metadata = creationPatch(input.sessionId, input.patch);
  const canonical = JSON.stringify(
    { version: 1, binding: input.binding, roomId: `session-${input.sessionId}`, metadata },
    (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value
  );
  return createHash('sha256').update(canonical).digest('hex');
}
export type NativeSessionMetadataAbsence = {
  readonly sources: readonly { readonly sourceId: string; readonly present: boolean }[];
  assertCurrent(): void;
};
export type NativeSessionMetadataReservationIdentity = {
  owner: Metadata;
  sessionId: string;
  reservationId: string;
  creationIntentSha256: string;
  actorId: string;
  machineId: string;
  assertCurrent(): void;
};
/** Read-only recovery from the trusted persisted creation journal. A title or
 * other public field may have changed since reservation; never rehash current
 * metadata, reconstruct the original intent, or submit a compensating write. */
export async function assertNativeSessionMetadataReservation(
  options: NativeSessionMetadataReservationIdentity
): Promise<void> {
  options.assertCurrent();
  options.owner.assertCurrent();
  const expected = receiptSchema.safeParse({
    version: 1,
    reservationId: options.reservationId,
    creationIntentSha256: options.creationIntentSha256,
  });
  if (
    !z.string().uuid().safeParse(options.sessionId).success ||
    !expected.success ||
    options.actorId !== options.owner.binding.accountId
  )
    throw new NativeSessionMetadataReservationError('invalid_intent');
  const state = await options.owner.readDocumentCreationState(`session-${options.sessionId}`);
  options.assertCurrent();
  options.owner.assertCurrent();
  const row = state.snapshot.docs.find((row) => row.docId === `session-${options.sessionId}`);
  const actual = receiptSchema.safeParse(row?.meta.nativeSessionCreation);
  if (
    !row ||
    row.deleted ||
    row.meta.id !== options.sessionId ||
    row.meta.userId !== options.actorId ||
    row.meta.machineId !== options.machineId ||
    (row.meta.historyBackend !== undefined && row.meta.historyBackend !== 'loro') ||
    !actual.success ||
    actual.data.reservationId !== expected.data.reservationId ||
    actual.data.creationIntentSha256 !== expected.data.creationIntentSha256
  )
    throw new NativeSessionMetadataReservationError('conflict');
}
/** Trusted Node port for createSession. No private receipt crosses public Meta
 * projection or renderer IPC. Matching receipts reconcile by reading only;
 * an unknown ACK is propagated and never immediately retried. */
export function reserveNativeSessionMetadata(options: {
  owner: Metadata;
  sessionId: string;
  reservationId: string;
  creationIntentSha256: string;
  patch: unknown;
  actorId: string;
  machineId: string;
  assertCurrent(): void;
  /** Available after the kernel has actually drained every legacy source. */
  absenceWitness(): NativeSessionMetadataAbsence;
  authorize?(snapshot: NativeWorkspaceMetaSnapshot): void;
}) {
  const patch = creationPatch(options.sessionId, options.patch);
  const decodedReceipt = receiptSchema.safeParse({
    version: 1,
    reservationId: options.reservationId,
    creationIntentSha256: options.creationIntentSha256,
  });
  if (!decodedReceipt.success) throw new NativeSessionMetadataReservationError('invalid_intent');
  const receipt = decodedReceipt.data;
  if (
    patch.userId !== options.actorId ||
    patch.machineId !== options.machineId ||
    options.actorId !== options.owner.binding.accountId ||
    calculateNativeSessionCreationIntentSha256({
      binding: options.owner.binding,
      sessionId: options.sessionId,
      patch,
    }) !== receipt.creationIntentSha256
  )
    throw new NativeSessionMetadataReservationError('invalid_intent');
  const roomId = `session-${options.sessionId}`;
  const check = () => {
    options.assertCurrent();
    options.owner.assertCurrent();
  };
  const matches = (snapshot: NativeWorkspaceMetaSnapshot): boolean => {
    const row = snapshot.docs.find((row) => row.docId === roomId);
    if (
      !row ||
      row.deleted ||
      row.meta.id !== options.sessionId ||
      row.meta.userId !== options.actorId ||
      row.meta.machineId !== options.machineId ||
      (row.meta.historyBackend !== undefined && row.meta.historyBackend !== 'loro')
    )
      return false;
    const existing = receiptSchema.safeParse(row.meta.nativeSessionCreation);
    return (
      existing.success &&
      existing.data.reservationId === receipt.reservationId &&
      existing.data.creationIntentSha256 === receipt.creationIntentSha256
    );
  };
  const assertReservation = async (reservationId: string) => {
    check();
    if (reservationId !== receipt.reservationId)
      throw new NativeSessionMetadataReservationError('conflict');
    const state = await options.owner.readDocumentCreationState(roomId);
    check();
    if (!matches(state.snapshot)) throw new NativeSessionMetadataReservationError('conflict');
  };
  return {
    assertReservation,
    async reserveMetadata() {
      check();
      const state = await options.owner.readDocumentCreationState(roomId);
      check();
      if (matches(state.snapshot)) return { reservationId: receipt.reservationId };
      if (!state.pristine) throw new NativeSessionMetadataReservationError('conflict');
      await options.owner.createDocumentIfPristine(
        roomId,
        { ...patch, nativeSessionCreation: receipt },
        (snapshot) => {
          check();
          const witness = options.absenceWitness();
          witness.assertCurrent();
          if (
            !witness.sources.length ||
            new Set(witness.sources.map((source) => source.sourceId)).size !==
              witness.sources.length ||
            witness.sources.some((source) => !source.sourceId || source.present)
          )
            throw new NativeSessionMetadataReservationError('absence_required');
          options.authorize?.(snapshot);
        }
      );
      check();
      await assertReservation(receipt.reservationId);
      return { reservationId: receipt.reservationId };
    },
  };
}
