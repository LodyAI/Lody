import { createLegacyScheduleRegistry, type ScheduleRegistryPort } from './schedule-registry-port';
import { readScheduleAuthorization, recordScheduleAuthorization } from './schedule-authorization';
import type { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { z } from 'zod';

import type { WorkspaceId } from './ids';
import { scheduleDocSchema } from './schedule-schema';
import {
  buildScheduleRegistryRow,
  canonicalScheduleJson,
  getScheduleRoomId,
  manualScheduleRunKey,
  scheduleDefinitionFingerprint,
} from './schedule-registry';
import {
  DEFAULT_SCHEDULE_DESTINATION,
  SCHEDULED_MESSAGE_RETENTION_MS,
  ScheduleActivitySchema,
  ScheduleDefinitionSchema,
  ScheduleTriggerSchema,
  ScheduledMessageSchema,
  scheduledMessagePrompt,
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
  const parsed = ScheduleDefinitionSchema.safeParse(
    projectStoredScheduleFields(ScheduleDefinitionSchema, withoutContainerIds(state.definition))
  );
  if (!parsed.success || parsed.data.scheduleId !== scheduleId) return null;
  const message =
    state.message?.payload === undefined
      ? undefined
      : ScheduledMessageSchema.safeParse(
          projectStoredScheduleFields(
            ScheduledMessageSchema,
            withoutContainerIds(state.message.payload)
          )
        );
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

/** Read only the fields understood by this version, while storage retains the
 * original value. Input validation stays strict; this is never a write sanitizer. */
export function projectStoredScheduleFields(schema: z.core.$ZodType, value: unknown): unknown {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return projectStoredScheduleFields(schema.unwrap(), value);
  if (schema instanceof z.ZodPipe) return projectStoredScheduleFields(schema.in, value);
  if (
    schema instanceof z.ZodObject &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.shape))
      if (Object.hasOwn(value, key))
        result[key] = projectStoredScheduleFields(
          child as z.core.$ZodType,
          Reflect.get(value, key)
        );
    return result;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value))
    return value.map((entry) => projectStoredScheduleFields(schema.element, entry));
  if (schema instanceof z.ZodRecord && value && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        projectStoredScheduleFields(schema.valueType, entry),
      ])
    );
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) {
      const projected = projectStoredScheduleFields(option as z.core.$ZodType, value);
      if (z.safeParse(option as z.core.$ZodType, projected).success) return projected;
    }
  }
  return value;
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

export type ScheduleSaveInput = {
  scheduleId: string;
  draft: ScheduleDraft;
  actorId: string;
  now: number;
  activationId: string;
  activityId: string;
  create?: boolean;
};

/** Shared save/idempotency policy. Storage owners perform their guarded write after this pure plan. */
export function prepareScheduleSave(
  args: ScheduleSaveInput,
  previous: ScheduleDocument | null
): ScheduleDocument {
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
    activeFrom: message && draft.trigger.kind === 'once' ? Date.parse(draft.trigger.at) : args.now,
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
  return document;
}

export type ScheduleEnabledInput = {
  scheduleId: string;
  enabled: boolean;
  actorId: string;
  now: number;
  activationId: string;
  requestId: string;
  requesterSessionId?: string;
};

/** Guarded enable/pause planning, including replay that cannot undo a later resume. */
export function prepareScheduleEnabled(
  previous: ScheduleDocument,
  args: ScheduleEnabledInput
): { document: ScheduleDocument; write: boolean } {
  const document = structuredClone(previous);
  const prior = document.timeline.find((entry) => entry.id === args.requestId);
  const kind = args.enabled ? 'resumed' : 'paused';
  if (prior) {
    if (
      prior.kind !== kind ||
      prior.actorId !== args.actorId ||
      prior.requesterSessionId !== args.requesterSessionId
    )
      throw new Error('Idempotency key conflict');
    // An old pause retry must never undo a later human resume.
    if (!args.enabled && document.definition.enabled) return { document, write: false };
    return { document, write: true };
  }
  document.definition = {
    ...document.definition,
    enabled: args.enabled,
    updatedAt: args.now,
    activationId: args.activationId,
    ...(args.enabled ? { activeFrom: args.now } : {}),
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
  return { document, write: true };
}

/** A complete definition owner. Returning undefined is a positive legacy route;
 * selected/frozen/unavailable rooms must reject instead of reopening the old Doc. */
export type ScheduleDefinitionPort = {
  read(): Promise<ScheduleDocument | null>;
  save(args: ScheduleSaveInput): Promise<ScheduleDocument>;
  setEnabled(args: ScheduleEnabledInput): Promise<void>;
  /** Optional permanent removal must also retain the native route tombstone. */
  purge?(input: import('./schedule-registry-port').ScheduleRetentionRequest): Promise<void>;
};
export type ScheduleDefinitionResolver = {
  recoverRetention?(actorId: string, machineId: string): Promise<void>;
  /** Explicit native creation before admitting a legacy operation. Undefined
   * means the trusted composition positively selected the legacy create path. */
  create?(input: ScheduleSaveInput): Promise<ScheduleDocument | undefined>;
  resolve(scheduleId: string): Promise<ScheduleDefinitionPort | undefined>;
  /** Own the complete business operation, including doc durability and its SR
   * publication, so a room freeze cannot finish between those two commits. */
  runOperation?<A>(scheduleId: string, work: () => Promise<A>): Promise<A>;
};

/** Transport-neutral domain writes, shared by app and human CLI. */
export class ScheduleRepository {
  readonly registry: ScheduleRegistryPort;
  constructor(
    readonly repo: ScheduleRepositoryPort,
    readonly workspaceId: WorkspaceId,
    private readonly options: {
      registry?: ScheduleRegistryPort;
      definitions?: ScheduleDefinitionResolver;
      protectedContent?: boolean;
      /** Encrypted only: this device's signed declaration for a definition or manual run. */
      signDeclaration?: (
        document: Pick<ScheduleDocument, 'definition' | 'prompt' | 'message'>,
        manualRunKey?: string
      ) => Promise<string>;
    } = {}
  ) {
    this.registry = options.registry ?? createLegacyScheduleRegistry({ repo, workspaceId });
    if (this.registry.workspaceId !== workspaceId)
      throw new Error('Schedule registry binding mismatch');
  }

  async list() {
    return (await this.registry.read()).schedules;
  }

  private async definition(scheduleId: string) {
    const native = await this.options.definitions?.resolve(scheduleId);
    if (native && this.options.protectedContent)
      throw new Error('Native Schedule definitions require plaintext ownership');
    return native;
  }

  private runDefinitionOperation<A>(scheduleId: string, work: () => Promise<A>): Promise<A> {
    try {
      return this.options.definitions?.runOperation?.(scheduleId, work) ?? work();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  read(scheduleId: string): Promise<ScheduleDocument | null> {
    return this.runDefinitionOperation(scheduleId, () => this.readDefinition(scheduleId));
  }
  private async readDefinition(scheduleId: string): Promise<ScheduleDocument | null> {
    const native = await this.definition(scheduleId);
    if (native) return native.read();
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

  /** Encrypted declarations are signed before anything is written. */
  private async declaration(document: ScheduleDocument, manualRunKey?: string) {
    if (!this.options.protectedContent) return undefined;
    if (!this.options.signDeclaration) throw new Error('e2ee_signature_unavailable');
    return await this.options.signDeclaration(document, manualRunKey);
  }

  private async write(document: ScheduleDocument, pause = false): Promise<void> {
    if (pause && document.definition.enabled)
      throw new Error('Schedule pause must disable execution');
    const row = buildScheduleRegistryRow(document);
    const e2eeIntent = pause ? undefined : await this.declaration(document);
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
      if (this.options.protectedContent && !pause)
        recordScheduleAuthorization(handle.doc as LoroDoc, document, undefined, e2eeIntent);
      await this.repo.flush();
      // This publication is the execution gate. An interrupted first flush
      // leaves an orphan definition; no discovery/repair may enable it.
      await this.registry.execute({ kind: 'publish', row });
      await this.registry.flush();
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

  async save(args: ScheduleSaveInput): Promise<ScheduleDocument> {
    if (args.create && !this.options.protectedContent && this.options.definitions?.create) {
      const native = await this.options.definitions.create(args);
      if (native) return native;
    }
    return this.runDefinitionOperation(args.scheduleId, () => this.saveDefinition(args));
  }
  private async saveDefinition(args: ScheduleSaveInput): Promise<ScheduleDocument> {
    const native = await this.definition(args.scheduleId);
    if (native) return native.save(args);
    const previous = args.create
      ? await this.read(args.scheduleId)
      : await this.owned(args.scheduleId, args.actorId);
    const document = prepareScheduleSave(args, previous);
    await this.write(document);
    return document;
  }

  setEnabled(args: ScheduleEnabledInput): Promise<void> {
    return this.runDefinitionOperation(args.scheduleId, () => this.setDefinitionEnabled(args));
  }
  private async setDefinitionEnabled(args: ScheduleEnabledInput): Promise<void> {
    const native = await this.definition(args.scheduleId);
    if (native) return native.setEnabled(args);
    const document = await this.owned(args.scheduleId, args.actorId);
    const prepared = prepareScheduleEnabled(document, args);
    if (prepared.write) await this.write(prepared.document, !args.enabled);
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
    let recoveryError: unknown;
    try {
      await this.options.definitions?.recoverRetention?.(args.ownerId, args.machineId);
    } catch (error) {
      recoveryError = error;
    }
    const snapshot = await this.registry.read();
    const retentionMs = args.retentionMs ?? SCHEDULED_MESSAGE_RETENTION_MS;
    if (!Number.isFinite(retentionMs) || retentionMs < 0)
      throw new Error('Invalid scheduled message retention');
    const purged: string[] = [];
    for (const row of snapshot.schedules) {
      if (!row.scheduledMessage || row.ownerId !== args.ownerId || row.machineId !== args.machineId)
        continue;
      const runtime = snapshot.runtimes.find(
        (entry) => entry.scheduleId === row.scheduleId && entry.machineId === row.machineId
      );
      if (
        !runtime ||
        runtime.activationId !== row.activationId ||
        !['sent', 'cancelled', 'failed'].includes(runtime.messageState ?? '') ||
        args.now - runtime.updatedAt < retentionMs
      )
        continue;
      try {
        const completed = await this.runDefinitionOperation(row.scheduleId, async () => {
          const request = {
            actorId: args.ownerId,
            machineId: args.machineId,
            activationId: row.activationId,
            runtimeUpdatedAt: runtime.updatedAt,
            now: args.now,
            retentionMs,
          };
          const native = await this.definition(row.scheduleId);
          if (native) {
            if (!native.purge) return false;
            // Native retention owns its durable execution tombstone, body
            // removal and final Registry cleanup; no old body is touched.
            await native.purge(request);
            return true;
          }
          if (!purgeDoc) return false;
          await purgeDoc(getScheduleRoomId(row.scheduleId));
          const result = await this.registry.execute({
            kind: 'prune',
            scheduleId: row.scheduleId,
            ...request,
          });
          await this.registry.flush();
          return result.changed;
        });
        if (completed) purged.push(row.scheduleId);
      } catch {
        continue;
      }
    }
    if (recoveryError) throw recoveryError;
    return purged;
  }

  delete(scheduleId: string, actorId: string, now: number): Promise<void> {
    return this.runDefinitionOperation(scheduleId, () =>
      this.deleteDefinition(scheduleId, actorId, now)
    );
  }
  private async deleteDefinition(scheduleId: string, actorId: string, now: number): Promise<void> {
    const tombstone = (await this.registry.read()).tombstones.find(
      (entry) => entry.scheduleId === scheduleId
    );
    if (tombstone) {
      if (tombstone.actorId !== actorId) throw new Error('Only the Schedule owner can delete it');
      return;
    }
    await this.owned(scheduleId, actorId);
    await this.registry.execute({ kind: 'tombstone', scheduleId, actorId, now });
    await this.registry.flush();
    // Retain definition for export/history. Tombstone always wins, including
    // against stale edits from an offline device.
  }

  requestRun(args: {
    scheduleId: string;
    actorId: string;
    manualRunId: string;
    now: number;
  }): Promise<void> {
    return this.runDefinitionOperation(args.scheduleId, () => this.requestDefinitionRun(args));
  }
  private async requestDefinitionRun(args: {
    scheduleId: string;
    actorId: string;
    manualRunId: string;
    now: number;
  }): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(args.manualRunId)) throw new Error('Invalid manual run id');
    const document = await this.owned(args.scheduleId, args.actorId);
    const snapshot = await this.registry.read();
    const request = {
      scheduleId: args.scheduleId,
      actorId: args.actorId,
      manualRunId: args.manualRunId,
      activationId: document.definition.activationId,
      requestedAt: args.now,
    };
    const existing = snapshot.manuals.find(
      (entry) => entry.scheduleId === args.scheduleId && entry.manualRunId === args.manualRunId
    );
    if (existing) {
      const prior = existing as unknown as typeof request;
      if (
        canonicalScheduleJson({ ...prior, requestedAt: 0 }) !==
        canonicalScheduleJson({ ...request, requestedAt: 0 })
      )
        throw new Error('Idempotency key conflict');
      return;
    }
    if (this.options.protectedContent) {
      const manualRunKey = manualScheduleRunKey(args.scheduleId, args.manualRunId);
      const handle = await this.repo.openPersistedDoc(getScheduleRoomId(args.scheduleId));
      const latest = readScheduleAuthorization(handle.doc as LoroDoc)?.value as
        | { definitionFingerprint?: unknown }
        | undefined;
      // Pause retains its old declaration. A deliberate manual run endorses the
      // current paused definition without enabling automatic scheduling.
      const definitionIntent =
        latest?.definitionFingerprint !== scheduleDefinitionFingerprint(document)
          ? await this.declaration(document)
          : undefined;
      const e2eeIntent = await this.declaration(document, manualRunKey);
      // Obtain both signatures before appending either declaration.
      if (definitionIntent !== undefined)
        recordScheduleAuthorization(handle.doc as LoroDoc, document, undefined, definitionIntent);
      recordScheduleAuthorization(handle.doc as LoroDoc, document, manualRunKey, e2eeIntent);
      await this.repo.flush();
    }
    await this.registry.execute({ kind: 'request-run', request });
    await this.registry.flush();
  }
}
