import { sessionDocSchema } from '@lody/shared';
import { schema, type ContainerSchemaType } from 'loro-mirror';

/**
 * The session doc schema with `history` declared but never materialized.
 * `buildRootStateSnapshot` skips `Ignore` fields and, because the key IS
 * declared, the `ignoreUnknownProperties` root pass skips it too; the event
 * path is fenced by `createControlPlaneDoc`. History is read through
 * `ConversationView` and written through `HistoryWriter` instead.
 */
export const sessionControlPlaneSchema = schema({
  ...sessionDocSchema.definition,
  // Root definitions are typed as containers; loro-mirror handles `Ignore`
  // at the root at runtime (see `buildRootStateSnapshot`).
  history: schema.Ignore() as unknown as ContainerSchemaType,
});

/**
 * The roots the schema marks `Ignore`, read back from the schema so the doc
 * facade cannot drift from it. loro-mirror honours `Ignore` when it builds a
 * state snapshot but not on its incremental event path, which is what
 * `createControlPlaneDoc` fences.
 */
export const CONTROL_PLANE_IGNORED_ROOT_KEYS = Object.entries(sessionControlPlaneSchema.definition)
  .filter(([, field]) => (field as { type?: string }).type === 'ignore')
  .map(([key]) => key);
