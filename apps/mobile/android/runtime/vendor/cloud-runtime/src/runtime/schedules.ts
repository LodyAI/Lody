import type { Flock } from '@loro-dev/flock-wasm/base64';
import type { StreamsClient } from '@loro-dev/streams-client';
import { LoroDoc } from 'loro-crdt/base64';
import { Mirror, schema } from 'loro-mirror';
import { clientFor, importUpdates, unpack } from './session';
import { openSettings } from './settings';
import { encodeFrame } from '../frames';
import {
  ScheduleActivitySchema,
  ScheduleDefinitionSchema,
  ScheduleTombstoneSchema,
  ScheduleTriggerSchema,
  buildScheduleRegistryRow,
  canonicalScheduleJson,
  getScheduleRegistryStreamId,
  getScheduleStreamId,
  isScheduleIdentifier,
  readScheduleRegistry,
  scheduleRegistryKeys,
  type ScheduleAgent,
  type ScheduleDefinition,
  type ScheduleDestination,
  type ScheduleDocument,
  type ScheduleProjectRef,
  type ScheduleTrigger,
} from '../protocol/schedules.ts';

// Native port of web `ScheduleRepository` (shared `schedule-repository.ts`)
// over Streams: the per-schedule Loro document is written first, then its
// Registry row in `${workspaceId}:sr` — that publication is the execution gate
// the owning machine reads. Mobile workspaces are plaintext only, so no
// protected-content authorization records are written. Writes are never
// replayed automatically; callers retry with the same request id.

type Grant = () => Promise<{ token: string; gatewayBaseUrl: string }>;

/** Mirrors shared `scheduleDocSchema`; field kinds must stay identical. */
const scheduleDocSchema = schema({
  definition: schema.LoroMap({
    scheduleId: schema.String(),
    messageVersion: schema.Number({ required: false }),
    title: schema.String(),
    ownerId: schema.String(),
    machineId: schema.String(),
    enabled: schema.Boolean(),
    activationId: schema.String(),
    activeFrom: schema.Number(),
    trigger: schema.Any(),
    misfirePolicy: schema.Any(),
    overlapPolicy: schema.String(),
    agent: schema.Any(),
    project: schema.Any({ required: false }),
    destination: schema.Any({ required: false }),
    retryPolicy: schema.Any(),
    createdAt: schema.Number(),
    updatedAt: schema.Number(),
    createdBy: schema.String(),
  }),
  prompt: schema.LoroText(),
  message: schema.LoroMap({ payload: schema.Any({ required: false }) }),
  timeline: schema.LoroList(
    schema.LoroMap({
      id: schema.String(),
      kind: schema.String(),
      actorId: schema.String(),
      requesterSessionId: schema.String({ required: false }),
      createdAt: schema.Number(),
    }),
    (item: { id: string }) => item.id,
  ),
});

const CID_KEY = '$cid';
/** Mirror tags nested maps with an inherited `$cid`; rebuild plain own keys. */
function withoutContainerIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutContainerIds);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== CID_KEY)
      .map(([key, entry]) => [key, withoutContainerIds(entry)]),
  );
}

export type ScheduleRead = {
  document: ScheduleDocument | null;
  /** A one-time message: mobile shows it but never rewrites it. */
  message: boolean;
  /** Message text for display when `message` is set. */
  text: string;
};

function readDocument(doc: LoroDoc, scheduleId: string): ScheduleRead {
  const mirror = new Mirror({
    doc,
    schema: scheduleDocSchema,
    ignoreUnknownProperties: true,
  });
  try {
    const state = mirror.getState() as {
      definition?: unknown;
      prompt: string;
      message?: { payload?: unknown };
      timeline: unknown;
    };
    const parsed = ScheduleDefinitionSchema.safeParse(
      withoutContainerIds(state.definition),
    );
    if (!parsed.success || parsed.data.scheduleId !== scheduleId)
      return { document: null, message: false, text: '' };
    const message =
      parsed.data.messageVersion === 1 || state.message?.payload !== undefined;
    const timeline = ScheduleActivitySchema.array().safeParse(
      withoutContainerIds(state.timeline),
    );
    return {
      document: message
        ? null
        : {
            definition: parsed.data,
            prompt: state.prompt,
            timeline: timeline.success ? timeline.data : [],
          },
      message,
      text: state.prompt,
    };
  } finally {
    mirror.dispose();
  }
}

export type ScheduleStreams = ReturnType<typeof scheduleStreams>;

export function scheduleStreams(
  workspaceId: string,
  getGrant: Grant,
  signal: AbortSignal,
) {
  const registryId = getScheduleRegistryStreamId(workspaceId);
  const registry = async (create: boolean) => {
    if (create) {
      const client = await clientFor(registryId, getGrant);
      const created = await client.create({
        contentType: 'application/octet-stream',
      });
      if (!created.ok) throw writeError(created.result.code);
    }
    try {
      return await openSettings(registryId, getGrant, signal);
    } catch (error) {
      if (!create && error instanceof Error && error.message === 'not_found')
        return undefined;
      throw error;
    }
  };
  const list = async () => {
    const replica = await registry(false);
    return replica
      ? readScheduleRegistry(replica.flock.scan())
      : { rows: [], runtimes: [] };
  };
  const openDoc = async (scheduleId: string, create: boolean) => {
    const stream = getScheduleStreamId(workspaceId, scheduleId);
    const client = await clientFor(stream, getGrant);
    if (create) {
      const created = await client.create({
        contentType: 'application/octet-stream',
      });
      if (!created.ok) throw writeError(created.result.code);
    }
    const first = await client.bootstrap({ signal });
    if (!first.ok) {
      if (first.result.code === 'not_found') return { client, doc: undefined };
      throw new Error(first.result.code);
    }
    const doc = new LoroDoc();
    let size = 0;
    const apply = (bytes: Uint8Array) => {
      size += bytes.length;
      if (size > 8 * 1024 * 1024) throw new Error('schedule_invalid');
      importUpdates(doc, bytes);
    };
    const data = first.result;
    if (data.snapshotOffset !== '-1' && data.snapshot) {
      size += data.snapshot.body.length;
      doc.import(unpack(data.snapshot.body));
    }
    for (const part of data.updates) apply(part.body);
    let { nextOffset: offset, cursor, upToDate } = data;
    for (let page = 0; !upToDate; page++) {
      signal.throwIfAborted();
      if (page >= 100) throw new Error('schedule_invalid');
      const next = await client.readOnce({ offset, cursor, signal });
      if (!next.ok) throw new Error(next.result.code);
      if (next.result.payload) apply(next.result.payload.body);
      if (offset === next.result.nextOffset && !next.result.upToDate)
        throw new Error('stalled_cursor');
      ({ nextOffset: offset, cursor, upToDate } = next.result);
    }
    return { client, doc };
  };
  const read = async (scheduleId: string): Promise<ScheduleRead> => {
    const { doc } = await openDoc(scheduleId, false);
    return doc
      ? readDocument(doc, scheduleId)
      : { document: null, message: false, text: '' };
  };
  const append = async (client: StreamsClient, body: Uint8Array) => {
    signal.throwIfAborted();
    const saved = await client.append({
      part: { contentType: 'application/octet-stream', body },
    });
    if (!saved.ok) throw writeError(saved.result.code);
  };
  const publishFlock = async (
    replica: { flock: Flock; client: StreamsClient },
    version: ReturnType<Flock['version']>,
  ) =>
    append(
      replica.client,
      encodeFrame(
        new TextEncoder().encode(
          JSON.stringify(replica.flock.exportJson(version)),
        ),
      ),
    );
  /** Doc first, then the Registry row: the publication is the execution gate. */
  const write = async (document: ScheduleDocument, create: boolean) => {
    const row = await buildScheduleRegistryRow(document);
    const { client, doc } = await openDoc(row.scheduleId, create);
    if (!doc) throw new Error('schedule_not_found');
    const before = doc.version();
    const mirror = new Mirror({
      doc,
      schema: scheduleDocSchema,
      ignoreUnknownProperties: true,
    });
    try {
      mirror.setState({
        ...document,
        message: { payload: undefined },
        definition: {
          ...document.definition,
          project: document.definition.project,
          messageVersion: document.definition.messageVersion,
        },
        timeline: document.timeline.map((entry) => ({
          ...entry,
          requesterSessionId: entry.requesterSessionId,
        })),
      } as never);
    } finally {
      mirror.dispose();
    }
    doc.commit();
    const update = doc.export({ mode: 'update', from: before });
    if (update.length) await append(client, encodeFrame(update));
    const replica = await registry(true);
    if (!replica) throw new Error('schedule_write_unknown');
    if (
      ScheduleTombstoneSchema.safeParse(
        replica.flock.get(scheduleRegistryKeys.tombstone(row.scheduleId)),
      ).success
    )
      throw new Error('schedule_deleted');
    const version = replica.flock.version();
    replica.flock.set(scheduleRegistryKeys.schedule(row.scheduleId), row);
    await publishFlock(replica, version);
  };
  return { registry, list, read, write, publishFlock };
}

function writeError(code: string) {
  return new Error(
    code === 'forbidden' ? 'schedule_not_owner' : 'schedule_write_unknown',
  );
}

export type ScheduleDraftInput = {
  title: string;
  prompt: string;
  machineId: string;
  agent: ScheduleAgent;
  project?: ScheduleProjectRef;
  destination: ScheduleDestination;
  trigger: ScheduleTrigger;
};

const DEFAULT_POLICIES = {
  misfirePolicy: { kind: 'run_once' as const },
  overlapPolicy: 'queue_one' as const,
  retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
};

/** The domain writes of web `ScheduleRepository`, over `scheduleStreams`. */
export function scheduleRepository(streams: ScheduleStreams) {
  const owned = async (scheduleId: string, actorId: string) => {
    const { rows } = await streams.list();
    const row = rows.find((entry) => entry.scheduleId === scheduleId);
    const read = await streams.read(scheduleId);
    if (read.message) throw new Error('schedule_message_read_only');
    if (!row || !read.document) throw new Error('schedule_not_found');
    if (row.ownerId !== actorId || read.document.definition.ownerId !== actorId)
      throw new Error('schedule_not_owner');
    return read.document;
  };

  const save = async (args: {
    scheduleId: string;
    draft: ScheduleDraftInput;
    actorId: string;
    now: number;
    activationId: string;
    activityId: string;
    create: boolean;
  }) => {
    if (
      !isScheduleIdentifier(args.scheduleId) ||
      !isScheduleIdentifier(args.activityId)
    )
      throw new Error('schedule_invalid');
    const title = args.draft.title.trim();
    if (!title || title.length > 200) throw new Error('schedule_title_invalid');
    let previous: ScheduleDocument | null;
    if (args.create) {
      const read = await streams.read(args.scheduleId);
      if (read.message) throw new Error('schedule_conflict');
      previous = read.document;
    } else previous = await owned(args.scheduleId, args.actorId);
    const incoming = {
      title,
      machineId: args.draft.machineId,
      trigger: ScheduleTriggerSchema.parse(args.draft.trigger),
      agent: args.draft.agent,
      project: args.draft.project,
      destination: args.draft.destination,
    };
    const prior = previous?.timeline.find(
      (entry) => entry.id === args.activityId,
    );
    if (prior && previous) {
      // Explicit retry of the same request completes a doc-first write.
      const d = previous.definition;
      const same =
        canonicalScheduleJson({
          title: d.title,
          machineId: d.machineId,
          trigger: d.trigger,
          agent: d.agent,
          project: d.project,
          destination: d.destination,
          prompt: previous.prompt,
        }) ===
        canonicalScheduleJson({ ...incoming, prompt: args.draft.prompt });
      if (
        prior.actorId !== args.actorId ||
        d.ownerId !== args.actorId ||
        prior.kind !== (args.create ? 'created' : 'edited') ||
        !same
      )
        throw new Error('schedule_conflict');
      await streams.write(previous, false);
      return previous;
    }
    if (args.create && previous) throw new Error('schedule_conflict');
    const definition: ScheduleDefinition = ScheduleDefinitionSchema.parse({
      ...(previous
        ? {
            misfirePolicy: previous.definition.misfirePolicy,
            overlapPolicy: previous.definition.overlapPolicy,
            retryPolicy: previous.definition.retryPolicy,
          }
        : DEFAULT_POLICIES),
      ...incoming,
      scheduleId: args.scheduleId,
      ownerId: args.actorId,
      enabled: previous?.definition.enabled ?? true,
      activationId: args.activationId,
      activeFrom: args.now,
      createdAt: previous?.definition.createdAt ?? args.now,
      createdBy: previous?.definition.createdBy ?? args.actorId,
      updatedAt: args.now,
    });
    const activity = ScheduleActivitySchema.parse({
      id: args.activityId,
      kind: previous ? 'edited' : 'created',
      actorId: args.actorId,
      createdAt: args.now,
    });
    const document: ScheduleDocument = {
      definition,
      prompt: args.draft.prompt,
      timeline: [...(previous?.timeline ?? []), activity],
    };
    await streams.write(document, args.create && !previous);
    return document;
  };

  const setEnabled = async (args: {
    scheduleId: string;
    enabled: boolean;
    actorId: string;
    now: number;
    activationId: string;
    requestId: string;
  }) => {
    if (!isScheduleIdentifier(args.requestId))
      throw new Error('schedule_invalid');
    const document = await owned(args.scheduleId, args.actorId);
    const kind = args.enabled ? 'resumed' : 'paused';
    const prior = document.timeline.find(
      (entry) => entry.id === args.requestId,
    );
    if (prior) {
      if (prior.kind !== kind || prior.actorId !== args.actorId)
        throw new Error('schedule_conflict');
      await streams.write(document, false);
      return;
    }
    document.definition = {
      ...document.definition,
      enabled: args.enabled,
      updatedAt: args.now,
      ...(args.enabled
        ? { activationId: args.activationId, activeFrom: args.now }
        : {}),
    };
    document.timeline.push(
      ScheduleActivitySchema.parse({
        id: args.requestId,
        kind,
        actorId: args.actorId,
        createdAt: args.now,
      }),
    );
    await streams.write(document, false);
  };

  /** Tombstone always wins; the definition is retained for history. */
  const remove = async (scheduleId: string, actorId: string, now: number) => {
    const replica = await streams.registry(false);
    if (!replica) throw new Error('schedule_not_found');
    const tombstone = ScheduleTombstoneSchema.safeParse(
      replica.flock.get(scheduleRegistryKeys.tombstone(scheduleId)),
    );
    if (tombstone.success) {
      if (tombstone.data.actorId !== actorId)
        throw new Error('schedule_not_owner');
      return;
    }
    const { rows } = readScheduleRegistry(replica.flock.scan());
    const row = rows.find((entry) => entry.scheduleId === scheduleId);
    if (!row) throw new Error('schedule_not_found');
    // Scheduled messages are deletable without parsing their payload.
    if (row.ownerId !== actorId) throw new Error('schedule_not_owner');
    const version = replica.flock.version();
    replica.flock.set(scheduleRegistryKeys.tombstone(scheduleId), {
      deletedAt: now,
      actorId,
    });
    await streams.publishFlock(replica, version);
  };

  const requestRun = async (args: {
    scheduleId: string;
    actorId: string;
    manualRunId: string;
    now: number;
  }) => {
    if (!isScheduleIdentifier(args.manualRunId))
      throw new Error('schedule_invalid');
    const document = await owned(args.scheduleId, args.actorId);
    const replica = await streams.registry(true);
    if (!replica) throw new Error('schedule_write_unknown');
    const key = scheduleRegistryKeys.manual(args.scheduleId, args.manualRunId);
    const request = {
      scheduleId: args.scheduleId,
      actorId: args.actorId,
      manualRunId: args.manualRunId,
      activationId: document.definition.activationId,
      requestedAt: args.now,
    };
    const existing = replica.flock.get(key);
    if (existing) {
      if (
        canonicalScheduleJson({ ...(existing as object), requestedAt: 0 }) !==
        canonicalScheduleJson({ ...request, requestedAt: 0 })
      )
        throw new Error('schedule_conflict');
      return;
    }
    const version = replica.flock.version();
    replica.flock.set(key, request);
    await streams.publishFlock(replica, version);
  };

  return { save, setEnabled, remove, requestRun, owned };
}
