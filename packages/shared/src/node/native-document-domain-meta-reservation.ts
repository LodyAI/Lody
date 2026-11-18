import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '@loro-dev/loro-repo-client';
import {
  rendererDocumentDomainScopeSchema,
  type RendererDocumentDomainScope,
} from '../renderer-document-domain-migration';
import type {
  createNativeWorkspaceMeta,
  NativeWorkspaceMetaSnapshot,
} from './native-workspace-meta';

type Metadata = ReturnType<typeof createNativeWorkspaceMeta>;
const receiptSchema = z
  .object({
    version: z.literal(1),
    family: z.enum(['preview_comments', 'schedule_definition']),
    reservationId: z.uuid(),
    creationIntentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NativeDocumentDomainCreationIntent = {
  scope: RendererDocumentDomainScope;
  actorId: string;
  machineId: string;
  createdAt: string;
  initial: Readonly<Record<string, JsonValue>>;
};
/** A canonical hash binds the trusted family planner's initial body, actual
 * author/machine and Meta identity. No renderer-supplied receipt is accepted. */
export function nativeDocumentDomainCreationIntentSha256(
  binding: Metadata['binding'],
  intent: NativeDocumentDomainCreationIntent
) {
  rendererDocumentDomainScopeSchema.parse(intent.scope);
  if (
    intent.actorId !== binding.accountId ||
    !intent.machineId ||
    !Number.isFinite(Date.parse(intent.createdAt))
  )
    throw new Error('Invalid leaf creation authority');
  const canonical = JSON.stringify({ version: 1, binding, intent }, (_key, value: unknown) => {
    if (
      typeof value === 'bigint' ||
      value instanceof Uint8Array ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error('Invalid initial leaf value');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value;
  });
  return createHash('sha256').update(canonical).digest('hex');
}
export function reserveNativeDocumentDomainMetadata(options: {
  owner: Metadata;
  intent: NativeDocumentDomainCreationIntent;
  reservationId: string;
  assertCurrent(): void;
  absenceWitness(): {
    sources: readonly { sourceId: string; present: boolean }[];
    assertCurrent(): void;
  };
  authorize(snapshot: NativeWorkspaceMetaSnapshot): void;
}) {
  const intent = structuredClone(options.intent);
  const creationIntentSha256 = nativeDocumentDomainCreationIntentSha256(
    options.owner.binding,
    intent
  );
  const expected = receiptSchema.parse({
    version: 1,
    family: intent.scope.domain,
    reservationId: options.reservationId,
    creationIntentSha256,
  });
  const check = () => {
    options.assertCurrent();
    options.owner.assertCurrent();
  };
  const matches = (snapshot: NativeWorkspaceMetaSnapshot) => {
    const row = snapshot.docs.find((row) => row.docId === intent.scope.metadataDocId);
    const receipt = receiptSchema.safeParse(row?.meta.nativeDocumentCreation);
    return (
      row &&
      !row.deleted &&
      row.meta.id === intent.scope.id &&
      row.meta.userId === intent.actorId &&
      row.meta.machineId === intent.machineId &&
      receipt.success &&
      Object.entries(expected).every(([key, value]) => Reflect.get(receipt.data, key) === value)
    );
  };
  const assertReservation = async (reservationId: string) => {
    check();
    if (reservationId !== options.reservationId)
      throw new Error('Leaf reservation identity changed');
    const state = await options.owner.readDocumentCreationState(intent.scope.metadataDocId);
    check();
    options.authorize(state.snapshot);
    if (!matches(state.snapshot)) throw new Error('Leaf metadata reservation conflict');
  };
  return {
    creationIntentSha256,
    assertReservation,
    async reserveMetadata() {
      check();
      const state = await options.owner.readDocumentCreationState(intent.scope.metadataDocId);
      check();
      options.authorize(state.snapshot);
      if (matches(state.snapshot)) return { reservationId: options.reservationId };
      if (!state.pristine) throw new Error('Leaf metadata requires complete pristine absence');
      await options.owner.createDocumentIfPristine(
        intent.scope.metadataDocId,
        {
          id: intent.scope.id,
          userId: intent.actorId,
          machineId: intent.machineId,
          createdAt: intent.createdAt,
          nativeDocumentCreation: expected,
        },
        (snapshot) => {
          check();
          options.authorize(snapshot);
          const witness = options.absenceWitness();
          witness.assertCurrent();
          if (
            !witness.sources.length ||
            new Set(witness.sources.map((source) => source.sourceId)).size !==
              witness.sources.length ||
            witness.sources.some((source) => !source.sourceId || source.present)
          )
            throw new Error('Complete leaf absence required');
        }
      );
      await assertReservation(options.reservationId);
      return { reservationId: options.reservationId };
    },
  };
}
