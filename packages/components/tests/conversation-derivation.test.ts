import { writeStoredField } from './conversation-view-fixtures';
import { openReaderView } from './conversation-view-fixtures';
import { describe, expect, it } from 'vitest';
import { LoroMap, type ContainerID, type LoroList } from 'loro-crdt';
import { resolveLatestSessionGoalFromHistory, type SessionGoalMessage } from '@lody/shared';
import { createLoroSessionData, type LoroSessionData } from '@lody/shared/session-data';
import {
  createConversationDerivation,
  createConversationViewFromReader,
  type ConversationView,
} from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
  reimport,
} from './conversation-view-fixtures';

/** Drain microtasks until `done()` or the bound is hit. No timers, no sleeps. */
const drain = async (done: () => boolean, bound = 200): Promise<void> => {
  for (let i = 0; i < bound && !done(); i += 1) await Promise.resolve();
};

const immediate = () => Promise.resolve();

const openView = async (
  rounds: number,
  options: { tailKeep?: number; maxHydrated?: number; hydrateChunkSize?: number } = {}
) => {
  const doc = reimport(buildSessionDoc(buildFixtureHistory(rounds)));
  const idle = createManualIdle();
  const view = await openReaderView(doc, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: options.tailKeep ?? 2,
    maxHydrated: options.maxHydrated ?? 4,
    hydrateChunkSize: options.hydrateChunkSize ?? 64,
    hydrateItemBudget: 10_000,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: immediate,
  });
  return { doc, idle, view };
};

const turnMapAt = (doc: ReturnType<typeof openView>['doc'], index: number): LoroMap => {
  const cid = (doc.getList('history') as LoroList).getShallowValue()[index] as ContainerID;
  return doc.getContainerById(cid) as LoroMap;
};

const countHydrated = (view: ConversationView): number => {
  let hydrated = 0;
  for (let i = 0; i < view.turnCount; i += 1) if (view.isHydrated(i)) hydrated += 1;
  return hydrated;
};

/** One fact per turn: how many file diffs it carries. */
const deriveDiffCount = (turn: { fileDiff?: unknown }) => ({
  diffs: Array.isArray(turn.fileDiff) ? turn.fileDiff.length : 0,
});

describe('createConversationDerivation', () => {
  it.each(['loro'] as const)(
    'refreshes evicted goal and diff facts through the shipped reader (%s)',
    async (backend) => {
      const history = buildFixtureHistory(50);
      const goal: SessionGoalMessage = {
        type: 'goal',
        threadId: 'goal-thread',
        objective: 'Finish the task',
        status: 'active',
      };
      history[1]!.items.push(goal);
      const doc = buildSessionDoc(history);
      const data: LoroSessionData =
        backend === 'loro'
          ? createLoroSessionData({ sessionId: FIXTURE_SESSION_ID, doc })
          : (() => {
              throw new Error('unknown fixture backend');
            })();
      const idle = createManualIdle();
      const view = createConversationViewFromReader(data.history, {
        sessionId: FIXTURE_SESSION_ID,
        tailKeep: 2,
        maxHydrated: 4,
        scheduleIdle: idle.scheduleIdle,
        yieldToEventLoop: immediate,
      });
      await drain(() => view.turnCount === history.length, 1000);
      const derivation = createConversationDerivation(
        view,
        (turn) => ({
          goal: resolveLatestSessionGoalFromHistory([turn]),
          ...deriveDiffCount(turn),
        }),
        { chunkSize: 8, yieldToEventLoop: immediate }
      );
      await drain(() => derivation.complete, 10000);
      expect(derivation.complete).toBe(true);
      const target = view.indexOf('a-0');
      expect(view.isHydrated(target)).toBe(false);
      expect(derivation.facts.get('a-0')?.goal?.status).toBe('active');
      for (const status of ['paused', 'active', 'cleared'] as const) {
        const eviction = view.acquireRange(20, 28);
        await eviction.ready;
        eviction.release();
        expect(view.isHydrated(target)).toBe(false);
        const result = await data.commands.applyHistoryAction(
          status === 'cleared'
            ? { kind: 'clear-goal', threadId: goal.threadId, updatedAt: 10 }
            : { kind: 'upsert-goal', goal: { ...goal, status }, fallback: history[1]! }
        );
        expect(result.matched).toBe(true);
        await drain(
          () => derivation.complete && derivation.facts.get('a-0')?.goal?.status === status,
          10000
        );
        expect(derivation.facts.get('a-0')?.goal?.status).toBe(status);
      }
      const result = await writeStoredField(data, 'a-0', 'fileDiff', {
        kind: 'set',
        value: [
          { filePath: 'src/new.ts', add: 1, del: 0 },
          { filePath: 'src/another.ts', add: 2, del: 0 },
        ],
      });
      expect(result.status).toBe('accepted');
      await drain(() => derivation.complete && derivation.facts.get('a-0')?.diffs === 2, 10000);
      expect(derivation.facts.get('a-0')?.diffs).toBe(2);
      expect(derivation.facts.size).toBe(history.length);
      derivation.dispose();
      view.dispose();
    }
  );
});
