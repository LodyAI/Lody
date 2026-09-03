import { describe, expect, it } from 'vitest';

import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

import type { MessageContent } from '../src/ai';
import type { SessionId } from '../src/ai';
import { sessionDocSchema } from '../src/schema';

/**
 * Session history shape compatibility (phase 2a reader side).
 *
 * Upcoming writers will store sealed turns with:
 * - `summary`: a derived per-turn summary,
 * - `live`: a LoroMap streaming container `{ kind, text }`,
 * - tool_call items as skeletons (`kind`/`status`/`title`/`locations`/`ref`)
 *   whose execution payload (`content`/`rawInput`/`rawOutput`) stays on the
 *   origin machine.
 *
 * These tests prove the current schema validates BOTH shapes and that data
 * written in the old shape round-trips byte-for-byte unchanged (the optional
 * declarations added for the new shape materialize no containers when unset).
 */

const sessionId = 'session-history-shapes' as SessionId;

const oldShapeToolCall = {
  type: 'tool_call',
  toolCallId: 'call-1',
  title: 'ls -la',
  status: 'completed',
  kind: 'execute',
  content: [
    { type: 'terminal_command', command: 'ls', args: ['-la'], cwd: '/tmp' },
    { type: 'terminal_output', output: 'total 0' },
  ],
  rawInput: { command: 'ls -la' },
  rawOutput: { exitCode: 0 },
} satisfies Record<string, unknown>;

const skeletonToolCall = {
  type: 'tool_call',
  kind: 'execute',
  status: 'completed',
  title: 'ls -la',
  locations: [{ path: '/tmp' }],
  ref: { machineId: 'machine-1', turnId: 'turn-1', index: 2 },
} as unknown as MessageContent;

const turnSummary = {
  itemCount: 3,
  textChars: 120,
  thoughtChars: 40,
  headText: 'Let me look at the files.',
  activity: {
    commandCount: 1,
    editFileCount: 0,
    readFileCount: 2,
    searchCount: 0,
    failedCount: 0,
  },
  editedPaths: [],
};

function createSessionMirror(doc: Loro) {
  return new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: sessionId }, history: [] },
  });
}

describe('session history shapes', () => {
  it('round-trips an old-shape doc (full tool_call payloads) unchanged', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);

    mirror.setState((state) => {
      state.history.push({
        id: 'turn-1',
        role: 'assistant',
        timestamp: '2026-09-01T00:00:00.000Z',
        finished: true,
        items: [
          { type: 'text', text: 'Here is the listing.' },
          oldShapeToolCall as unknown as MessageContent,
        ],
      });
      state.externalHistoryCursor = { importedTurnHashes: ['abc123'] };
    });

    const snapshot = doc.export({ mode: 'snapshot' });

    const reopened = new Loro();
    reopened.import(snapshot);
    const reopenedMirror = createSessionMirror(reopened);

    const entry = reopenedMirror.getState().history[0]!;
    expect(entry.items?.[0]).toEqual({ type: 'text', text: 'Here is the listing.' });
    expect(entry.items?.[1]).toEqual(oldShapeToolCall);
    // No new-shape keys materialize for old-shape data: a current writer emits
    // exactly the containers it emitted before the declarations were added.
    expect(entry).not.toHaveProperty('summary');
    expect(entry).not.toHaveProperty('live');
    expect(reopenedMirror.getState().externalHistoryCursor).toEqual({
      importedTurnHashes: ['abc123'],
    });
  });

  it('accepts summary, live, and skeleton tool_calls', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);

    mirror.setState((state) => {
      state.history.push({
        id: 'turn-1',
        role: 'assistant',
        timestamp: '2026-09-01T00:00:00.000Z',
        finished: true,
        summary: turnSummary,
        live: { kind: 'text', text: 'streamed head' },
        items: [skeletonToolCall],
      });
      state.externalHistoryCursor = { importedTurnHashes: ['def456'], hashVersion: 2 };
    });

    const entry = mirror.getState().history[0]!;
    expect(entry.summary).toEqual(turnSummary);
    expect(entry.live).toEqual({ kind: 'text', text: 'streamed head' });
    expect(entry.items?.[0]).toEqual(skeletonToolCall);
    expect(mirror.getState().externalHistoryCursor?.hashVersion).toBe(2);

    // The new-shape doc must also survive an export/import cycle.
    const reopened = new Loro();
    reopened.import(doc.export({ mode: 'snapshot' }));
    const reopenedMirror = createSessionMirror(reopened);
    expect(reopenedMirror.getState().history[0]!.items?.[0]).toEqual(skeletonToolCall);
    expect(reopenedMirror.getState().history[0]!.summary).toEqual(turnSummary);
  });

  it('still rejects a tool_call with neither toolCallId nor ref', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);

    expect(() => {
      mirror.setState((state) => {
        state.history.push({
          id: 'turn-1',
          role: 'assistant',
          timestamp: '2026-09-01T00:00:00.000Z',
          items: [{ type: 'tool_call', status: 'completed' } as unknown as MessageContent],
        });
      });
    }).toThrow();
  });

  it('still rejects a malformed tool_call ref', () => {
    const doc = new Loro();
    const mirror = createSessionMirror(doc);

    expect(() => {
      mirror.setState((state) => {
        state.history.push({
          id: 'turn-1',
          role: 'assistant',
          timestamp: '2026-09-01T00:00:00.000Z',
          items: [
            {
              type: 'tool_call',
              status: 'completed',
              ref: { machineId: 'machine-1' },
            } as unknown as MessageContent,
          ],
        });
      });
    }).toThrow();
  });
});
