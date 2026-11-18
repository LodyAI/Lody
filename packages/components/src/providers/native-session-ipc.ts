import type { SessionId, SessionHistoryInput } from '@lody/shared';
import type {
  SessionData,
  SessionDataChangeListener,
  SessionDirectoryRow,
  SessionHistoryReader,
  SessionSnapshot,
  SessionEditableTailResult,
} from '@lody/shared/session-data';
import type {
  NativeSessionScope,
  NativeSessionDomainTransport,
  NativeSessionRead,
  NativeSessionCommand,
  NativeSessionEvent,
  NativeSessionControlState,
  NativeSessionCapturedSnapshot,
} from '@lody/shared/native-session-domain';

const snapshots = new WeakMap<
  SessionSnapshot,
  { token: string; transport: NativeSessionDomainTransport; registrationId: string }
>();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export class NativeSessionSourceError extends Error {
  constructor(
    readonly code:
      | 'operation_failed'
      | 'access_denied'
      | 'restart_required'
      | 'cleanup_unconfirmed',
    cause?: unknown
  ) {
    super(`native_session_${code}`, { cause });
  }
}
/** One room, registration and immutable owner generation. There is no renderer
 * Doc/Mirror/SDK replica; ConversationView requests only its displayed bodies. */
export function createNativeSessionIpcSource(options: {
  readonly registrationId: string;
  readonly sessionId: SessionId;
  readonly transport: NativeSessionDomainTransport;
  readonly requestId: string;
  onFailure?(error: unknown): void;
}) {
  const scope: NativeSessionScope = {
    registrationId: options.registrationId,
    sessionId: options.sessionId,
    requestId: options.requestId,
  };
  let retired = false;
  let generation: string | undefined;
  let paused = true;
  let denied = false;
  let directoryCount = 0;
  let leaseId: string | undefined;
  let control: NativeSessionControlState | undefined;
  let controlEpoch = 0;
  let release: Promise<void> | undefined;
  let releaseFailure: unknown;
  let cancellationConfirmed = false;
  let observationPending = true;
  let observationRequested = false;
  const listeners = new Set<() => void>();
  const historyListeners = new Set<SessionDataChangeListener>();
  const report = (error: unknown) => {
    try {
      options.onFailure?.(error);
    } catch {}
  };
  const publish = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
  };
  const assertCurrent = () => {
    if (retired || paused || !generation) throw new NativeSessionSourceError('restart_required');
  };
  const failure = (error: unknown) => {
    if (record(error) && (error.code === 'invalid_command' || error.code === 'invalid_request')) {
      report(error);
      return;
    }
    paused = true;
    if (record(error) && error.code === 'access_denied') {
      denied = true;
      control = undefined;
      for (const listener of historyListeners) {
        try {
          listener({ kind: 'structure', from: 0, to: directoryCount });
        } catch (callbackError) {
          report(callbackError);
        }
      }
    }
    publish();
    report(error);
  };
  const checkReply = (reply: { generation: string }) => {
    if (
      retired ||
      typeof reply.generation !== 'string' ||
      !reply.generation ||
      (generation && reply.generation !== generation)
    )
      throw new NativeSessionSourceError('restart_required');
    generation = reply.generation;
  };
  const read = async <A>(query: NativeSessionRead): Promise<A> => {
    assertCurrent();
    const expectedGeneration = generation!;
    try {
      const reply = await options.transport.read({ ...scope, query, expectedGeneration });
      checkReply(reply);
      if (expectedGeneration !== generation) throw new NativeSessionSourceError('restart_required');
      return reply.result as A;
    } catch (error) {
      failure(error);
      throw error;
    }
  };
  const execute = async <A = void>(command: NativeSessionCommand): Promise<A> => {
    assertCurrent();
    const expectedGeneration = generation!;
    // Lost replies are unknown acceptance. Commands are never replayed.
    try {
      const reply = await options.transport.execute({ ...scope, command, expectedGeneration });
      checkReply(reply);
      if (expectedGeneration !== generation) throw new NativeSessionSourceError('restart_required');
      return reply.result as A;
    } catch (error) {
      failure(error);
      throw error;
    }
  };
  const refreshControl = async () => {
    const epoch = ++controlEpoch;
    try {
      const value = await read<NativeSessionControlState>({ kind: 'control' });
      if (!retired && epoch === controlEpoch) {
        control = value;
        publish();
      }
    } catch (error) {
      report(error);
    }
  };
  const matches = (event: NativeSessionEvent) =>
    event.registrationId === scope.registrationId &&
    event.sessionId === scope.sessionId &&
    event.requestId === scope.requestId;
  const deliver = (event: NativeSessionEvent) => {
    if (retired || !matches(event)) return;
    if (!leaseId) return;
    if (event.leaseId !== leaseId || event.generation !== generation) return;
    if (event.kind === 'error') {
      failure(new NativeSessionSourceError(event.code));
      return;
    }
    if (event.kind === 'control') {
      void refreshControl();
      return;
    }
    const change = event.change;
    if (
      (change.kind === 'changed' &&
        Array.isArray(change.ids) &&
        change.ids.every((id) => typeof id === 'string')) ||
      (change.kind === 'structure' &&
        Number.isSafeInteger(change.from) &&
        Number.isSafeInteger(change.to) &&
        change.from >= 0 &&
        change.to >= change.from)
    ) {
      for (const listener of historyListeners) {
        try {
          listener(change);
        } catch (error) {
          report(error);
        }
      }
    }
  };
  const detach = options.transport.subscribe(deliver);
  async function close(): Promise<void> {
    if (!retired) {
      retired = true;
      paused = true;
      control = undefined;
      ++controlEpoch;
      publish();
      detach();
      listeners.clear();
      historyListeners.clear();
    }
    if (cancellationConfirmed) return;
    if (release) return release;
    release = (async () => {
      // Unknown/rejected admissions retain their exact logical request. A server
      // cancel receipt fences even an observe that has not reached main yet.
      if (leaseId && !releaseFailure) {
        try {
          const ack = await options.transport.unobserve({ ...scope, leaseId });
          if (ack.released !== true) throw new NativeSessionSourceError('cleanup_unconfirmed');
          cancellationConfirmed = true;
          return;
        } catch (error) {
          releaseFailure = error;
          throw new NativeSessionSourceError('cleanup_unconfirmed', error);
        }
      }
      const ack = await options.transport.cancelObservation(scope);
      if (ack.canceled !== true) throw new NativeSessionSourceError('cleanup_unconfirmed');
      cancellationConfirmed = true;
    })().finally(() => {
      release = undefined;
    });
    return release;
  }
  const ready = (async () => {
    try {
      const first = await options.transport.read({ ...scope, query: { kind: 'control' } });
      checkReply(first);
      control = first.result as NativeSessionControlState;
      paused = false;
      publish();
      observationRequested = true;
      const observed = await options.transport.observe(scope);
      observationPending = false;
      if (retired) {
        leaseId = observed.leaseId;
        // If main already confirmed exact-request cancellation, this late reply
        // cannot resurrect the canceled server acquisition.
        if (!cancellationConfirmed) await close();
        throw new NativeSessionSourceError('restart_required');
      }
      checkReply(observed);
      if (typeof observed.leaseId !== 'string' || !observed.leaseId)
        throw new NativeSessionSourceError('operation_failed');
      leaseId = observed.leaseId;
      directoryCount = observed.initial.length;
      control = observed.control;
      paused = false;
      publish();
      await refreshControl();
      if (!retired && paused) throw new NativeSessionSourceError('restart_required');
    } catch (error) {
      observationPending = false;
      if (!retired) failure(error);
      throw error;
    }
  })();
  // Install a rejection observer immediately; consumers still await this exact
  // acquisition Promise and close retains the real server cleanup obligation.
  void ready.catch(report);
  const historyRead = <A>(query: NativeSessionRead, empty: A): Promise<A> =>
    denied ? Promise.resolve(empty) : read<A>(query);
  const history: SessionHistoryReader = {
    count: async () => {
      const count = await historyRead<number>({ kind: 'count' }, 0);
      directoryCount = count;
      return count;
    },
    readAt: (position) => historyRead({ kind: 'at', position }, { state: 'missing' }),
    readTurn: (turnId) => historyRead({ kind: 'turn', turnId }, { state: 'missing' }),
    readTurnForDisplay: (turnId) => historyRead({ kind: 'display', turnId }, { state: 'missing' }),
    readSubagentRun: (turnId, sessionId, runId) =>
      historyRead({ kind: 'run', turnId, sessionId, runId }, undefined),
    readRange: (from, to) => historyRead({ kind: 'range', from, to }, []),
    readDirectory: (from, to) => historyRead({ kind: 'directory', from, to }, []),
    readAll: () => historyRead({ kind: 'all' }, []),
    readTurnOutput: (turnId) => historyRead({ kind: 'output', turnId }, []),
    observe(listener) {
      if (!denied) assertCurrent();
      historyListeners.add(listener);
      // Register locally before the authoritative single-observation directory
      // request. Events stay live while this in-flight initial read completes.
      const initial = ready.then(() =>
        historyRead<readonly SessionDirectoryRow[]>({ kind: 'directorySnapshot' }, [])
      );
      return {
        initial,
        unsubscribe: () => {
          historyListeners.delete(listener);
        },
      };
    },
  };
  const sessionData: SessionData = {
    sessionId: options.sessionId,
    history,
    commands: {
      appendTurn: (turn) => execute({ kind: 'append', turn }),
      replaceTurn: (turnId, turn) => execute({ kind: 'replace', turnId, turn }),
      applyHistoryAction: (action) => execute({ kind: 'action', action }),
      respondPermission: (requestId, outcome, responseOptions) =>
        execute({ kind: 'permission', requestId, outcome, options: responseOptions }),
      applyHistoryImport: (input) => execute({ kind: 'import', input }),
      async replaceEditableTail(input) {
        const reply = await execute<
          | Exclude<SessionEditableTailResult, { status: 'accepted' }>
          | { status: 'accepted'; previousUserTurnId?: string; rollbackToken: string }
        >({ kind: 'editableTail', input });
        if (reply.status !== 'accepted') return reply;
        return {
          status: 'accepted',
          previousUserTurnId: reply.previousUserTurnId,
          rollback: () => execute({ kind: 'rollbackTail', token: reply.rollbackToken }),
        };
      },
    },
    snapshots: {
      async capture() {
        const captured = await execute<NativeSessionCapturedSnapshot>({ kind: 'capture' });
        const snapshot = { history: captured.history as SessionHistoryInput[] } as SessionSnapshot;
        snapshots.set(snapshot, {
          token: captured.token,
          transport: options.transport,
          registrationId: options.registrationId,
        });
        return snapshot;
      },
      async copyFrom(snapshot, selection) {
        const issued = snapshots.get(snapshot);
        if (
          !issued ||
          issued.transport !== options.transport ||
          issued.registrationId !== options.registrationId
        )
          throw new NativeSessionSourceError('access_denied');
        await execute({ kind: 'copy', token: issued.token, selection });
      },
    },
  };
  return {
    ready,
    sessionData,
    execute,
    read,
    close,
    async reacquire() {
      if (retired || denied) throw new NativeSessionSourceError('access_denied');
      try {
        const expectedGeneration = generation;
        const reply = await options.transport.read({
          ...scope,
          query: { kind: 'control' },
          ...(expectedGeneration ? { expectedGeneration } : {}),
        });
        checkReply(reply);
        control = reply.result as NativeSessionControlState;
        paused = false;
        publish();
      } catch (error) {
        failure(error);
        throw error;
      }
    },
    getSnapshot: () => control,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get generation() {
      return generation;
    },
    get available() {
      return !retired && !paused && !!generation;
    },
    get cleanupPending() {
      return (
        !cancellationConfirmed &&
        (observationPending ||
          observationRequested ||
          !!leaseId ||
          !!release ||
          releaseFailure !== undefined)
      );
    },
  };
}
export type NativeSessionIpcSource = ReturnType<typeof createNativeSessionIpcSource>;
