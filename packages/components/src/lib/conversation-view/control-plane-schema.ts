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

export const CONTROL_PLANE_IGNORED_ROOT_KEYS = ['history'] as const;
