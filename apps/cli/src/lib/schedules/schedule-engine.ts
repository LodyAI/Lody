import {
  scheduleDefinitionFingerprint,
  type ScheduleDocument,
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
} from '@lody/shared';
import type { AgentExecutionSlots } from '../agent-execution-slots';
import type { ScheduleRun, ScheduleStore } from './schedule-store';

export class ScheduleConfigurationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ScheduleConfigurationError';
    this.code = code;
  }
}

export type ScheduleEnginePorts<Prepared> = {
  workspaceId: string;
  machineId: string;
  userId: string;
  store: ScheduleStore<Prepared>;
  slots: AgentExecutionSlots;
  now: () => number;
  disabled: () => boolean;
  ready: () => boolean;
  list: () => Promise<ScheduleRegistryRow[]>;
  read: (scheduleId: string) => Promise<ScheduleDocument | null>;
  validateTarget: (run: ScheduleRun<Prepared>) => Promise<void>;
  prepare: (run: ScheduleRun<Prepared>) => Promise<Prepared>;
  materialize: (prepared: Prepared) => Promise<void>;
  isDispatched: (prepared: Prepared) => Promise<boolean>;
  dispatch: (prepared: Prepared) => Promise<void>;
  isFinished: (run: ScheduleRun<Prepared>) => Promise<boolean>;
  publish: (runtime: ScheduleRuntimeRow) => Promise<void>;
  onError: (error: unknown) => void;
  onEvent?: (event: {
    type: string;
    scheduleId: string;
    runKey?: string;
    code?: string;
    scheduledFor?: number;
  }) => void;
};

/** One serialized worker per Host/workspace, woken by time and local facts. */
export class ScheduleEngine<Prepared> {
  private active: Promise<void> | undefined;
  private dirty = false;
  private stopped = false;
  private readonly projections = new Map<string, ScheduleRuntimeRow>();
  constructor(private readonly ports: ScheduleEnginePorts<Prepared>) {}

  restoreOccupancy(): void {
    for (const run of this.ports.store.unfinished(this.ports.workspaceId)) {
      if (run.state === 'claimed' || run.state === 'session_prepared' || run.state === 'dispatched')
        this.ports.slots.restore(run.agentConfigId, run.runKey);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.active;
  }
  evaluate(): Promise<void> {
    this.dirty = true;
    if (!this.active)
      this.active = this.drain().finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  private async drain(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      this.projections.clear();
      try {
        await this.pass();
        for (const runtime of this.projections.values()) await this.ports.publish(runtime);
      } catch (error) {
        this.ports.onError(error);
      }
    }
  }
  private owned(row: ScheduleRegistryRow): boolean {
    return row.ownerId === this.ports.userId && row.machineId === this.ports.machineId;
  }
  private async pass(): Promise<void> {
    const p = this.ports;
    // Accepted Sessions recover even when scheduling is disabled or the cloud
    // is unavailable. The ordinary watcher owns their execution now.
    for (const run of p.store.unfinished(p.workspaceId)) {
      if (
        run.prepared !== undefined &&
        run.state !== 'dispatched' &&
        (await p.isDispatched(run.prepared))
      ) {
        p.store.transition(run.runKey, [run.state], { state: 'dispatched' });
        p.onEvent?.({ type: 'recovered', scheduleId: run.scheduleId, runKey: run.runKey });
      }
      const current = p.store.get(run.runKey)!;
      if (current.state === 'dispatched' && (await p.isFinished(current))) {
        p.store.transition(current.runKey, ['dispatched'], { state: 'finished' });
        p.onEvent?.({ type: 'finished', scheduleId: run.scheduleId, runKey: run.runKey });
        p.slots.release(current.agentConfigId, current.runKey);
      }
    }
    if (!p.ready() || p.disabled()) {
      // Restored preparation reserves only until durable dispatch evidence has
      // been reconciled. Parked work must not block unrelated automation.
      for (const run of p.store.unfinished(p.workspaceId))
        if (run.state !== 'dispatched') p.slots.release(run.agentConfigId, run.runKey);
      if (!p.ready()) return;
    }
    const now = p.now();
    const rows = await p.list();
    if (p.disabled()) {
      for (const row of rows)
        if (this.owned(row))
          await this.project(row, { queueState: 'blocked', blockedCode: 'SCHEDULES_DISABLED' });
      return;
    }
    for (const row of rows) {
      if (!this.owned(row) || !row.enabled) continue;
      try {
        const last = p.store.history(p.workspaceId, row.scheduleId, 1)[0];
        if (last?.activationId === row.activationId && last.state === 'failed')
          await this.project(row, { queueState: 'blocked', blockedCode: last.errorCode });
        const cursor = p.store.planningState(p.workspaceId, row.scheduleId, row.activationId);
        if (
          cursor?.fingerprint === row.definitionFingerprint &&
          (cursor.nextSlot === null || cursor.nextSlot > now)
        ) {
          await this.project(row, { nextScheduledAt: cursor.nextSlot ?? undefined });
          continue;
        }
        const document = await p.read(row.scheduleId);
        if (!document || scheduleDefinitionFingerprint(document) !== row.definitionFingerprint) {
          await this.project(row, {
            queueState: 'blocked',
            blockedCode: 'DEFINITION_NOT_COMMITTED',
          });
          continue;
        }
        const evaluation = p.store.plan(p.workspaceId, document, row.definitionFingerprint, now);
        if (evaluation.due)
          p.onEvent?.({
            type: 'planned',
            scheduleId: row.scheduleId,
            scheduledFor: evaluation.due.scheduledFor,
            code: evaluation.due.disposition,
          });
        await this.project(row, { nextScheduledAt: evaluation.nextScheduledAt });
      } catch (error) {
        await this.project(row, { queueState: 'blocked', blockedCode: 'DEFINITION_UNAVAILABLE' });
        p.onError(error);
      }
    }
    for (const run of p.store.unfinished(p.workspaceId)) {
      if (run.state === 'dispatched') continue;
      // Never hold the last known enabled value across awaits in the create
      // path. Re-read the local authoritative gate at each handoff attempt.
      const row = (await p.list()).find((entry) => entry.scheduleId === run.scheduleId);
      if (
        !row ||
        !this.owned(row) ||
        (!row.enabled && !run.manual) ||
        row.activationId !== run.activationId ||
        row.definitionFingerprint !== run.definitionFingerprint
      ) {
        this.skip(run, 'ACTIVATION_REVOKED');
        continue;
      }
      if (now - run.plannedAt >= run.definition.retryPolicy.dispatchMaxAgeMs) {
        this.skip(run, 'DISPATCH_EXPIRED');
        continue;
      }
      if (run.retryAt !== undefined && run.retryAt > now) {
        await this.project(row, {
          queueState: run.errorCode === 'DISPATCH_UNAVAILABLE' ? 'retrying' : 'blocked',
          blockedCode: run.errorCode,
        });
        continue;
      }
      const others = p.store
        .unfinished(p.workspaceId)
        .some(
          (other) =>
            other.scheduleId === run.scheduleId &&
            other.runKey !== run.runKey &&
            !other.manual &&
            other.state !== 'pending'
        );
      if (!run.manual && (others || !p.slots.reserve(run.agentConfigId, run.runKey))) {
        await this.project(row, { queueState: 'waiting_for_agent' });
        continue;
      }
      if (run.manual) p.slots.restore(run.agentConfigId, run.runKey);
      try {
        let current = p.store.transition(run.runKey, [run.state], {
          state: 'claimed',
          attempts: run.attempts + 1,
          retryAt: undefined,
        });
        if (current.prepared === undefined) {
          const prepared = await p.prepare(current);
          current = p.store.transition(run.runKey, ['claimed'], { prepared });
        }
        await p.materialize(current.prepared!);
        p.store.transition(run.runKey, ['claimed'], { state: 'session_prepared' });
        const latest = (await p.list()).find((entry) => entry.scheduleId === run.scheduleId);
        const document = await p.read(run.scheduleId);
        if (!p.ready() || p.disabled()) {
          p.slots.release(run.agentConfigId, run.runKey);
          continue;
        }
        if (
          !latest ||
          !this.owned(latest) ||
          (!latest.enabled && !run.manual) ||
          latest.activationId !== run.activationId ||
          latest.definitionFingerprint !== run.definitionFingerprint ||
          !document ||
          scheduleDefinitionFingerprint(document) !== run.definitionFingerprint
        ) {
          this.skip(p.store.get(run.runKey)!, 'ACTIVATION_REVOKED');
          continue;
        }
        if (p.now() - run.plannedAt >= run.definition.retryPolicy.dispatchMaxAgeMs) {
          this.skip(p.store.get(run.runKey)!, 'DISPATCH_EXPIRED');
          continue;
        }
        await p.validateTarget(current);
        // Validation may await local reads; close the authorization window again.
        const gate = (await p.list()).find((entry) => entry.scheduleId === run.scheduleId);
        if (!p.ready() || p.disabled()) {
          p.slots.release(run.agentConfigId, run.runKey);
          continue;
        }
        if (
          !gate ||
          !this.owned(gate) ||
          (!gate.enabled && !run.manual) ||
          gate.activationId !== run.activationId ||
          gate.definitionFingerprint !== run.definitionFingerprint
        ) {
          this.skip(p.store.get(run.runKey)!, 'ACTIVATION_REVOKED');
          continue;
        }
        await p.dispatch(current.prepared!);
        p.store.transition(run.runKey, ['session_prepared'], { state: 'dispatched' });
        p.onEvent?.({ type: 'dispatched', scheduleId: run.scheduleId, runKey: run.runKey });
        await this.project(row, {
          lastDispatch: {
            scheduledFor: run.scheduledFor,
            dispatchedAt: p.now(),
            sessionId: run.sessionId,
          },
        });
      } catch (error) {
        // A transport acknowledgement can fail after the pointer was committed.
        // Inspect durable evidence before assigning any Schedule retry.
        const current = p.store.get(run.runKey)!;
        if (current.prepared !== undefined && (await p.isDispatched(current.prepared))) {
          if (current.state !== 'dispatched')
            p.store.transition(run.runKey, [current.state], { state: 'dispatched' });
        } else {
          const code =
            error instanceof ScheduleConfigurationError ? error.code : 'DISPATCH_UNAVAILABLE';
          if (error instanceof ScheduleConfigurationError)
            p.store.transition(run.runKey, [current.state], {
              state: 'retry_wait',
              attempts: run.attempts,
              retryAt: p.now() + 30_000,
              errorCode: code,
            });
          else p.store.failAttempt(run.runKey, code, p.now());
          p.onEvent?.({ type: 'blocked', scheduleId: run.scheduleId, runKey: run.runKey, code });
          p.slots.release(run.agentConfigId, run.runKey);
          await this.project(row, {
            queueState:
              error instanceof ScheduleConfigurationError ||
              p.store.get(run.runKey)?.state === 'failed'
                ? 'blocked'
                : 'retrying',
            blockedCode: code,
          });
        }
        p.onError(error);
      }
    }
  }

  private skip(run: ScheduleRun<Prepared>, code: string): void {
    this.ports.store.transition(run.runKey, [run.state], { state: 'skipped', errorCode: code });
    this.ports.onEvent?.({ type: 'skipped', scheduleId: run.scheduleId, runKey: run.runKey, code });
    this.ports.slots.release(run.agentConfigId, run.runKey);
  }
  private async project(
    row: ScheduleRegistryRow,
    projection: Partial<ScheduleRuntimeRow>
  ): Promise<void> {
    this.projections.set(row.scheduleId, {
      scheduleId: row.scheduleId,
      machineId: this.ports.machineId,
      activationId: row.activationId,
      observedDefinitionFingerprint: row.definitionFingerprint,
      updatedAt: this.ports.now(),
      ...this.projections.get(row.scheduleId),
      ...projection,
    });
  }
}
