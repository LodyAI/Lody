import { HistoryWriteError } from '../history-write-schema';
import type { SessionHistoryInput, SessionPlanEntry } from '../index';
import { readSessionHistory, readLatestTurn } from '../session-data/read';
import type { SessionTurn, SessionSnapshot } from '../session-data';
import type { SessionBackend, SessionBackendForkSnapshot } from './native-session-contract';
import type { NativeSessionReader } from './native-session-reader';
import type { NativeSessionWriter } from './native-session-writer';
import { readDispatchHistory, readDispatchSelection } from './native-session-dispatch-history';

function historyPorts(reader: () => NativeSessionReader, writer: NativeSessionWriter) {
  return {
    kind: 'loro' as const,
    get history() {
      return reader().historyLossless;
    },
    async readHistory() {
      return (
        await reader().queryLossless(
          (view) => readSessionHistory(view.history) as SessionHistoryInput[]
        )
      ).value;
    },
    async foldHistory<T>(create: () => T, visit: (state: T, entry: SessionHistoryInput) => void) {
      return (
        await reader().queryLossless((view) => {
          const state = create();
          for (const entry of view.history.readAll())
            if (entry && typeof entry === 'object' && !Array.isArray(entry))
              visit(state, entry as SessionHistoryInput);
          return state;
        })
      ).value;
    },
    async readHistoryQuery(options?: {
      from?: number;
      to?: number;
      transcriptVisibility?: boolean;
    }) {
      return reader().query((view) =>
        view.readQuery(options).slice(options?.from ?? 0, options?.to)
      ).value;
    },
    async readHistorySelection(
      select: Parameters<SessionBackend['readHistorySelection']>[0],
      options?: { transcriptVisibility?: boolean }
    ) {
      return (
        await reader().queryLossless((view) =>
          select(view.readQuery(options)).map((position) => {
            if (!Number.isSafeInteger(position) || position < 0 || position >= view.history.count())
              throw new HistoryWriteError([{ path: ['history'], code: 'invalid_selection' }]);
            return view.valueAt(['history', position]) as SessionHistoryInput;
          })
        )
      ).value;
    },
    async readLatestGoal() {
      return reader().readLatestGoal();
    },
    async readLatestUserId() {
      return reader().readLatestUserId();
    },
    readDispatchHistory(include: readonly string[]) {
      return reader().query((view) => readDispatchHistory(view.history, include)).value;
    },
    readDispatchSelection(
      include: readonly string[],
      select: Parameters<SessionBackend['readDispatchSelection']>[1]
    ) {
      return reader().query((view) => readDispatchSelection(view.history, include, select)).value;
    },
    async captureForkSnapshot(): Promise<SessionBackendForkSnapshot> {
      const snapshot = await writer.snapshots.capture();
      return { backendKind: 'loro', history: snapshot.history, storageSnapshot: snapshot };
    },
    async importForkHistory(
      snapshot: SessionBackendForkSnapshot,
      selection: readonly SessionHistoryInput[]
    ) {
      if (snapshot.backendKind !== 'loro')
        throw new Error(`Cannot import ${snapshot.backendKind} fork snapshot into loro history`);
      await writer.snapshots.copyFrom(
        snapshot.storageSnapshot as SessionSnapshot,
        selection as readonly SessionTurn[]
      );
    },
    async readHistoryCount() {
      return reader().history.count();
    },
    async readHistoryDirectory(from: number, to: number) {
      return reader().history.readDirectory(from, to);
    },
    readLatestTurn(role: SessionTurn['role']) {
      return readLatestTurn(reader().historyLossless, role);
    },
    async readTurn(turnId: string) {
      return reader().historyLossless.readTurn(turnId);
    },
    async readTurnOutput(userTurnId: string) {
      return (await reader().historyLossless.readTurnOutput(userTurnId)) as SessionHistoryInput[];
    },
    subscribeHistory(listener: () => void) {
      const observation = reader().history.observe(() => listener());
      return () => observation.unsubscribe();
    },
    applyHistoryAction: writer.applyHistoryAction,
    applyHistoryImport: writer.applyHistoryImport,
    replaceEditableTail: writer.replaceEditableTail,
    openAssistantTurn: writer.openAssistantTurn,
    respondPermission: writer.respondPermission,
    applyAgentBatch: writer.applyAgentBatch,
    async appendHistoryTurn(turn: SessionHistoryInput) {
      await writer.appendTurn(turn as SessionTurn);
    },
    setPlan: (entries: readonly SessionPlanEntry[]) => writer.setPlan(entries),
  };
}

/** Explicit owner dependencies: queue/Meta transactions, activation/config guards,
 * storage ordering evidence, and persistence/remote convergence belong to the host.
 * A factory instance and its subscriptions belong to one per-room Scope/generation. */
export type NativeSessionBackendHostPorts = Omit<
  SessionBackend,
  keyof ReturnType<typeof historyPorts>
>;

export function createNativeSessionBackend(options: {
  readonly reader: () => NativeSessionReader;
  readonly writer: NativeSessionWriter;
  readonly host: NativeSessionBackendHostPorts;
}): SessionBackend {
  const owned = historyPorts(options.reader, options.writer);
  // Retain the getter instead of eagerly capturing a projection handle.
  return Object.defineProperties(
    { ...options.host },
    Object.getOwnPropertyDescriptors(owned)
  ) as typeof options.host & typeof owned;
}
