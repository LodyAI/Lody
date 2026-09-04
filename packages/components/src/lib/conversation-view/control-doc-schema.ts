import { schema, type ContainerSchemaType } from 'loro-mirror';
import { sessionDocSchema } from '@lody/shared';

/**
 * The session doc schema with `history` declared as an ignored root.
 *
 * A Mirror over the full `sessionDocSchema` materializes every history
 * container at construction (357–521 ms on a 171-turn doc with 70k
 * containers), which is what makes long conversations freeze on open. The
 * renderer reads history through `ConversationView` instead, so the Mirror
 * that backs the control plane (session, mq, preview, fork, runtime config)
 * must never touch the history list. `schema.Ignore()` keeps the key declared
 * — so `ignoreUnknownProperties` root mirroring does not re-materialize it —
 * while `buildRootStateSnapshot` skips it.
 *
 * Writes to history must go through `HistoryWriter`: a `setState` that
 * touches an ignored field is memory-only and would silently not persist.
 */
export const sessionControlDocSchema = schema({
  ...sessionDocSchema.definition,
  // `RootSchemaDefinition` is typed as containers only, but the runtime treats
  // an `ignore` root exactly like an ignored map field (memory-only, skipped by
  // `buildRootStateSnapshot`); `control-mirror.test.ts` pins that behavior.
  history: schema.Ignore() as unknown as ContainerSchemaType,
});
