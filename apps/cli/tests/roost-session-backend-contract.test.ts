import { describe, expect, it } from 'vitest';
import { defineSessionBackendContract } from './session-backend-contract';
import {
  createRoostFixtureReader,
  createRoostSessionBackendFixture,
  userEntry,
} from './roost-session-backend-fixture';

defineSessionBackendContract('Roost test adapter', createRoostSessionBackendFixture);

describe('Roost test adapter logical history', () => {
  it('forwards logical history changes and stops after unsubscribe', async () => {
    const { backend } = createRoostFixtureReader();
    const changes: number[] = [];
    const unsubscribe = backend.subscribeHistory(() => changes.push(changes.length + 1));

    await backend.appendHistoryTurn({
      id: 'user-1',
      role: 'user',
      timestamp: '2026-10-03T00:00:00.000Z',
      items: [{ type: 'text', text: 'one' }],
      fileDiff: [],
    });
    expect(changes).toEqual([1]);

    unsubscribe();
    await backend.appendHistoryTurn({
      id: 'user-2',
      role: 'user',
      timestamp: '2026-10-03T00:00:01.000Z',
      items: [{ type: 'text', text: 'two' }],
      fileDiff: [],
    });
    expect(changes).toEqual([1]);
  });

  it('keeps a late assistant segment in one logical turn', async () => {
    const { backend, store } = createRoostFixtureReader();
    await backend.appendHistoryTurn({
      id: 'assistant-1',
      role: 'assistant',
      timestamp: '2026-10-03T00:00:01.000Z',
      userTurnId: userEntry.id,
      items: [{ type: 'text', text: 'first' }],
      fileDiff: [],
      finished: false,
    });
    await backend.appendHistoryTurn({
      id: 'assistant-1',
      role: 'assistant',
      timestamp: '2026-10-03T00:00:01.000Z',
      userTurnId: userEntry.id,
      items: [{ type: 'text', text: 'late' }],
      fileDiff: [],
      finished: true,
    });

    expect(await backend.readHistory()).toEqual([
      expect.objectContaining({
        id: 'assistant-1',
        finished: true,
        items: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'late' },
        ],
      }),
    ]);
    expect((await store.readProjectedMessages()).map((segment) => segment.segmentId)).toHaveLength(
      2
    );
  });
});
