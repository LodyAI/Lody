import type { ScheduleRegistryPort, ScheduleRegistrySnapshot, WorkspaceId } from '@lody/shared';
import { ScheduleRegistryIpcError } from '@lody/shared/schedule-registry-ipc';
import type { RendererFlockRoomGroupFreeze } from './renderer-flock-room-group-freeze';

/** Stable domain facade across a whole-SR ownership change. Retained observers
 * replace their source; no admitted mutation is replayed across that change. */
export function createRendererScheduleRegistryOwner(options: {
  workspaceId: WorkspaceId;
  gate: RendererFlockRoomGroupFreeze;
  legacy(): ScheduleRegistryPort;
  native(): Promise<ScheduleRegistryPort>;
}) {
  const roomId = `${options.workspaceId}:sr`;
  let closed = false;
  const bounded = async <A>(work: Promise<A>): Promise<A> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ScheduleRegistryIpcError('restart_required')), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const observers = new Set<{ close(): Promise<void> }>();
  const selected = async () => {
    if (closed) throw new ScheduleRegistryIpcError('restart_required');
    if (options.gate.ownerKind() === 'frozen')
      throw new ScheduleRegistryIpcError('restart_required');
    if (options.gate.ownerKind() === 'native') return options.native();
    return options.legacy();
  };
  const legacy = <A>(run: (port: ScheduleRegistryPort) => Promise<A>) =>
    options.gate.run(roomId, () => run(options.legacy()));
  const run = async <A>(work: (port: ScheduleRegistryPort) => Promise<A>) => {
    if (closed) throw new ScheduleRegistryIpcError('restart_required');
    return options.gate.ownerKind() === 'legacy' ? legacy(work) : work(await selected());
  };
  const registry: ScheduleRegistryPort = {
    workspaceId: options.workspaceId,
    exportRows: () => run((port) => port.exportRows()),
    read: () => run((port) => port.read()),
    execute: (command) => run((port) => port.execute(command)),
    flush: () => run((port) => port.flush()),
    sync: () => run((port) => port.sync()),
    async observe(update, error) {
      if (closed) throw new ScheduleRegistryIpcError('restart_required');
      let retired = false;
      let epoch = 0;
      let last: ScheduleRegistrySnapshot | undefined;
      let current: Awaited<ReturnType<ScheduleRegistryPort['observe']>> | undefined;
      let rebinding = Promise.resolve();
      const emit = (snapshot: ScheduleRegistrySnapshot, generation: number) => {
        if (retired || generation !== epoch) return;
        last = snapshot;
        update(snapshot);
      };
      const change = () => {
        const generation = ++epoch;
        // Readiness belongs to the precise source; it cannot survive freeze or
        // an asynchronously admitted replacement observation.
        if (last) update({ ...last, synced: false });
        const work = rebinding
          .catch(() => {})
          .then(async () => {
            if (current) {
              await current.close();
              current = undefined;
            }
            if (retired || generation !== epoch) return;
            if (options.gate.ownerKind() === 'frozen') return;
            const receive = (snapshot: ScheduleRegistrySnapshot) => emit(snapshot, generation);
            const failed = (cause: unknown) => {
              if (!retired && generation === epoch) {
                if (last) update({ ...last, synced: false });
                error(cause);
              }
            };
            const observer =
              options.gate.ownerKind() === 'legacy'
                ? await options.gate.observe(
                    roomId,
                    (receive) => options.legacy().observe(receive, failed),
                    receive
                  )
                : await (await selected()).observe(receive, failed);
            current = observer;
            // Acquisition can settle after close/freeze. Retire that exact lease
            // before this observer may acquire another source.
            if (retired || generation !== epoch) {
              await observer.close();
              current = undefined;
            }
          });
        rebinding = work;
        void work.catch((cause) => {
          if (!retired && generation === epoch) error(cause);
        });
        return work;
      };
      const detach = options.gate.subscribeOwner(() => {
        void change().catch(() => {});
      });
      let closing: Promise<void> | undefined;
      const observer = {
        close() {
          if (closing) return bounded(closing);
          retired = true;
          ++epoch;
          detach();
          closing = (async () => {
            // A failed source close remains owned and retryable. Its rejected
            // acquisition does not prevent retrying the exact current lease.
            await rebinding.catch(() => {});
            if (current) await current.close();
            current = undefined;
            observers.delete(observer);
          })().catch((cause) => {
            closing = undefined;
            throw cause;
          });
          return bounded(closing);
        },
      };
      observers.add(observer);
      try {
        await change();
      } catch (cause) {
        try {
          await observer.close();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'SR observer release unconfirmed');
        }
        throw cause;
      }
      return observer;
    },
  };
  return {
    registry,
    async close() {
      closed = true;
      const results = await Promise.allSettled([...observers].map((observer) => observer.close()));
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length) throw new AggregateError(failures, 'SR domain release unconfirmed');
    },
  };
}
