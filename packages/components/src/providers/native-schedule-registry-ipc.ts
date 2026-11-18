import type { ScheduleRegistryPort, ScheduleRegistrySnapshot, WorkspaceId } from '@lody/shared';
import {
  ScheduleRegistryIpcError,
  scheduleRegistryIpcErrorCode,
  parseScheduleRegistryIpcEvent,
  parseScheduleRegistryIpcSnapshot,
  scheduleRegistryIpcObserveResultSchema,
  scheduleRegistryIpcCancelResultSchema,
  scheduleRegistryIpcCommandResultSchema,
  scheduleRegistryIpcFlushResultSchema,
  scheduleRegistryIpcRequestSchema,
  toScheduleRegistryIpcCommand,
  type ScheduleRegistryIpcCommand,
  type ScheduleRegistryIpcSnapshot,
} from '@lody/shared/schedule-registry-ipc';
export type NativeScheduleRegistryRequest = {
  readonly registrationId: string;
  readonly requestId: string;
};
export type NativeScheduleRegistryTransport = {
  read(request: NativeScheduleRegistryRequest): Promise<unknown>;
  execute(
    request: NativeScheduleRegistryRequest & {
      command: ScheduleRegistryIpcCommand;
      expectedGeneration: string;
    }
  ): Promise<unknown>;
  flush(request: NativeScheduleRegistryRequest & { expectedGeneration: string }): Promise<unknown>;
  observe(request: NativeScheduleRegistryRequest): Promise<unknown>;
  unobserve(request: NativeScheduleRegistryRequest & { leaseId: string }): Promise<void>;
  cancelObservation(request: NativeScheduleRegistryRequest): Promise<unknown>;
};
export class NativeScheduleRegistryIpcCleanupError extends AggregateError {
  readonly code = 'cleanup_unconfirmed';
  constructor(
    errors: unknown[],
    readonly retryCleanup: () => Promise<void>
  ) {
    super(
      errors.map((error) => new ScheduleRegistryIpcError(scheduleRegistryIpcErrorCode(error))),
      'Native SR IPC cleanup unconfirmed'
    );
  }
}
type Slot = {
  request: NativeScheduleRegistryRequest;
  acquisition: Promise<unknown>;
  leaseId?: string;
  closing: boolean;
  confirmed: boolean;
  release?: Promise<void>;
  lateRelease?: Promise<void>;
  proof: Promise<void>;
  confirm(): void;
  retire(): void;
  retired: Promise<void>;
  buffer: Map<string, unknown>;
  update(state: ScheduleRegistrySnapshot): void;
  onError(error: ScheduleRegistryIpcError): void;
};
/** Only known SR state and three user intents cross IPC. There is no local Repo
 * fallback and no replay of a sent command after a lost response. */
export function createNativeScheduleRegistryIpc(options: {
  workspaceId: WorkspaceId;
  actorId: string;
  registrationId: string;
  transport: NativeScheduleRegistryTransport;
  listen(receive: (event: unknown) => void): () => void;
  closeTimeoutMs?: number;
}) {
  if (
    !scheduleRegistryIpcRequestSchema.safeParse({
      registrationId: options.registrationId,
      requestId: crypto.randomUUID(),
    }).success
  )
    throw new ScheduleRegistryIpcError();
  if (!options.actorId || !options.workspaceId) throw new ScheduleRegistryIpcError();
  const slots = new Set<Slot>();
  let closed = false,
    epoch = 0,
    updates = 0;
  let current: ScheduleRegistryIpcSnapshot | undefined;
  let detach: (() => void) | undefined;
  let started: Promise<void> | undefined;
  const unavailable = () => new ScheduleRegistryIpcError('restart_required');
  const check = () => {
    if (closed) throw unavailable();
  };
  const request = (): NativeScheduleRegistryRequest => ({
    registrationId: options.registrationId,
    requestId: crypto.randomUUID(),
  });
  const safely = (error: unknown) =>
    new ScheduleRegistryIpcError(scheduleRegistryIpcErrorCode(error));
  const bounded = async <A>(work: Promise<A>, retry: () => Promise<void>): Promise<A> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new NativeScheduleRegistryIpcCleanupError([], retry)),
            options.closeTimeoutMs ?? 5000
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const accept = (raw: unknown, slot?: Slot) => {
    check();
    const parsed = parseScheduleRegistryIpcSnapshot(raw);
    if (parsed.workspaceId !== options.workspaceId) throw unavailable();
    if (current && parsed.generation !== current.generation) {
      if ([...slots].some((value) => value !== slot && !value.closing)) throw unavailable();
      epoch++;
    }
    current = parsed;
    updates++;
    return parsed.state;
  };
  const fail = (slot: Slot, error: unknown) => {
    if (slot.closing || closed) return;
    try {
      slot.onError(safely(error));
    } catch {
      /* A view cannot prevent retirement. */
    }
    void release(slot).catch(() => {});
  };
  function release(slot: Slot): Promise<void> {
    slot.closing = true;
    slot.retire();
    slot.buffer.clear();
    if (slot.confirmed) return Promise.resolve();
    if (slot.release) return slot.release;
    const work =
      slot.lateRelease ??
      Promise.resolve().then(async () => {
        if (slot.leaseId)
          await options.transport.unobserve({ ...slot.request, leaseId: slot.leaseId });
        else
          scheduleRegistryIpcCancelResultSchema.parse(
            await options.transport.cancelObservation(slot.request)
          );
        slot.confirm();
      });
    const operation = Promise.race([work, slot.proof]);
    slot.release = operation;
    void operation.catch(() => {
      if (slot.release === operation) slot.release = undefined;
    });
    return operation;
  }
  function receive(raw: unknown) {
    if (closed || !raw || typeof raw !== 'object') return;
    const envelope = raw as Record<string, unknown>;
    if (envelope.registrationId !== options.registrationId) return;
    const slot = [...slots].find(
      (value) => !value.closing && value.request.requestId === envelope.requestId
    );
    if (!slot || (slot.leaseId && envelope.leaseId !== slot.leaseId)) return;
    try {
      const event = parseScheduleRegistryIpcEvent(raw);
      if (!slot.leaseId) {
        if (slot.buffer.size >= 8 && !slot.buffer.has(event.leaseId)) throw unavailable();
        slot.buffer.set(event.leaseId, event);
        return;
      }
      if (event.type === 'error') throw new ScheduleRegistryIpcError(event.code);
      slot.update(structuredClone(accept(event.snapshot, slot)));
    } catch (error) {
      fail(slot, error);
    }
  }
  const listen = () => {
    if (!detach) detach = options.listen(receive);
  };
  const registry: ScheduleRegistryPort = {
    workspaceId: options.workspaceId,
    async exportRows() {
      throw new ScheduleRegistryIpcError('access_denied');
    },
    async read() {
      check();
      const before = updates;
      let raw: unknown;
      try {
        raw = await options.transport.read(request());
      } catch (error) {
        throw safely(error);
      }
      check();
      const parsed = parseScheduleRegistryIpcSnapshot(raw);
      if (parsed.workspaceId !== options.workspaceId) throw unavailable();
      if (before === updates) accept(parsed);
      else if (current?.generation !== parsed.generation) throw unavailable();
      return structuredClone(current?.state ?? parsed.state);
    },
    async execute(command) {
      check();
      const generation = current?.generation,
        captured = epoch;
      if (!generation) throw unavailable();
      const dto = toScheduleRegistryIpcCommand(command, options.actorId);
      let raw: unknown;
      try {
        raw = await options.transport.execute({
          ...request(),
          command: dto,
          expectedGeneration: generation,
        });
      } catch (error) {
        throw safely(error);
      }
      check();
      const parsed = scheduleRegistryIpcCommandResultSchema.safeParse(raw);
      if (!parsed.success) throw new ScheduleRegistryIpcError('operation_failed');
      const result = parsed.data;
      if (
        captured !== epoch ||
        current?.generation !== generation ||
        result.generation !== generation
      )
        throw unavailable();
      return { changed: result.changed };
    },
    async flush() {
      check();
      const generation = current?.generation,
        captured = epoch;
      if (!generation) throw unavailable();
      let raw: unknown;
      try {
        raw = await options.transport.flush({ ...request(), expectedGeneration: generation });
      } catch (error) {
        throw safely(error);
      }
      check();
      const parsed = scheduleRegistryIpcFlushResultSchema.safeParse(raw);
      if (!parsed.success) throw new ScheduleRegistryIpcError('operation_failed');
      const result = parsed.data;
      if (
        captured !== epoch ||
        current?.generation !== generation ||
        result.generation !== generation
      )
        throw unavailable();
    },
    async sync() {
      await registry.flush();
    },
    async observe(update, onError) {
      check();
      listen();
      let prove!: () => void, retire!: () => void;
      const proof = new Promise<void>((resolve) => {
        prove = resolve;
      });
      const retired = new Promise<void>((resolve) => {
        retire = resolve;
      });
      const slot: Slot = {
        request: request(),
        acquisition: undefined as unknown as Promise<unknown>,
        closing: false,
        confirmed: false,
        proof,
        retired,
        retire,
        confirm: () => {
          slot.confirmed = true;
          slots.delete(slot);
          prove();
        },
        buffer: new Map(),
        update,
        onError,
      };
      slots.add(slot);
      slot.acquisition = Promise.resolve().then(() => {
        if (slot.closing || closed) throw unavailable();
        return options.transport.observe(slot.request);
      });
      // The raw reply remains observed after the local waiter is retired. A late
      // exact lease can prove release even if exact cancellation lost its ACK.
      void slot.acquisition.then(
        (raw) => {
          try {
            const receipt = scheduleRegistryIpcObserveResultSchema.parse(raw);
            slot.leaseId = receipt.leaseId;
            if (slot.closing && !slot.confirmed && !slot.lateRelease) {
              const attempt = Promise.resolve()
                .then(() =>
                  options.transport.unobserve({ ...slot.request, leaseId: receipt.leaseId })
                )
                .then(() => slot.confirm());
              slot.lateRelease = attempt;
              void attempt.catch(() => {
                if (slot.lateRelease === attempt) slot.lateRelease = undefined;
              });
            }
          } catch {
            /* Malformed replies require exact-request cancellation. */
          }
        },
        () => {}
      );
      const observation = {
        close: async (): Promise<void> => {
          await bounded(release(slot), observation.close);
        },
      };
      try {
        const raw = await Promise.race([
          slot.acquisition,
          retired.then(() => {
            throw unavailable();
          }),
        ]);
        const receipt = scheduleRegistryIpcObserveResultSchema.parse(raw);
        slot.leaseId = receipt.leaseId;
        if (slot.closing || closed) throw unavailable();
        const buffered = slot.buffer.get(receipt.leaseId);
        slot.buffer.clear();
        if (buffered) receive(buffered);
        if (slot.closing) throw unavailable();
        return observation;
      } catch (error) {
        try {
          await observation.close();
        } catch (cleanup) {
          throw new NativeScheduleRegistryIpcCleanupError([error, cleanup], observation.close);
        }
        throw safely(error);
      }
    },
  };
  const close = async (): Promise<void> => {
    closed = true;
    epoch++;
    const errors: unknown[] = [];
    try {
      detach?.();
      detach = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      const results = await bounded(
        Promise.allSettled([...slots].map((slot) => release(slot))),
        close
      );
      errors.push(
        ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      );
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new NativeScheduleRegistryIpcCleanupError(errors, close);
  };
  return {
    registry,
    start() {
      check();
      if (!started) {
        const work = registry.read().then(() => {});
        started = work;
        void work.catch(() => {
          if (started === work) started = undefined;
        });
      }
      return started;
    },
    close,
    retryCleanup: close,
  };
}
