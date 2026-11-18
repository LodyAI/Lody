import { assertScheduleRegistryIpcWriteAuthority } from '../schedule-registry-ipc';
import { historyValuesEqual } from '../history-values-equal';
import { createNativeScheduleRegistry } from './native-schedule-registry';
import {
  scheduleDocumentFromMirrorState,
  prepareScheduleSave,
  prepareScheduleEnabled,
  type ScheduleSaveInput,
  type ScheduleEnabledInput,
} from '../schedule-repository';
import { getScheduleRoomId, buildScheduleRegistryRow } from '../schedule-registry';
import type { ScheduleDocument, ScheduleRegistryRow } from '../schedule-types';
import { LODY_SCHEDULE_DOC_SCHEMA } from '@loro-dev/loro-repo-client';
import {
  queryNativeLoroDocument,
  mutateNativeLoroDocument,
  planNativeDocumentFields,
  observeNativeLoroDocument,
  type NativeLoroDocumentOptions,
} from './native-loro-document';

export type NativeScheduleDefinitionRegistry = {
  read(scheduleId: string): Promise<{ row?: ScheduleRegistryRow; deleted: boolean }>;
  /** One owner transaction rechecks tombstone/owner before publishing the row.
   * The registry fingerprint remains the execution gate; discovery never calls this. */
  publish(row: ScheduleRegistryRow): Promise<void>;
  flush(): Promise<void>;
  prepareRetention?(
    scheduleId: string,
    input: import('../schedule-registry-port').ScheduleRetentionRequest
  ): Promise<boolean>;
  completeRetention?(
    scheduleId: string,
    input: import('../schedule-registry-port').ScheduleRetentionRequest
  ): Promise<void>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
/** Apply only changes between understood projections to the complete stored
 * value. Opaque siblings, inline values and unchanged array entries survive. */
const mergeScheduleEdits = (raw: unknown, before: unknown, after: unknown): unknown => {
  if (historyValuesEqual(before, after)) return raw;
  if (record(before) && record(after) && record(raw)) {
    const next = { ...raw };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (historyValuesEqual(before[key], after[key])) continue;
      if (after[key] === undefined) delete next[key];
      else next[key] = mergeScheduleEdits(raw[key], before[key], after[key]);
    }
    return next;
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(raw))
    return after.map((entry, index) => mergeScheduleEdits(raw[index], before[index], entry));
  return after;
};

export type NativeScheduleDefinitionAuthorization = (input: {
  readonly document: ScheduleDocument;
  readonly previous: ScheduleDocument | null;
  readonly registryRow: ScheduleRegistryRow | undefined;
}) => void;

/** Trusted local-main policy, evaluated on the actual CAS-read definition. */
export function assertNativeScheduleDefinitionLocalAuthority(
  input: Parameters<NativeScheduleDefinitionAuthorization>[0],
  actorId: string,
  machineId: string
): void {
  if (
    input.document.definition.ownerId !== actorId ||
    input.document.definition.machineId !== machineId ||
    (input.previous && input.previous.definition.machineId !== machineId)
  )
    throw new Error('Schedule definition authority denied');
  assertScheduleRegistryIpcWriteAuthority(
    { kind: 'publish', row: buildScheduleRegistryRow(input.document) },
    input.registryRow
      ? [{ key: ['schedule', input.document.definition.scheduleId], value: input.registryRow }]
      : [],
    actorId,
    machineId
  );
}

/** Local plaintext definition slice of ScheduleRepository. Cloud/protected
 * declarations, runtime ledger, scheduling clocks and execution stay with their owners. */
export function createNativeScheduleDefinition(
  options: Omit<NativeLoroDocumentOptions, 'roomId' | 'schema'> & {
    readonly scheduleId: string;
    readonly registry: NativeScheduleDefinitionRegistry;
    readonly flushDefinition: () => Promise<void>;
  }
) {
  const bound = {
    ...options,
    roomId: getScheduleRoomId(options.scheduleId),
    schema: LODY_SCHEDULE_DOC_SCHEMA,
  };
  const document = (raw: Record<string, unknown>) =>
    scheduleDocumentFromMirrorState(
      {
        definition: raw.definition,
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        message: raw.message as { payload?: unknown } | undefined,
        timeline: Array.isArray(raw.timeline) ? (raw.timeline as ScheduleDocument['timeline']) : [],
      },
      options.scheduleId
    );
  const owned = (
    previous: ScheduleDocument | null,
    row: ScheduleRegistryRow | undefined,
    actorId: string
  ) => {
    if (!previous || !row) throw new Error('Schedule not found');
    if (previous.definition.ownerId !== actorId || row.ownerId !== actorId)
      throw new Error('Only the Schedule owner can change it');
  };
  const planDocument = (
    raw: Record<string, unknown>,
    value: ScheduleDocument,
    plan: Parameters<Parameters<typeof mutateNativeLoroDocument>[1]>[1]
  ) => {
    const previous = document(raw);
    const before = previous
      ? {
          definition: previous.definition,
          prompt: previous.prompt,
          message: { payload: previous.message },
          timeline: previous.timeline,
        }
      : {};
    const next = {
      definition: value.definition,
      prompt: value.prompt,
      message: { payload: value.message },
      timeline: value.timeline,
    };
    const merged = mergeScheduleEdits(raw, before, next) as Record<string, unknown>;
    if (previous && Array.isArray(raw.timeline)) {
      // Complete-message reads deduplicate legacy activity ids. Their raw array
      // can therefore have a different index layout from that projection. Both
      // domain planners append activities only; preserve every original entry
      // and append only new ids instead of merging by projected array position.
      const existing = new Map(previous.timeline.map((activity) => [activity.id, activity]));
      if (
        previous.timeline.some(
          (activity) =>
            !value.timeline.some(
              (next) => next.id === activity.id && historyValuesEqual(activity, next)
            )
        )
      )
        throw new Error('Unsupported existing Schedule activity rewrite');
      merged.timeline = [
        ...raw.timeline,
        ...value.timeline.filter((activity) => !existing.has(activity.id)),
      ];
    }
    planNativeDocumentFields(plan, raw, merged);
  };
  const publish = async (value: ScheduleDocument) => {
    await options.flushDefinition();
    options.assertAccess();
    // Same doc-first durability ordering as ScheduleRepository.write.
    await options.registry.publish(buildScheduleRegistryRow(value));
    await options.registry.flush();
  };
  return {
    async read(): Promise<ScheduleDocument | null> {
      return (await queryNativeLoroDocument(bound, document)).result;
    },
    async save(
      args: ScheduleSaveInput,
      authorize?: NativeScheduleDefinitionAuthorization
    ): Promise<ScheduleDocument> {
      if (args.scheduleId !== options.scheduleId) throw new Error('Schedule binding mismatch');
      const state = await options.registry.read(options.scheduleId);
      options.assertAccess();
      if (state.deleted) throw new Error('Schedule was deleted');
      const value = await mutateNativeLoroDocument(bound, (raw, plan) => {
        const previous = document(raw);
        if (
          !previous &&
          raw.definition !== undefined &&
          (raw.definition === null ||
            typeof raw.definition !== 'object' ||
            Array.isArray(raw.definition) ||
            Object.keys(raw.definition).length > 0)
        )
          throw new Error('Unsupported existing Schedule definition');
        if (!args.create) owned(previous, state.row, args.actorId);
        const next = prepareScheduleSave(args, previous);
        // The legacy repository validates the fingerprint/complete-message
        // invariants before opening its writer. Reject before this CAS patch too.
        buildScheduleRegistryRow(next);
        authorize?.({ document: next, previous, registryRow: state.row });
        options.assertAccess();
        planDocument(raw, next, plan);
        return next;
      });
      await publish(value);
      return value;
    },
    async setEnabled(
      args: ScheduleEnabledInput,
      authorize?: NativeScheduleDefinitionAuthorization
    ): Promise<void> {
      if (args.scheduleId !== options.scheduleId) throw new Error('Schedule binding mismatch');
      const state = await options.registry.read(options.scheduleId);
      options.assertAccess();
      if (state.deleted) throw new Error('Schedule was deleted');
      const result = await mutateNativeLoroDocument(bound, (raw, plan) => {
        const previous = document(raw);
        owned(previous, state.row, args.actorId);
        const next = prepareScheduleEnabled(previous!, args);
        buildScheduleRegistryRow(next.document);
        authorize?.({ document: next.document, previous, registryRow: state.row });
        options.assertAccess();
        if (next.write) planDocument(raw, next.document, plan);
        return next;
      });
      if (result.write) await publish(result.document);
    },
    observe(listener: (value: ScheduleDocument | null) => void, onError: (error: unknown) => void) {
      return observeNativeLoroDocument(
        bound,
        (value) => document(value as Record<string, unknown>),
        listener,
        onError
      );
    },
  };
}

/** Compatibility with the definition adapter; all SR policy lives in the shared planner. */
export function createNativeScheduleDefinitionRegistry(options: {
  readonly client: import('@loro-dev/loro-repo-client').RepoClient;
  readonly namespace: string;
  readonly workspaceId: import('../ids').WorkspaceId;
  readonly writer: string;
  readonly assertAccess: () => void;
  readonly flush: () => Promise<void>;
}): NativeScheduleDefinitionRegistry {
  const registry = createNativeScheduleRegistry({
    ...options,
    getClient: async () => options.client,
  });
  return createScheduleDefinitionRegistryAdapter(registry, options.assertAccess);
}
/** Node-private whole-SR adapter. A retained tombstone suppresses execution
 * while the original registry/runtime rows remain a durable cleanup handle. */
export function createScheduleDefinitionRegistryAdapter(
  registry: import('../schedule-registry-port').ScheduleRegistryPort,
  check: () => void
): NativeScheduleDefinitionRegistry {
  const retained = async (
    id: string,
    input: import('../schedule-registry-port').ScheduleRetentionRequest
  ) => {
    check();
    const rows = await registry.exportRows();
    check();
    const raw = rows.find(
      (row) => row.key.length === 2 && row.key[0] === 'tombstone' && row.key[1] === id
    )?.value;
    if (!record(raw) || raw.actorId !== input.actorId) return false;
    const expected = {
      activationId: input.activationId,
      runtimeUpdatedAt: input.runtimeUpdatedAt,
      now: input.now,
      retentionMs: input.retentionMs,
      machineId: input.machineId,
    };
    return historyValuesEqual(raw.nativeRetention, expected);
  };
  return {
    async read(id) {
      check();
      const state = await registry.read();
      check();
      return {
        row: state.schedules.find((row) => row.scheduleId === id),
        deleted: state.tombstones.some((row) => row.scheduleId === id),
      };
    },
    async publish(row) {
      check();
      await registry.execute({ kind: 'publish', row });
      check();
    },
    flush: () => registry.flush(),
    async prepareRetention(id, input) {
      if (await retained(id, input)) return true;
      await registry.execute({ kind: 'prepare-prune', scheduleId: id, ...input });
      await registry.flush();
      return retained(id, input);
    },
    async completeRetention(id, input) {
      if (!(await retained(id, input))) throw new Error('Native retention execution fence missing');
      await registry.execute({ kind: 'complete-prune', scheduleId: id, ...input });
      await registry.flush();
      check();
      const rows = await registry.exportRows();
      check();
      if (
        rows.some(
          (row) =>
            (row.key[0] === 'schedule' || row.key[0] === 'runtime' || row.key[0] === 'manual') &&
            row.key[1] === id
        )
      )
        throw new Error('Native retention registry cleanup changed');
    },
  };
}

export { scheduleDocumentFromMirrorState, prepareScheduleSave } from '../schedule-repository';
export { buildScheduleRegistryRow } from '../schedule-registry';
