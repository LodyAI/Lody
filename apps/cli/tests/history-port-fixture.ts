import { selectTurnOutput } from '../../../packages/shared/src/session-data/read';
import { pickDirectoryScalars } from '../../../packages/shared/src/session-data/directory';
import { createHistoryWriter } from '@lody/shared';
import type { LoroDoc } from 'loro-crdt';
import { applyHistoryAction } from '../../../packages/shared/src/session-data/history-actions';
import type { SessionData, SessionEntry, HistoryAction } from '@lody/shared/session-data';

/** Service-test storage owner. Preserve each fixture's injected persistence
 * failures while exposing the same data-only history commands as production.
 * Backend correctness is covered separately over real Loro storage. */
export function withHistoryPort<T extends object>(fixture: T): T & { sessionData: SessionData } {
  const storage = fixture as T & {
    getHistory?: () => SessionEntry[];
    readHistorySnapshot?: () => SessionEntry[];
    updateHistory?: (update: (history: SessionEntry[]) => SessionEntry[]) => Promise<void>;
    sessionData?: Partial<SessionData>;
    mirror?: { subscribe: (listener: () => void) => () => void };
    subscribeAll?: (listener: () => void) => () => void;
  };
  const read = () => storage.getHistory?.() ?? storage.readHistorySnapshot?.() ?? [];
  const commands = {
    async applyHistoryAction(action: HistoryAction) {
      let plan: ReturnType<typeof applyHistoryAction> | undefined;
      if (action.kind === 'operation-progress' || action.kind === 'task-proposal') {
        plan = applyHistoryAction(structuredClone(read()), action);
        if (!plan.matched) return { matched: false, proposal: plan.proposal };
      }
      if (!storage.updateHistory) throw new Error('Fixture has no history writer');
      await storage.updateHistory((history) => {
        plan = applyHistoryAction(history, action);
        return plan.turns;
      });
      return {
        matched:
          plan?.matched ?? (action.kind === 'user-status' && action.requeueUndelivered === true),
        proposal: plan?.proposal,
      };
    },
    async appendTurn(turn: SessionEntry) {
      if (!storage.updateHistory) throw new Error('Fixture has no history writer');
      await storage.updateHistory((history) => [...history, turn]);
    },
  };
  storage.sessionData = {
    ...storage.sessionData,
    history: {
      readTurnOutput: (userTurnId: string) => {
        const snapshot = read();
        return selectTurnOutput(
          snapshot.length,
          userTurnId,
          (index) => pickDirectoryScalars(snapshot[index]),
          (index) => snapshot[index]
        );
      },
      count: () => read().length,
      readTurn: (id: string) => {
        const turn = read().find((t) => t.id === id);
        return turn ? { state: 'ready', turn } : { state: 'missing' };
      },
      readDirectory: (from: number, to: number) =>
        read()
          .slice(from, to)
          .map((t, i) => ({
            position: from + i,
            turnId: t.id,
            state: 'ready',
            scalars: { ...t, items: undefined },
          })),
      observe: () => ({ initial: Promise.resolve([]), unsubscribe: () => {} }),
      ...storage.sessionData?.history,
      readAll: read,
    },
    commands: { ...commands, ...storage.sessionData?.commands },
  } as SessionData;
  storage.subscribeAll ??= (listener) => storage.mirror?.subscribe(listener) ?? (() => {});
  return fixture as T & { sessionData: SessionData };
}

/** Test-only seed/edit helper; application code cannot receive a history callback. */
export async function updateTestHistory(
  doc: {
    handle?: { doc: LoroDoc } | null;
    updateHistory?: (fn: (history: SessionEntry[]) => SessionEntry[]) => Promise<void>;
  },
  update: (history: SessionEntry[]) => SessionEntry[],
  options?: { onlyEntryId: string }
): Promise<void> {
  if (doc.handle) {
    const writer = createHistoryWriter(doc.handle.doc);
    if (options && writer.updateEntry(options.onlyEntryId, (entry) => update([entry])[0] ?? entry))
      return;
    writer.update(update);
    return;
  }
  if (doc.updateHistory) {
    await doc.updateHistory(update);
    return;
  }
  throw new Error('Test fixture has no backing store');
}
