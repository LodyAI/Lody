import { selectTurnOutput } from '../../../packages/shared/src/session-data/read';
import { pickDirectoryScalars } from '../../../packages/shared/src/session-data/directory';
import { createHistoryWriter } from '@lody/shared';
import type { LoroDoc } from 'loro-crdt';
import { applyHistoryAction } from '../../../packages/shared/src/session-data/history-actions';
import { HistoryActionRefused } from '../../../packages/shared/src/session-data/task-proposal';
import type { SessionData, SessionEntry, HistoryAction } from '@lody/shared/session-data';

/** Service-test storage owner. Preserve each fixture's injected persistence
 * failures while exposing the same data-only history commands as production.
 * Backend correctness is covered separately over real Loro storage. */
export function withHistoryPort<T extends object>(fixture: T): T & { sessionData: SessionData } {
  const storage = fixture as T & {
    getHistory?: () => Promise<SessionEntry[]>;
    readHistorySnapshot?: () => SessionEntry[];
    updateHistory?: (update: (history: SessionEntry[]) => SessionEntry[]) => Promise<void>;
    sessionData?: Partial<SessionData>;
    mirror?: { subscribe: (listener: () => void) => () => void };
    subscribeAll?: (listener: () => void) => () => void;
  };
  const read = () =>
    storage.getHistory?.() ?? Promise.resolve(storage.readHistorySnapshot?.() ?? []);
  const accepted = (kind: string) => ({
    status: 'accepted' as const,
    receipt: { kind, sessionId: 'fixture', turnIds: [] },
  });
  const commands = {
    async applyHistoryAction(action: HistoryAction) {
      let plan: ReturnType<typeof applyHistoryAction> | undefined;
      try {
        if (action.kind === 'operation-progress' || action.kind === 'task-proposal') {
          plan = applyHistoryAction(structuredClone(await read()), action);
          if (!plan.matched)
            return { ...accepted('history-action'), matched: false, proposal: plan.proposal };
        }
        if (!storage.updateHistory) throw new Error('Fixture has no history writer');
        await storage.updateHistory((history) => {
          plan = applyHistoryAction(history, action);
          return plan.turns;
        });
        return {
          ...accepted('history-action'),
          matched:
            plan?.matched ?? (action.kind === 'user-status' && action.requeueUndelivered === true),
          proposal: plan?.proposal,
        };
      } catch (error) {
        if (error instanceof HistoryActionRefused)
          return { status: 'rejected' as const, reason: { code: 'conflict' } };
        throw error;
      }
    },
    async appendTurn(turn: SessionEntry) {
      if (!storage.updateHistory) throw new Error('Fixture has no history writer');
      await storage.updateHistory((history) => [...history, turn]);
      return accepted('append');
    },
  };
  storage.sessionData = {
    ...storage.sessionData,
    history: {
      readTurnOutput: async (userTurnId: string) => {
        const snapshot = await read();
        return selectTurnOutput(
          snapshot.length,
          userTurnId,
          (index) => pickDirectoryScalars(snapshot[index]),
          (index) => snapshot[index]
        );
      },
      count: async () => (await read()).length,
      readTurn: async (id: string) => {
        const turn = (await read()).find((t) => t.id === id);
        return turn ? { state: 'ready', turn } : { state: 'missing' };
      },
      readDirectory: async (from: number, to: number) =>
        (await read()).slice(from, to).map((t, i) => ({
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
