import { describe, expect, it } from 'vitest';
import {
  createRoostHistoryReader,
  projectRoostSegments,
  type RoostHistoryChange,
  type RoostHistoryPort,
  type RoostHistorySegment,
} from '../src/session-data';

const user = (businessId = 'user-1'): RoostHistorySegment => ({
  businessId,
  segmentId: 'primary',
  sealed: true,
  content: {
    role: 'user',
    timestamp: '2026-10-03T00:00:00.000Z',
    items: [{ type: 'text', text: 'hello' }],
    status: 'handled',
    inputConfig: { modeId: 'default', prompt: 'must stay out of directory' },
  },
});

const assistant = (segmentId: string, content: Record<string, unknown>): RoostHistorySegment => ({
  businessId: 'assistant-1',
  segmentId,
  sealed: segmentId !== 'primary',
  content: {
    role: 'assistant',
    timestamp: '2026-10-03T00:00:01.000Z',
    userTurnId: 'user-1',
    ...content,
  },
});

class FakeRoostPort implements RoostHistoryPort {
  segments: RoostHistorySegment[];
  reads = 0;
  private readonly listeners = new Set<(change: RoostHistoryChange) => void>();

  constructor(segments: RoostHistorySegment[]) {
    this.segments = segments;
  }

  readProjectedMessages(): Promise<readonly RoostHistorySegment[]> {
    this.reads += 1;
    return Promise.resolve(this.segments.map((segment) => ({ ...segment })));
  }

  observe(listener: (change: RoostHistoryChange) => void) {
    this.listeners.add(listener);
    const initial = Promise.resolve(this.segments.map((segment) => ({ ...segment })));
    return {
      initial,
      unsubscribe: () => this.listeners.delete(listener),
    };
  }

  emit(change: RoostHistoryChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

describe('Roost logical history projection', () => {
  it('groups successor segments into one logical turn without mutating the primary', () => {
    const segments = [
      user(),
      assistant('primary', { items: [{ type: 'text', text: 'first' }], finished: false }),
      assistant('late-output', { items: [{ type: 'text', text: 'late' }], finished: true }),
    ];

    const entries = projectRoostSegments(segments);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      userTurnId: 'user-1',
      finished: true,
    });
    expect(entries[1]?.items).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'late' },
    ]);
    expect(segments[1]?.content).toMatchObject({ finished: false });
  });

  it('exposes logical positions, directory scalars, and selected turn output', async () => {
    const port = new FakeRoostPort([
      user(),
      assistant('primary', { items: [{ type: 'text', text: 'answer' }], finished: true }),
      {
        businessId: 'system-1',
        segmentId: 'primary',
        sealed: true,
        content: {
          role: 'system',
          timestamp: '2026-10-03T00:00:02.000Z',
          items: [{ type: 'system_notice', name: 'agent_warning', meta: {} }],
        },
      },
    ]);
    const reader = createRoostHistoryReader(port);

    expect(await reader.count()).toBe(3);
    expect(await reader.readRange(1, 3)).toHaveLength(2);
    expect(await reader.readTurn('assistant-1')).toMatchObject({
      state: 'ready',
      turn: { id: 'assistant-1', finished: true },
    });
    expect(await reader.readDirectory(0, 1)).toEqual([
      expect.objectContaining({
        position: 0,
        turnId: 'user-1',
        state: 'ready',
        itemCount: 1,
        inputConfig: { modeId: 'default' },
      }),
    ]);
    expect(await reader.readTurnOutput('user-1')).toEqual([
      expect.objectContaining({ id: 'user-1', role: 'user' }),
      expect.objectContaining({ id: 'assistant-1', role: 'assistant' }),
    ]);
  });

  it('keeps the gap-free initial snapshot and invalidates only after a port change', async () => {
    const port = new FakeRoostPort([user()]);
    const reader = createRoostHistoryReader(port);
    const changes: unknown[] = [];
    const observation = reader.observe((change) => changes.push(change));

    await expect(observation.initial).resolves.toHaveLength(1);
    expect(await reader.count()).toBe(1);

    port.segments.push(assistant('primary', { items: [{ type: 'text', text: 'answer' }] }));
    port.emit({ kind: 'changed', businessIds: ['assistant-1'] });
    expect(changes).toEqual([{ kind: 'changed', ids: ['assistant-1'] }]);
    expect(await reader.count()).toBe(2);

    port.segments.push({
      businessId: 'user-2',
      segmentId: 'primary',
      sealed: true,
      content: { role: 'user', timestamp: '2026-10-03T00:00:03.000Z' },
    });
    port.emit({ kind: 'structure', from: 2, to: 3 });
    expect(await reader.count()).toBe(3);
    observation.unsubscribe();
  });

  it('refreshes reads when no live observation owns the cache', async () => {
    const port = new FakeRoostPort([user()]);
    const reader = createRoostHistoryReader(port);

    expect(await reader.count()).toBe(1);
    expect(port.reads).toBe(1);

    port.segments.push({
      businessId: 'user-2',
      segmentId: 'primary',
      sealed: true,
      content: {
        role: 'user',
        timestamp: '2026-10-03T00:00:03.000Z',
        items: [{ type: 'text', text: 'new' }],
      },
    });

    expect(await reader.count()).toBe(2);
    expect(port.reads).toBe(2);
  });

  it('ignores a late port callback after unsubscribe', async () => {
    let callback: ((change: RoostHistoryChange) => void) | undefined;
    const port: RoostHistoryPort = {
      readProjectedMessages: () => Promise.resolve([user()]),
      observe(listener) {
        callback = listener;
        return {
          initial: Promise.resolve([user()]),
          // This deliberately does not stop the callback. The reader owns the
          // final unsubscribe fence even when an adapter drains one callback.
          unsubscribe: () => {},
        };
      },
    };
    const reader = createRoostHistoryReader(port);
    const changes: RoostHistoryChange[] = [];
    const observation = reader.observe((change) => changes.push(change));
    await observation.initial;
    observation.unsubscribe();

    callback?.({ kind: 'changed', businessIds: ['user-1'] });
    expect(changes).toEqual([]);
  });

  it('rejects malformed logical segments before they reach the renderer', () => {
    expect(() =>
      projectRoostSegments([
        {
          businessId: 'bad',
          segmentId: 'primary',
          sealed: true,
          content: { role: 'assistant' },
        },
      ])
    ).toThrow(/timestamp/);
  });
});
