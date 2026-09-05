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
  ScheduleActivitySchema,
  ScheduleDefinitionSchema,
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
> & { prompt: string };

export type ScheduleRepositoryPort = {
  openPersistedDoc: (id: string) => Promise<{ doc: unknown }>;
  openFlockDoc: (id: string) => Promise<{
    flock: {
      scan: () => Iterable<{ key: readonly unknown[]; value?: unknown }>;
      get: (key: string[]) => unknown;
      set: (key: string[], value: never) => unknown;
    };
  }>;
  flush: () => Promise<void>;
};

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
      const state = mirror.getState();
      const parsed = ScheduleDefinitionSchema.safeParse(state.definition);
      if (!parsed.success || parsed.data.scheduleId !== scheduleId) return null;
      return { definition: parsed.data, prompt: state.prompt, timeline: state.timeline };
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
        retryPolicy,
        prompt: previous!.prompt,
      };
      if (
        prior.actorId !== args.actorId ||
        previous!.definition.ownerId !== args.actorId ||
        prior.kind !== (args.create ? 'created' : 'edited') ||
        canonicalScheduleJson(draft) !== canonicalScheduleJson(args.draft)
      )
        throw new Error('Idempotency key conflict');
      // Explicit replay completes a doc-first write; discovery never publishes it.
      await this.write(previous!);
      return previous!;
    }
    if (args.create && previous) throw new Error('Schedule id already exists');
    const { prompt, ...draft } = args.draft;
    const definition = ScheduleDefinitionSchema.parse({
      ...draft,
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
    const document = { definition, prompt, timeline: [...(previous?.timeline ?? []), activity] };
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
