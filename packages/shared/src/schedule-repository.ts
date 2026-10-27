import type { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

import type { WorkspaceId } from './ids';
import { scheduleDocSchema } from './schedule-schema';
import {
  buildScheduleRegistryRow,
  canonicalScheduleJson,
  getScheduleRegistryFlockDocId,
  getScheduleRoomId,
  readScheduleRegistryRows,
  scheduleRegistryKeys,
} from './schedule-registry';
import {
  DEFAULT_SCHEDULE_DESTINATION,
  SCHEDULED_MESSAGE_RETENTION_MS,
  ScheduleActivitySchema,
  ScheduleDefinitionSchema,
  ScheduleRuntimeRowSchema,
  ScheduleTriggerSchema,
  ScheduledMessageSchema,
  scheduledMessagePrompt,
  ScheduleTombstoneSchema,
  type ScheduleDefinition,
  type ScheduleDocument,
} from './schedule-types';

export type ScheduleDraft = Pick<
  ScheduleDefinition,
  | 'title'
  | 'machineId'
  | 'trigger'
  | 'misfirePolicy'
  | 'overlapPolicy'
  | 'agent'
  | 'project'
  | 'retryPolicy'
> & {
  prompt: string;
  message?: ScheduleDocument['message'];
  destination?: ScheduleDefinition['destination'];
};

export type ScheduleRepositoryPort = {
  openPersistedDoc: (id: string) => Promise<{ doc: unknown }>;
  openFlockDoc: (id: string) => Promise<{
    flock: {
      scan: () => Iterable<{ key: readonly unknown[]; value?: unknown }>;
      get: (key: string[]) => unknown;
      set: (key: string[], value: never) => unknown;
      delete?: (key: string[]) => unknown;
    };
  }>;
  flush: () => Promise<void>;
  /** Permanent local document removal; available on the owning CLI repo. */
  purgeDoc?: (id: string) => Promise<void>;
};

/**
 * A Schedule document from Mirror state, or `null` when it is not this
 * schedule's valid definition.
 *
 * Mirror tags the nested maps it hands back with their container id, `$cid`,
 * as an inherited key. `JSON.stringify` never shows it, but Zod's record parser
 * walks inherited keys and copies it into `agent.configOptionValues`. Left
 * there, the owning machine's fingerprint never matches the Registry's (every
 * schedule with Agent options stays blocked on `DEFINITION_NOT_COMMITTED`), and
 * re-saving would store `$cid` as an Agent option. Rebuilding plain own-key
 * objects before parsing drops it; every Mirror read of a Schedule goes here.
 */
export function scheduleDocumentFromMirrorState(
  state: {
    definition?: unknown;
    prompt: string;
    message?: { payload?: unknown };
    timeline: ScheduleDocument['timeline'];
  },
  scheduleId: string
): ScheduleDocument | null {
  const parsed = ScheduleDefinitionSchema.safeParse(withoutContainerIds(state.definition));
  if (!parsed.success || parsed.data.scheduleId !== scheduleId) return null;
  const message =
    state.message?.payload === undefined
      ? undefined
      : ScheduledMessageSchema.safeParse(withoutContainerIds(state.message.payload));
  if ((message && !message.success) || (parsed.data.messageVersion === 1 && !message?.success))
    return null;
  const timeline = withoutContainerIds(state.timeline) as ScheduleDocument['timeline'];
  const activities = new Set<string>();
  return {
    definition: parsed.data,
    // Complete messages are an atomic payload, not collaboratively appended text.
    // Concurrent creation can concatenate the legacy LoroText projection.
    prompt: message?.success ? scheduledMessagePrompt(message.data) : state.prompt,
    ...(message?.success ? { message: message.data } : {}),
    timeline: message?.success
      ? timeline.filter((entry) => {
          if (activities.has(entry.id)) return false;
          activities.add(entry.id);
          return true;
        })
      : timeline,
  };
}

function withoutContainerIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutContainerIds);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== CID_KEY)
      .map(([key, entry]) => [key, withoutContainerIds(entry)])
  );
}
const CID_KEY = '$cid';

/** Transport-neutral domain writes, shared by app and human CLI. */
export class ScheduleRepository {
  constructor(
    readonly repo: ScheduleRepositoryPort,
    readonly workspaceId: WorkspaceId
  ) {}

  async list() {
    const handle = await this.repo.openFlockDoc(getScheduleRegistryFlockDocId(this.workspaceId));
    return readScheduleRegistryRows(handle.flock.scan());
  }

  async read(scheduleId: string): Promise<ScheduleDocument | null> {
    const handle = await this.repo.openPersistedDoc(getScheduleRoomId(scheduleId));
    const raw = (handle.doc as LoroDoc).toJSON() as { definition?: unknown };
    if (!ScheduleDefinitionSchema.safeParse(raw.definition).success) return null;
    const mirror = new Mirror({
      doc: handle.doc as LoroDoc,
      schema: scheduleDocSchema,
      ignoreUnknownProperties: true,
    });
    try {
      return scheduleDocumentFromMirrorState(mirror.getState(), scheduleId);
    } finally {
      mirror.dispose();
    }
  }

  private async write(document: ScheduleDocument): Promise<void> {
    const row = buildScheduleRegistryRow(document);
    const handle = await this.repo.openPersistedDoc(getScheduleRoomId(row.scheduleId));
    const mirror = new Mirror({
      doc: handle.doc as LoroDoc,
      schema: scheduleDocSchema,
      ignoreUnknownProperties: true,
    });
    try {
      mirror.setState({
        ...document,
        message: { payload: document.message },
        // Spread `project` explicitly: it is optional on the definition but a
        // present (possibly undefined) key in the mirrored map.
        definition: {
          ...document.definition,
          project: document.definition.project,
          messageVersion: document.definition.messageVersion,
        },
        timeline: document.timeline.map((entry) => ({
          ...entry,
          requesterSessionId: entry.requesterSessionId,
        })),
      });
      await this.repo.flush();
      // This publication is the execution gate. An interrupted first flush
      // leaves an orphan definition; no discovery/repair may enable it.
      const registry = await this.repo.openFlockDoc(
        getScheduleRegistryFlockDocId(this.workspaceId)
      );
      if (
        ScheduleTombstoneSchema.safeParse(
          registry.flock.get(scheduleRegistryKeys.tombstone(row.scheduleId))
        ).success
      ) {
        throw new Error('Schedule was deleted');
      }
      registry.flock.set(scheduleRegistryKeys.schedule(row.scheduleId), row as never);
      await this.repo.flush();
    } finally {
      mirror.dispose();
    }
  }

  private async owned(scheduleId: string, actorId: string): Promise<ScheduleDocument> {
    const row = (await this.list()).find((entry) => entry.scheduleId === scheduleId);
    const document = await this.read(scheduleId);
    if (!row || !document) throw new Error('Schedule not found');
    if (row.ownerId !== actorId || document.definition.ownerId !== actorId)
      throw new Error('Only the Schedule owner can change it');
    return document;
  }

  async save(args: {
    scheduleId: string;
    draft: ScheduleDraft;
    actorId: string;
    now: number;
    activationId: string;
    activityId: string;
    create?: boolean;
  }): Promise<ScheduleDocument> {
    const previous = args.create
      ? await this.read(args.scheduleId)
      : await this.owned(args.scheduleId, args.actorId);
    // A draft may omit the destination; stored definitions never do, and the
    // idempotency comparison must see the same shape on both sides.
    const incoming: ScheduleDraft = {
      ...args.draft,
      title: args.draft.title.trim(),
      trigger: ScheduleTriggerSchema.parse(args.draft.trigger),
      ...(args.draft.message ? { message: ScheduledMessageSchema.parse(args.draft.message) } : {}),
      destination: args.draft.destination ?? DEFAULT_SCHEDULE_DESTINATION,
    };
    if (previous?.message && !incoming.message)
      throw new Error('A scheduled message cannot lose its payload');
    const prior = previous?.timeline.find((entry) => entry.id === args.activityId);
    if (prior) {
      const {
        title,
        machineId,
        trigger,
        misfirePolicy,
        overlapPolicy,
        agent,
        project,
        destination,
        retryPolicy,
      } = previous!.definition;
      const draft = {
        title,
        machineId,
        trigger,
        misfirePolicy,
        overlapPolicy,
        agent,
        project,
        destination,
        retryPolicy,
        prompt: previous!.prompt,
        ...(previous!.message ? { message: previous!.message } : {}),
      };
      if (
        prior.actorId !== args.actorId ||
        previous!.definition.ownerId !== args.actorId ||
        prior.kind !== (args.create ? 'created' : 'edited') ||
        canonicalScheduleJson(draft) !== canonicalScheduleJson(incoming)
      )
        throw new Error('Idempotency key conflict');
      // Explicit replay completes a doc-first write; discovery never publishes it.
      await this.write(previous!);
      return previous!;
    }
    if (args.create && previous) throw new Error('Schedule id already exists');
    const { prompt, message, ...draft } = incoming;
    const definition = ScheduleDefinitionSchema.parse({
      ...draft,
      ...(message ? { messageVersion: 1 } : {}),
      scheduleId: args.scheduleId,
      ownerId: args.actorId,
      enabled: previous?.definition.enabled ?? true,
      activationId: args.activationId,
      // The one-time slot is also its deterministic activation floor. Devices
      // creating the same reservation must not fingerprint their local clocks.
      activeFrom:
        message && draft.trigger.kind === 'once' ? Date.parse(draft.trigger.at) : args.now,
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
    const document = {
      definition,
      prompt,
      ...(message ? { message } : {}),
      timeline: [...(previous?.timeline ?? []), activity],
    };
    await this.write(document);
    return document;
  }

  async setEnabled(args: {
    scheduleId: string;
    enabled: boolean;
    actorId: string;
    now: number;
    activationId: string;
    requestId: string;
    requesterSessionId?: string;
  }): Promise<void> {
    const document = await this.owned(args.scheduleId, args.actorId);
    const prior = document.timeline.find((entry) => entry.id === args.requestId);
    const kind = args.enabled ? 'resumed' : 'paused';
    if (prior) {
      if (
        prior.kind !== kind ||
        prior.actorId !== args.actorId ||
        prior.requesterSessionId !== args.requesterSessionId
      )
        throw new Error('Idempotency key conflict');
      await this.write(document);
      return;
    }
    document.definition = {
      ...document.definition,
      enabled: args.enabled,
      updatedAt: args.now,
      ...(args.enabled ? { activationId: args.activationId, activeFrom: args.now } : {}),
    };
    document.timeline.push(
      ScheduleActivitySchema.parse({
        id: args.requestId,
        requesterSessionId: args.requesterSessionId,
        kind,
        actorId: args.actorId,
        createdAt: args.now,
      })
    );
    await this.write(document);
  }

  /**
   * Purge terminal one-time message definitions after their quiet period.
   *
   * Retention starts at the owner's terminal runtime projection, not creation,
   * so editing or a delayed restart cannot shorten the visible history. The
   * document is removed before its Registry row so a busy or failed purge is
   * retried on the next evaluation instead of hiding the only retry handle.
   */
  async pruneExpiredMessages(args: {
    now: number;
    ownerId: string;
    machineId: string;
    retentionMs?: number;
  }): Promise<string[]> {
    const purgeDoc = this.repo.purgeDoc?.bind(this.repo);
    if (!purgeDoc) return [];
    const registry = await this.repo.openFlockDoc(getScheduleRegistryFlockDocId(this.workspaceId));
    if (!registry.flock.delete) return [];
    const remove = (key: string[]) => registry.flock.delete?.(key);
    const retentionMs = args.retentionMs ?? SCHEDULED_MESSAGE_RETENTION_MS;
    if (!Number.isFinite(retentionMs) || retentionMs < 0)
      throw new Error('Invalid scheduled message retention');
    const purged: string[] = [];
    for (const row of readScheduleRegistryRows(registry.flock.scan())) {
      if (!row.scheduledMessage || row.ownerId !== args.ownerId || row.machineId !== args.machineId)
        continue;
      const runtime = ScheduleRuntimeRowSchema.safeParse(
        registry.flock.get(scheduleRegistryKeys.runtime(row.scheduleId, row.machineId))
      );
      if (!runtime.success || runtime.data.activationId !== row.activationId) continue;
      if (
        runtime.data.messageState !== 'sent' &&
        runtime.data.messageState !== 'cancelled' &&
        runtime.data.messageState !== 'failed'
      )
        continue;
      if (args.now - runtime.data.updatedAt < retentionMs) continue;
      try {
        await purgeDoc(getScheduleRoomId(row.scheduleId));
      } catch {
        // A live detail view or in-flight sync keeps the doc leased. Keep the
        // row and retry after the lease clears.
        continue;
      }
      registry.flock.set(scheduleRegistryKeys.tombstone(row.scheduleId), {
        deletedAt: args.now,
        actorId: args.ownerId,
      } as never);
      remove(scheduleRegistryKeys.schedule(row.scheduleId));
      for (const entry of registry.flock.scan()) {
        if (
          (entry.key[0] === 'runtime' || entry.key[0] === 'manual') &&
          entry.key[1] === row.scheduleId
        )
          remove(entry.key.map(String));
      }
      await this.repo.flush();
      purged.push(row.scheduleId);
    }
    return purged;
  }

  async delete(scheduleId: string, actorId: string, now: number): Promise<void> {
    const registry = await this.repo.openFlockDoc(getScheduleRegistryFlockDocId(this.workspaceId));
    const tombstone = ScheduleTombstoneSchema.safeParse(
      registry.flock.get(scheduleRegistryKeys.tombstone(scheduleId))
    );
    if (tombstone.success) {
      if (tombstone.data.actorId !== actorId)
        throw new Error('Only the Schedule owner can delete it');
      return;
    }
    await this.owned(scheduleId, actorId);
    registry.flock.set(scheduleRegistryKeys.tombstone(scheduleId), {
      deletedAt: now,
      actorId,
    } as never);
    await this.repo.flush();
    // Retain definition for export/history. Tombstone always wins, including
    // against stale edits from an offline device.
  }

  async requestRun(args: {
    scheduleId: string;
    actorId: string;
    manualRunId: string;
    now: number;
  }): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(args.manualRunId)) throw new Error('Invalid manual run id');
    const document = await this.owned(args.scheduleId, args.actorId);
    const registry = await this.repo.openFlockDoc(getScheduleRegistryFlockDocId(this.workspaceId));
    const key = scheduleRegistryKeys.manual(args.scheduleId, args.manualRunId);
    const request = {
      scheduleId: args.scheduleId,
      actorId: args.actorId,
      manualRunId: args.manualRunId,
      activationId: document.definition.activationId,
      requestedAt: args.now,
    };
    const existing = registry.flock.get(key);
    if (existing) {
      const prior = existing as unknown as typeof request;
      if (
        canonicalScheduleJson({ ...prior, requestedAt: 0 }) !==
        canonicalScheduleJson({ ...request, requestedAt: 0 })
      )
        throw new Error('Idempotency key conflict');
      return;
    }
    registry.flock.set(key, request as never);
    await this.repo.flush();
  }
}
