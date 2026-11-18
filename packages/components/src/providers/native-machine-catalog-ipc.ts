import type {
  AgentConfigEditorPort,
  AgentConfigId,
  MachineCatalogBinding,
  MachineCatalogCommand,
  MachineCatalogEditor,
  MachineCatalogSettingsPort,
  MachineId,
} from '@lody/shared';
import {
  MachineCatalogIpcError,
  machineCatalogIpcCommandResultSchema,
  machineCatalogIpcEditorResultSchema,
  machineCatalogIpcUploadResultSchema,
  machineCatalogIpcCancelResultSchema,
  machineCatalogIpcErrorCode,
  machineCatalogIpcRequestSchema,
  machineCatalogIpcUnsubscribeSchema,
  parseMachineCatalogIpcCommand,
  parseMachineCatalogIpcEvent,
  parseMachineCatalogIpcSnapshot,
  type MachineCatalogIpcSnapshot,
} from '@lody/shared/machine-catalog-ipc';

export type NativeMachineCatalogRequest = {
  readonly registrationId: string;
  readonly requestId: string;
  readonly machineId: string;
};
/** Only the domain transport crosses this boundary. No Repo, SDK or saved
 * credentials are readable; command credentials are write-only caller input. */
export type NativeMachineCatalogTransport = {
  readMachineCatalog(request: NativeMachineCatalogRequest): Promise<unknown>;
  beginMachineAgentConfigEdit(
    request: NativeMachineCatalogRequest & {
      readonly id: string;
      readonly expectedGeneration: string;
    }
  ): Promise<unknown>;
  executeMachineCatalog(
    request: NativeMachineCatalogRequest & {
      readonly command: MachineCatalogCommand;
      readonly expectedGeneration: string;
    }
  ): Promise<unknown>;
  uploadMachineCatalog(
    request: NativeMachineCatalogRequest & { readonly expectedGeneration: string }
  ): Promise<unknown>;
  observeMachineCatalog(request: NativeMachineCatalogRequest): Promise<unknown>;
  unobserveMachineCatalog(
    request: NativeMachineCatalogRequest & { readonly leaseId: string }
  ): Promise<void>;
  /** An ACK proves this exact logical request is cancelled, including an
   * observe whose response was lost or whose admission was still pending. */
  cancelMachineCatalogObservation(
    request: NativeMachineCatalogRequest
  ): Promise<{ readonly canceled: true }>;
};
export class NativeMachineCatalogIpcCleanupError extends AggregateError {
  readonly code = 'cleanup_unconfirmed';
  constructor(
    errors: readonly unknown[],
    readonly retryCleanup: () => Promise<void>
  ) {
    super(
      errors.map((error) => new MachineCatalogIpcError(machineCatalogIpcErrorCode(error))),
      'Native machine catalog IPC cleanup unconfirmed'
    );
  }
}
export type NativeMachineCatalogStatus = 'pending' | 'ready' | 'unavailable' | 'error' | 'retired';
type Options = {
  readonly binding: Pick<MachineCatalogBinding, 'accountId' | 'workspaceId'>;
  readonly registrationId: string;
  readonly machineIds: readonly MachineId[];
  readonly transport: NativeMachineCatalogTransport;
  readonly listen: (receive: (event: unknown) => void) => () => void;
  readonly onError?: (machineId: MachineId, error: MachineCatalogIpcError) => void;
};
type Slot = {
  readonly request: NativeMachineCatalogRequest;
  readonly cancelWaiter: () => void;
  readonly retired: Promise<void>;
  acquisition: Promise<unknown>;
  leaseId?: string;
  closing: boolean;
  acceptNewGeneration: boolean;
  confirmed: boolean;
  release?: Promise<void>;
  lateRelease?: Promise<void>;
  readonly proof: Promise<void>;
  readonly confirm: () => void;
  readonly buffer: Map<string, unknown>;
};
type Machine = {
  readonly id: MachineId;
  status: NativeMachineCatalogStatus;
  epoch: number;
  updates: number;
  serverGeneration?: string;
  snapshot?: MachineCatalogIpcSnapshot;
  slot?: Slot;
};

/** A selected group is immutable for this source's lifetime. A new registration,
 * account, workspace or selection needs a new source, never an old MF fallback. */
export function createNativeMachineCatalogIpc(options: Options) {
  const binding = Object.freeze({
    accountId: options.binding.accountId,
    workspaceId: options.binding.workspaceId,
  });
  const registrationId = options.registrationId;
  const sourceId = crypto.randomUUID();
  const transport = options.transport;
  machineCatalogIpcRequestSchema.parse({
    registrationId,
    requestId: sourceId,
    machineId: 'binding-check',
  });
  if (
    !binding.accountId ||
    !binding.workspaceId ||
    new Set(options.machineIds).size !== options.machineIds.length
  )
    throw new MachineCatalogIpcError('invalid_request');
  const machines = new Map(
    options.machineIds.map((id) => [id, { id, status: 'pending', epoch: 0, updates: 0 } as Machine])
  );
  for (const machineId of machines.keys())
    machineCatalogIpcRequestSchema.parse({ registrationId, requestId: sourceId, machineId });
  const listeners = new Set<() => void>();
  const tokens = new Map<
    string,
    {
      readonly machine: Machine;
      readonly epoch: number;
      readonly generation: string;
      readonly id: string;
      readonly token: string;
    }
  >();
  let closed = false,
    started: Promise<void> | undefined,
    detach: (() => void) | undefined;
  const unavailable = () => new MachineCatalogIpcError('restart_required');
  const selected = (machineId: MachineId): Machine => {
    const machine = machines.get(machineId);
    if (!machine || closed) throw new MachineCatalogIpcError('access_denied');
    return machine;
  };
  const ready = (machineId: MachineId) => {
    const machine = selected(machineId);
    if (machine.status !== 'ready' || !machine.serverGeneration) throw unavailable();
    return machine;
  };
  const capture = (machine: Machine) => ({
    epoch: machine.epoch,
    generation: machine.serverGeneration,
  });
  const recheck = (machine: Machine, scope: ReturnType<typeof capture>) => {
    if (
      ready(machine.id) !== machine ||
      machine.epoch !== scope.epoch ||
      machine.serverGeneration !== scope.generation
    )
      throw unavailable();
  };
  const request = (machine: Machine) => ({
    registrationId,
    requestId: crypto.randomUUID(),
    machineId: machine.id,
  });
  const notify = () => {
    // Every listener reads the same already-published snapshot. A failed view
    // cannot prevent another view or independent machine from seeing it.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  };
  const clearTokens = (machine: Machine) => {
    for (const [key, token] of tokens) if (token.machine === machine) tokens.delete(key);
  };
  const invalidate = (machine: Machine, status: NativeMachineCatalogStatus) => {
    machine.status = status;
    machine.snapshot = undefined;
    machine.epoch++;
    clearTokens(machine);
  };
  const editors = new Map<MachineId, AgentConfigEditorPort>();
  const machineGeneration = (machineId: MachineId) =>
    `${sourceId}:${machines.get(machineId)?.epoch ?? 'unselected'}:${machines.get(machineId)?.serverGeneration ?? 'pending'}`;
  let snapshot: MachineCatalogSettingsPort;
  const publish = () => {
    const available = [...machines.values()].filter(
      (machine) => machine.snapshot && machine.status !== 'error' && machine.status !== 'retired'
    );
    snapshot = Object.freeze({
      binding,
      generation: sourceId,
      machineGeneration: machineGeneration,
      agents: Object.freeze(
        available.flatMap((machine) => machine.snapshot!.projection.agents)
      ) as MachineCatalogSettingsPort['agents'],
      setups: Object.freeze(
        available.flatMap((machine) => machine.snapshot!.projection.providerSetups)
      ) as MachineCatalogSettingsPort['setups'],
      dotlodyPaths: Object.freeze(
        Object.fromEntries(
          available.map((machine) => [machine.id, machine.snapshot!.projection.dotlodyPath])
        )
      ),
      editor,
      execute,
    });
    notify();
  };
  const fail = (machine: Machine, error: unknown, scopeLost = false) => {
    if (closed || machine.status === 'retired') return;
    const safe = new MachineCatalogIpcError(machineCatalogIpcErrorCode(error));
    const clear = scopeLost || safe.code === 'access_denied';
    if (
      (clear && machine.status === 'error') ||
      (!clear && (machine.status === 'error' || machine.status === 'unavailable'))
    )
      return;
    if (clear) invalidate(machine, 'error');
    else machine.status = 'unavailable';
    publish();
    try {
      options.onError?.(machine.id, safe);
    } catch {
      /* Diagnostics cannot reopen admission. */
    }
    if (machine.slot) void release(machine.slot).catch(() => undefined);
  };
  const accept = (machine: Machine, raw: unknown) => {
    const value = parseMachineCatalogIpcSnapshot(raw);
    if (value.machineId !== machine.id) {
      fail(machine, unavailable(), true);
      throw unavailable();
    }
    if (machine.serverGeneration && value.generation !== machine.serverGeneration) {
      if (machine.slot?.acceptNewGeneration) {
        invalidate(machine, 'pending');
        machine.serverGeneration = value.generation;
      } else {
        fail(machine, unavailable(), true);
        throw unavailable();
      }
    }
    if (machine.slot) machine.slot.acceptNewGeneration = false;
    if (closed || machine.status === 'error' || machine.status === 'retired') return;
    if (!machine.serverGeneration) {
      machine.serverGeneration = value.generation;
    }
    machine.updates++;
    machine.snapshot = value;
    // Local snapshots prove local availability. Subscription ACKs only prove
    // resource acquisition; Node still authorizes every command.
    machine.status = 'ready';
    publish();
  };
  function release(slot: Slot): Promise<void> {
    slot.closing = true;
    slot.cancelWaiter();
    slot.buffer.clear();
    if (slot.confirmed) return Promise.resolve();
    if (slot.release) return slot.release;
    const work =
      slot.lateRelease ??
      Promise.resolve()
        .then(async () => {
          // Never infer release from acquisition rejection. Unknown replies need
          // exact-request cancellation; a later retry uses this same request ID.
          if (slot.leaseId)
            await transport.unobserveMachineCatalog({ ...slot.request, leaseId: slot.leaseId });
          else {
            machineCatalogIpcCancelResultSchema.parse(
              await transport.cancelMachineCatalogObservation(slot.request)
            );
          }
          slot.confirm();
        })
        .catch((error) => {
          throw new MachineCatalogIpcError(machineCatalogIpcErrorCode(error));
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
    if (envelope.registrationId !== registrationId || typeof envelope.machineId !== 'string')
      return;
    const machine = machines.get(envelope.machineId as MachineId),
      slot = machine?.slot;
    if (!machine || !slot || slot.closing || envelope.requestId !== slot.request.requestId) return;
    if (slot.leaseId && envelope.leaseId !== slot.leaseId) return;
    try {
      const event = parseMachineCatalogIpcEvent(raw);
      if (!slot.leaseId) {
        if (slot.buffer.size >= 8 && !slot.buffer.has(event.leaseId)) throw unavailable();
        slot.buffer.set(event.leaseId, event);
        return;
      }
      if (event.type === 'error') throw new MachineCatalogIpcError(event.code);
      accept(machine, event.snapshot);
    } catch (error) {
      fail(machine, error);
    }
  }
  async function startMachine(machine: Machine, acceptNewGeneration = false) {
    let cancelWaiter!: () => void;
    const retired = new Promise<void>((resolve) => {
      cancelWaiter = resolve;
    });
    let prove!: () => void;
    const proof = new Promise<void>((resolve) => {
      prove = resolve;
    });
    const slot: Slot = {
      proof,
      confirm: () => {
        slot.confirmed = true;
        prove();
      },
      request: request(machine),
      retired,
      cancelWaiter,
      acquisition: undefined as never,
      closing: false,
      acceptNewGeneration,
      confirmed: false,
      buffer: new Map(),
    };
    machine.slot = slot;
    slot.acquisition = Promise.resolve().then(() =>
      slot.closing ? Promise.reject(unavailable()) : transport.observeMachineCatalog(slot.request)
    );
    // Keep the original attempt observed even after local retirement releases its
    // waiter. A successful exact cancellation already covers its late receipt.
    void slot.acquisition.then(
      (raw) => {
        try {
          const receipt = machineCatalogIpcUnsubscribeSchema.parse({
            ...(raw as object),
            ...slot.request,
          });
          slot.leaseId = receipt.leaseId;
          if (slot.closing && !slot.confirmed && !slot.lateRelease) {
            // A real late lease is an alternative cleanup proof when an earlier
            // exact cancellation request is still pending or failed.
            const attempt = Promise.resolve()
              .then(() =>
                transport.unobserveMachineCatalog({ ...slot.request, leaseId: receipt.leaseId })
              )
              .then(() => slot.confirm());
            slot.lateRelease = attempt;
            void attempt.catch(() => {
              if (slot.lateRelease === attempt) slot.lateRelease = undefined;
            });
          }
        } catch {
          /* Malformed receipts still require exact-request cancellation. */
        }
      },
      () => undefined
    );
    const beforeRead = machine.updates;
    const initial = Promise.resolve().then(async () => {
      const value = await transport.readMachineCatalog(request(machine));
      if (!slot.closing && machine.updates === beforeRead) accept(machine, value);
    });
    void initial.catch((error) => fail(machine, error));
    try {
      const raw = await Promise.race([
        slot.acquisition,
        slot.retired.then(() => {
          throw unavailable();
        }),
      ]);
      const receipt = machineCatalogIpcUnsubscribeSchema.parse({
        ...(raw as object),
        ...slot.request,
      });
      slot.leaseId = receipt.leaseId;
      if (slot.closing || closed) {
        await release(slot);
        return;
      }
      const buffered = slot.buffer.get(receipt.leaseId);
      slot.buffer.clear();
      if (buffered) receive(buffered);
      if (machine.snapshot && machine.status !== 'error' && !slot.closing) {
        machine.status = 'ready';
        publish();
      }
      await Promise.race([initial, slot.retired]);
    } catch (error) {
      if (!slot.closing && !closed) fail(machine, error);
    }
  }
  function confirmReplyScope(
    machine: Machine,
    scope: ReturnType<typeof capture>,
    raw: unknown
  ): Record<string, unknown> {
    recheck(machine, scope);
    if (
      !raw ||
      typeof raw !== 'object' ||
      (raw as Record<string, unknown>).generation !== scope.generation
    ) {
      fail(machine, unavailable(), true);
      throw unavailable();
    }
    return raw as Record<string, unknown>;
  }
  function operationFailure(machine: Machine, error: unknown): MachineCatalogIpcError {
    const safe = new MachineCatalogIpcError(machineCatalogIpcErrorCode(error));
    if (
      safe.code === 'restart_required' ||
      safe.code === 'access_denied' ||
      safe.code === 'unavailable'
    )
      fail(machine, safe);
    return safe;
  }
  async function execute(machineId: MachineId, raw: MachineCatalogCommand) {
    const machine = ready(machineId),
      scope = capture(machine);
    let command = parseMachineCatalogIpcCommand(raw, machine.id);
    if (command.kind === 'edit-agent' || command.kind === 'remove-agent') {
      const token = tokens.get(command.editToken);
      if (
        !token ||
        token.machine !== machine ||
        token.epoch !== scope.epoch ||
        token.generation !== scope.generation ||
        token.id !== command.id
      )
        throw new MachineCatalogIpcError('edit_expired');
      tokens.delete(command.editToken);
      command = { ...command, editToken: token.token };
    }
    try {
      const result = await transport.executeMachineCatalog({
        ...request(machine),
        command,
        expectedGeneration: scope.generation!,
      });
      const reply = machineCatalogIpcCommandResultSchema.parse(result);
      confirmReplyScope(machine, scope, reply);
      if (command.kind === 'link-memory' || command.kind === 'edit-memory') {
        if (
          !reply.association ||
          reply.association.machineId !== machine.id ||
          reply.association.providerId !== command.association.providerId ||
          reply.association.memoryId !== command.association.memoryId
        )
          throw new MachineCatalogIpcError('operation_failed');
      } else if (reply.association) throw new MachineCatalogIpcError('operation_failed');
      if (command.kind === 'ensure-local-project' || command.kind === 'edit-local-project') {
        const id = command.kind === 'ensure-local-project' ? command.project.id : command.id;
        if (!reply.project || reply.project.id !== id)
          throw new MachineCatalogIpcError('operation_failed');
      } else if (reply.project) throw new MachineCatalogIpcError('operation_failed');
      return {
        changed: reply.changed,
        ...(reply.association ? { association: reply.association } : {}),
        ...(reply.project
          ? {
              project: {
                ...reply.project,
                id: reply.project.id as import('@lody/shared').LocalProjectId,
              },
            }
          : {}),
      };
    } catch (error) {
      throw operationFailure(machine, error);
    }
  }
  function editor(machineId: MachineId): AgentConfigEditorPort {
    selected(machineId);
    let value = editors.get(machineId);
    if (!value) {
      value = {
        async load(id: AgentConfigId) {
          const machine = ready(machineId),
            scope = capture(machine);
          let raw: unknown;
          try {
            raw = await transport.beginMachineAgentConfigEdit({
              ...request(machine),
              id,
              expectedGeneration: scope.generation!,
            });
          } catch (error) {
            throw operationFailure(machine, error);
          }
          let reply: ReturnType<typeof machineCatalogIpcEditorResultSchema.parse>;
          try {
            reply = machineCatalogIpcEditorResultSchema.parse(raw);
          } catch {
            throw new MachineCatalogIpcError('operation_failed');
          }
          confirmReplyScope(machine, scope, reply);
          const parsed = reply.editor;
          if (parsed.machineId !== machineId || parsed.id !== id) throw unavailable();
          const token = crypto.randomUUID();
          while (tokens.size >= 128) tokens.delete(tokens.keys().next().value!);
          tokens.set(token, {
            machine,
            epoch: scope.epoch,
            generation: scope.generation!,
            id,
            token: parsed.editToken,
          });
          return { ...parsed, editToken: token } as MachineCatalogEditor;
        },
        async save(input, options) {
          if (options?.signal?.aborted) throw unavailable();
          const result = await execute(machineId, { kind: 'edit-agent', ...input });
          if (options?.signal?.aborted) throw unavailable();
          return result;
        },
      };
      editors.set(machineId, value);
    }
    return value;
  }
  const recoveries = new Map<Machine, Promise<void>>();
  const reacquire = (machineId: MachineId): Promise<void> => {
    const machine = selected(machineId);
    if (machine.status === 'ready') return Promise.resolve();
    const existing = recoveries.get(machine);
    if (existing) return existing;
    if (!started || machine.status === 'pending') return Promise.reject(unavailable());
    const operation = (async () => {
      if (machine.slot) await release(machine.slot);
      selected(machine.id);
      machine.status = 'pending';
      publish();
      await startMachine(machine, true);
      if (selected(machine.id).status !== 'ready') throw unavailable();
    })();
    recoveries.set(machine, operation);
    void operation
      .finally(() => {
        if (recoveries.get(machine) === operation) recoveries.delete(machine);
      })
      .catch(() => undefined);
    return operation;
  };
  publish();
  const retire = () => {
    if (!closed) {
      closed = true;
      for (const machine of machines.values()) {
        invalidate(machine, 'retired');
        if (machine.slot) void release(machine.slot).catch(() => undefined);
      }
      publish();
    }
    if (detach) {
      detach();
      detach = undefined;
    }
  };
  const close = async () => {
    const errors: unknown[] = [];
    try {
      retire();
    } catch (error) {
      errors.push(error);
    }
    const results = await Promise.allSettled(
      [...machines.values()].flatMap((machine) => (machine.slot ? [release(machine.slot)] : []))
    );
    errors.push(
      ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
    if (errors.length) throw new NativeMachineCatalogIpcCleanupError(errors, close);
  };
  return {
    binding,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    ownsMachine: (machineId: MachineId) => machines.has(machineId),
    readProjection: (machineId: MachineId): MachineCatalogIpcSnapshot | undefined => {
      const value = machines.get(machineId);
      return value?.status === 'ready' ? value.snapshot : undefined;
    },
    getStatus(machineId: MachineId) {
      return machines.get(machineId)?.status ?? 'retired';
    },
    start() {
      if (closed) return Promise.reject(unavailable());
      if (!started) {
        detach = options.listen(receive);
        started = Promise.all([...machines.values()].map((machine) => startMachine(machine))).then(
          () => undefined
        );
      }
      return started;
    },
    async upload(machineId: MachineId) {
      const machine = ready(machineId),
        scope = capture(machine);
      try {
        const result = await transport.uploadMachineCatalog({
          ...request(machine),
          expectedGeneration: scope.generation!,
        });
        confirmReplyScope(machine, scope, machineCatalogIpcUploadResultSchema.parse(result));
      } catch (error) {
        throw operationFailure(machine, error);
      }
    },
    reacquire,
    retire,
    close,
    retryCleanup: close,
  };
}
export type NativeMachineCatalogSource = ReturnType<typeof createNativeMachineCatalogIpc>;
