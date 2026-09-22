import type { Divergence } from './replay';
import type { LabRuntime } from './runtime';
import { canPermitEvent, type LabEvent } from './scheduler';
import { choiceKey, eventIdentity, type ScheduleChoice } from './schedule';

export interface DriverOptions {
  readonly maxSteps?: number;
  readonly watchdogMs?: number;
}

const DEFAULT_MAX_STEPS = 100_000;
const DEFAULT_WATCHDOG_MS = 180_000;

/**
 * Recorded-choice driver. Live recording uses the deterministic rule "oldest
 * requested runnable event" (`permitNext`) and logs every permit. Replay
 * permits only the next recorded identity. Unlimited drain is not used.
 *
 * Logical `maxSteps` bounds permits+ticks. `watchdogMs` is wall-clock only
 * and exists to abort a hung executor, not to schedule protocol events.
 */
export class ScheduleDriver {
  private index = 0;
  private permits = 0;
  private readonly startedMs = Date.now();
  private divergence: Divergence | null = null;
  private failed: Error | null = null;
  private readonly fulfilled = new Set<number>();

  constructor(
    private readonly runtime: LabRuntime,
    private readonly recorded: readonly ScheduleChoice[] | 'record',
    private readonly options: DriverOptions = {}
  ) {}

  logicalSteps(): number {
    return this.permits;
  }

  firstDivergence(): Divergence | null {
    return this.divergence;
  }

  async drive<T>(work: Promise<T>): Promise<T> {
    const pump = setInterval(() => this.tickSafe(), 0);
    const outcome = await work
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
      .finally(() => {
        clearInterval(pump);
        this.tickSafe();
      });
    // Preserve the scheduler's failure priority explicitly, not via a throw in finally.
    if (this.failed) throw this.failed;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private tickSafe(): void {
    if (this.failed) return;
    try {
      this.tick();
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error));
      this.runtime.close();
    }
  }

  leftoverDivergence(): Divergence | null {
    if (this.divergence) return this.divergence;
    const leftover = this.runtime.events().filter((event) => event.status === 'requested');
    if (this.recorded === 'record') {
      if (leftover.length > 0) {
        return {
          index: leftover.length,
          field: 'schedule.leftover',
          expected: 'none',
          actual: `${leftover[0]!.actor}:${leftover[0]!.phase}`,
        };
      }
      return null;
    }
    while (this.index < this.recorded.length) {
      if (this.fulfilled.has(this.index) || this.recorded[this.index]!.kind !== 'permit') {
        this.index += 1;
        continue;
      }
      break;
    }
    if (this.index < this.recorded.length) {
      const next = this.recorded[this.index]!;
      return {
        index: this.index,
        field: 'schedule.missing',
        expected: choiceKey(next),
        actual: leftover[0] ? `${leftover[0].actor}:${leftover[0].phase}` : 'missing',
      };
    }
    if (leftover.length > 0) {
      return {
        index: this.index,
        field: 'schedule.extra',
        expected: 'none',
        actual: `${leftover[0]!.actor}:${leftover[0]!.phase}`,
      };
    }
    return null;
  }

  private tick(): void {
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const watchdogMs = this.options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    if (this.permits > maxSteps) throw new Error('logical-step-budget');
    if (Date.now() - this.startedMs > watchdogMs) {
      const next =
        this.recorded !== 'record' && this.index < this.recorded.length
          ? choiceKey(this.recorded[this.index]!)
          : 'none';
      const requested = this.runtime
        .events()
        .filter((event) => event.status === 'requested')
        .map(
          (event) =>
            `${event.actor}:${event.operation}:${event.phase}:run=${canPermitEvent(this.runtime.state, event.eventId)}`
        )
        .join(',');
      const permitted = this.runtime
        .events()
        .filter((event) => event.status === 'permitted')
        .map((event) => `${event.actor}:${event.operation}:${event.phase}`)
        .join(',');
      throw new Error(
        `watchdog:next=${next}:requested=${requested}:permitted=${permitted}:permits=${this.permits}`
      );
    }
    if (this.recorded === 'record') {
      while (this.runtime.permitNext() !== null) this.permits += 1;
      return;
    }
    while (this.index < this.recorded.length) {
      const choice = this.recorded[this.index]!;
      if (choice.kind !== 'permit' || this.fulfilled.has(this.index)) {
        this.index += 1;
        continue;
      }
      const match = this.find(choice);
      if (match) {
        this.runtime.permit(match.eventId);
        this.permits += 1;
        this.index += 1;
        continue;
      }
      // Request-order races: a later recorded event may be the one that's
      // runnable now. Pull it forward.
      let pulled = false;
      for (let later = this.index + 1; later < this.recorded.length; later++) {
        if (this.fulfilled.has(later)) continue;
        const candidate = this.recorded[later]!;
        if (candidate.kind !== 'permit') continue;
        const found = this.find(candidate);
        if (!found) continue;
        this.runtime.permit(found.eventId);
        this.permits += 1;
        this.fulfilled.add(later);
        pulled = true;
        break;
      }
      if (pulled) continue;
      const runnable = this.runtime
        .events()
        .find(
          (event) =>
            event.status === 'requested' &&
            !this.runtime.paused.has(event.actor) &&
            canPermitEvent(this.runtime.state, event.eventId)
        );
      if (runnable) {
        // Original recorded extra nested reads that this run did not issue.
        // Release the live gate and skip the missing scheduled identity.
        this.runtime.permit(runnable.eventId);
        this.permits += 1;
        this.index += 1;
        continue;
      }
      return;
    }
  }

  private find(choice: ScheduleChoice): LabEvent | undefined {
    const runnable = this.runtime
      .events()
      .filter(
        (event) =>
          event.status === 'requested' &&
          !this.runtime.paused.has(event.actor) &&
          canPermitEvent(this.runtime.state, event.eventId)
      );
    return runnable.find((event) => {
      const identity = eventIdentity(event, this.runtime.events());
      if (identity.actor !== choice.identity.actor) return false;
      if (identity.operation !== choice.identity.operation) return false;
      return identity.phase === choice.identity.phase;
    });
  }
}

export function leftoverRequested(runtime: LabRuntime): LabEvent[] {
  return runtime.events().filter((event) => event.status === 'requested');
}
