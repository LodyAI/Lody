import {
  NativeDocumentDomainIpcError,
  nativeDocumentDomainRequestSchema,
  nativeDocumentDomainExecuteSchema,
  nativeDocumentDomainEventSchema,
  nativeDocumentDomainSnapshotSchema,
  nativeDocumentDomainCommandResultSchema,
  parseNativeDocumentDomainInput,
  type NativeDocumentDomainRequest,
  type NativeDocumentDomainTarget,
  type NativeDocumentDomainCommand,
  type NativeDocumentDomainSnapshot,
} from '@lody/shared/native-document-domain-ipc';
import type { PreviewVisualCommentMutation, SessionId } from '@lody/shared';
import type { ScheduleDefinitionPort } from '@lody/shared';

export type NativeDocumentDomainTransport = {
  readNativeDocumentDomainRoute?(request: NativeDocumentDomainRequest): Promise<unknown>;
  readNativeDocumentDomain(request: NativeDocumentDomainRequest): Promise<unknown>;
  executeNativeDocumentDomain(
    request: NativeDocumentDomainRequest & {
      expectedGeneration: string;
      command: NativeDocumentDomainCommand;
    }
  ): Promise<unknown>;
  observeNativeDocumentDomain(request: NativeDocumentDomainRequest): Promise<unknown>;
  unobserveNativeDocumentDomain(
    request: NativeDocumentDomainRequest & { leaseId: string }
  ): Promise<unknown>;
  cancelNativeDocumentDomain(request: NativeDocumentDomainRequest): Promise<unknown>;
};
/** Renderer owns only finite commands and immutable domain snapshots. The main
 * owner independently derives binding, permissions, room and native generation. */
export function createNativeDocumentDomainClient(options: {
  registrationId: string;
  target: NativeDocumentDomainTarget;
  transport: NativeDocumentDomainTransport;
  listen(listener: (value: unknown) => void): () => void;
}) {
  let closed = false,
    generation: string | undefined;
  let observedRevision = 0;
  const observers = new Set<{ close(): Promise<void> }>();
  const base = (): NativeDocumentDomainRequest =>
    nativeDocumentDomainRequestSchema.parse({
      registrationId: options.registrationId,
      target: options.target,
      requestId: crypto.randomUUID(),
    });
  const assertOpen = () => {
    if (closed) throw new NativeDocumentDomainIpcError('restart_required');
  };
  const snapshot = (input: unknown) => {
    const parsed = nativeDocumentDomainSnapshotSchema.parse(input);
    if (
      parsed.domain !== options.target.domain ||
      (parsed.domain === 'preview_comments' && parsed.value.meta.sessionId !== options.target.id) ||
      (parsed.domain === 'schedule_definition' &&
        parsed.value &&
        parsed.value.definition.scheduleId !== options.target.id)
    )
      throw new NativeDocumentDomainIpcError('access_denied');
    return parsed;
  };
  const route = async (): Promise<'legacy' | 'frozen' | 'native'> => {
    assertOpen();
    if (!options.transport.readNativeDocumentDomainRoute)
      throw new NativeDocumentDomainIpcError('unavailable');
    const reply = await options.transport.readNativeDocumentDomainRoute(base());
    assertOpen();
    if (
      !reply ||
      typeof reply !== 'object' ||
      Object.keys(reply).length !== 1 ||
      !['legacy', 'frozen', 'native'].includes(Reflect.get(reply, 'owner'))
    )
      throw new NativeDocumentDomainIpcError('unavailable');
    return Reflect.get(reply, 'owner') as 'legacy' | 'frozen' | 'native';
  };
  const read = async () => {
    assertOpen();
    const revision = observedRevision;
    const value = snapshot(await options.transport.readNativeDocumentDomain(base()));
    assertOpen();
    if (revision !== observedRevision) throw new NativeDocumentDomainIpcError('restart_required');
    generation = value.generation;
    return value;
  };
  const execute = async (command: NativeDocumentDomainCommand) => {
    assertOpen();
    if (!generation) await read();
    const expectedGeneration = generation!;
    const request = parseNativeDocumentDomainInput(nativeDocumentDomainExecuteSchema, {
      ...base(),
      expectedGeneration,
      command,
    });
    // Exactly one send. A rejected receipt can represent an already durable write.
    const value = nativeDocumentDomainCommandResultSchema.parse(
      await options.transport.executeNativeDocumentDomain(request)
    );
    assertOpen();
    if (
      value.generation !== expectedGeneration ||
      generation !== expectedGeneration ||
      (value.snapshot && snapshot(value.snapshot).generation !== expectedGeneration)
    )
      throw new NativeDocumentDomainIpcError('restart_required');
    return value;
  };
  const observe = async (
    listener: (value: NativeDocumentDomainSnapshot) => void,
    onError: (error: unknown) => void
  ) => {
    assertOpen();
    if (observers.size >= 64) throw new NativeDocumentDomainIpcError('cleanup_unconfirmed');
    const request = base();
    let retired = false,
      leaseId: string | undefined;
    let early: ReturnType<typeof nativeDocumentDomainEventSchema.parse> | undefined;
    let cleanup: Promise<void> | undefined;
    let acquisition: Promise<void>;
    const delivery = (event: ReturnType<typeof nativeDocumentDomainEventSchema.parse>) => {
      if (retired || closed || event.leaseId !== leaseId) return;
      if (event.event.kind === 'error') {
        generation = undefined;
        retired = true;
        onError(new NativeDocumentDomainIpcError(event.event.code));
        void close().catch(() => {});
      } else {
        const current = snapshot(event.event.snapshot);
        generation = current.generation;
        observedRevision++;
        listener(current);
      }
    };
    const detach = options.listen((input) => {
      if (retired || closed) return;
      const parsed = nativeDocumentDomainEventSchema.safeParse(input);
      if (!parsed.success) return;
      const event = parsed.data;
      if (
        event.registrationId !== request.registrationId ||
        event.requestId !== request.requestId ||
        event.target.domain !== request.target.domain ||
        event.target.id !== request.target.id
      )
        return;
      if (!leaseId) early = event;
      else delivery(event);
    });
    const rawCleanup = async () => {
      detach();
      if (leaseId) {
        await options.transport.unobserveNativeDocumentDomain({ ...request, leaseId });
      } else {
        const receipt = await options.transport.cancelNativeDocumentDomain(request);
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          Reflect.get(receipt, 'canceled') !== true ||
          Object.keys(receipt).length !== 1
        )
          throw new NativeDocumentDomainIpcError('cleanup_unconfirmed');
        // Main confirms exact request cleanup or its pre-admission fence. A
        // late successful observe reply is independently released below.
      }
      observers.delete(observation);
    };
    const close = (): Promise<void> => {
      retired = true;
      detach();
      if (!cleanup) {
        cleanup = rawCleanup();
        void cleanup.catch(() => {
          cleanup = undefined;
        });
      }
      const work = cleanup;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new NativeDocumentDomainIpcError('cleanup_unconfirmed')),
          10_000
        );
        work.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            reject(new NativeDocumentDomainIpcError('cleanup_unconfirmed'));
          }
        );
      });
    };
    const observation = { close, retryCleanup: close };
    observers.add(observation);
    acquisition = options.transport.observeNativeDocumentDomain(request).then((reply) => {
      if (
        !reply ||
        typeof reply !== 'object' ||
        typeof Reflect.get(reply, 'leaseId') !== 'string' ||
        Object.keys(reply).length !== 1
      )
        throw new NativeDocumentDomainIpcError('cleanup_unconfirmed');
      leaseId = Reflect.get(reply, 'leaseId') as string;
      if (retired || closed)
        return options.transport
          .unobserveNativeDocumentDomain({ ...request, leaseId })
          .then(() => undefined);
      if (early) delivery(early);
      early = undefined;
      return undefined;
    });
    void acquisition.catch(() => {});
    try {
      await acquisition;
      if (closed || retired) {
        await close();
        throw new NativeDocumentDomainIpcError('restart_required');
      }
      return observation;
    } catch (error) {
      // An acquisition error is not proof of absence. Keep the cancellation
      // owner and its exact request/lease until cleanup is acknowledged.
      try {
        await close();
      } catch {
        throw new NativeDocumentDomainIpcError('cleanup_unconfirmed');
      }
      throw error;
    }
  };
  const close = async () => {
    closed = true;
    generation = undefined;
    const results = await Promise.allSettled([...observers].map((observer) => observer.close()));
    if (results.some((result) => result.status === 'rejected'))
      throw new NativeDocumentDomainIpcError('cleanup_unconfirmed');
  };
  return {
    route,
    read,
    execute,
    observe,
    close,
    retryCleanup: close,
    preview: {
      async read() {
        const value = await read();
        if (value.domain !== 'preview_comments')
          throw new NativeDocumentDomainIpcError('access_denied');
        return value.value;
      },
      async mutatePreviewVisualComments(
        sessionId: SessionId,
        mutation: PreviewVisualCommentMutation
      ) {
        if (options.target.domain !== 'preview_comments' || sessionId !== options.target.id)
          throw new NativeDocumentDomainIpcError('access_denied');
        return (await execute({ kind: 'preview-mutate', mutation })).changed;
      },
    },
    definition: {
      async read() {
        const value = await read();
        if (value.domain !== 'schedule_definition')
          throw new NativeDocumentDomainIpcError('access_denied');
        return value.value;
      },
      async save(input) {
        if (
          options.target.domain !== 'schedule_definition' ||
          input.scheduleId !== options.target.id
        )
          throw new NativeDocumentDomainIpcError('access_denied');
        const receipt = await execute({
          kind: 'schedule-save',
          draft: input.draft,
          now: input.now,
          activationId: input.activationId,
          activityId: input.activityId,
          ...(input.create === undefined ? {} : { create: input.create }),
        });
        const current = receipt.snapshot;
        if (!current || current.domain !== 'schedule_definition' || !current.value)
          throw new NativeDocumentDomainIpcError('unavailable');
        return current.value;
      },
      async setEnabled(input) {
        if (
          options.target.domain !== 'schedule_definition' ||
          input.scheduleId !== options.target.id
        )
          throw new NativeDocumentDomainIpcError('access_denied');
        await execute({
          kind: 'schedule-enabled',
          enabled: input.enabled,
          now: input.now,
          activationId: input.activationId,
          requestId: input.requestId,
          ...(input.requesterSessionId === undefined
            ? {}
            : { requesterSessionId: input.requesterSessionId }),
        });
      },
    } satisfies ScheduleDefinitionPort,
  };
}
