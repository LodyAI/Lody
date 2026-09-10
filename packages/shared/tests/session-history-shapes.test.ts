import { describe, expect, it } from 'vitest';
import { Loro, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import type { MachineId, MessageContent } from '../src/ai';
import type { SessionId } from '../src/ids';
import { MessageContentSchema } from '../src/message-schemas';
import { sessionDocSchema } from '../src/schema';
import { createSessionMirror } from '../src/session-mirror';

/**
 * Reader compatibility for sealed tool_call skeletons.
 *
 * The writer that seals turns is NOT part of this change. These tests prove the
 * current readers express and safely read BOTH shapes: a full tool_call (with
 * `toolCallId` + payload) and a ref-only skeleton (no `toolCallId`, no
 * `content`, payload pointer `ref`). The TS type (`MessageContent`) and the
 * runtime validators (Zod + Loro schema) must agree, and a skeleton's
 * `ref.index` must survive unrelated edits without renumbering.
 */

const sessionId = 'session-history-shapes' as SessionId;
const skeletonRef = {
  machineId: 'machine-1' as MachineId,
  turnId: 'turn-1',
  index: 2,
};

const fullToolCall: MessageContent = {
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
};

// No cast: the shared type must express a ref-only skeleton directly.
const skeletonToolCall: MessageContent = {
  type: 'tool_call',
  kind: 'execute',
  status: 'completed',
  title: 'ls -la',
  locations: [{ path: '/tmp' }],
  ref: skeletonRef,
};

function openMirror(doc: Loro) {
  return createSessionMirror({ doc, initialState: { session: { id: sessionId }, history: [] } });
}

function readMirror(doc: Loro) {
  return new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
  });
}

function turn(id: string, items: MessageContent[]) {
  return {
    id,
    role: 'assistant' as const,
    timestamp: '2026-09-01T00:00:00.000Z',
    finished: true,
    items,
  };
}

describe('tool_call shape contract', () => {
  it('accepts a full tool_call, a ref-only skeleton, and a full call carrying a ref', () => {
    expect(MessageContentSchema.safeParse(fullToolCall).success).toBe(true);
    expect(MessageContentSchema.safeParse(skeletonToolCall).success).toBe(true);
    expect(MessageContentSchema.safeParse({ ...fullToolCall, ref: skeletonRef }).success).toBe(
      true
    );
  });

  it('rejects a tool_call with neither toolCallId nor ref, and a malformed ref', () => {
    expect(MessageContentSchema.safeParse({ type: 'tool_call', status: 'completed' }).success).toBe(
      false
    );
    expect(
      MessageContentSchema.safeParse({
        type: 'tool_call',
        status: 'completed',
        ref: { machineId: 'machine-1', turnId: 'turn-1' },
      }).success
    ).toBe(false);
  });
});

describe('reading a stored skeleton', () => {
  it('writes and re-reads a ref-only skeleton with its ref intact', () => {
    const doc = new Loro();
    const mirror = openMirror(doc);
    try {
      mirror.historyWriter.append(turn('turn-1', [skeletonToolCall]) as never);
      // The shared writer must accept it...
      expect(doc.getList('history').toJSON()[0].items[0]).toEqual(skeletonToolCall);

      // ...and a fresh Mirror read must not reject the stored document.
      const reader = readMirror(doc);
      try {
        const entry = reader.getState().history[0]!;
        expect(entry.items?.[0]).toEqual(skeletonToolCall);
      } finally {
        reader.dispose();
      }
    } finally {
      mirror.dispose();
    }
  });

  it('keeps a skeleton and its ref.index through an unrelated turn edit', () => {
    const doc = new Loro();
    const mirror = openMirror(doc);
    try {
      mirror.historyWriter.append(turn('turn-1', [skeletonToolCall]) as never);
      const row = doc.getList('history').get(0) as LoroMap;
      const items = row.get('items') as LoroList;
      const skeleton = items.get(0) as LoroMap;
      const refBefore = (skeleton.get('ref') as LoroMap).toJSON();

      mirror.historyWriter.setField('turn-1', 'finished', true);

      expect(row.get('finished')).toBe(true);
      expect((items.get(0) as LoroMap).toJSON()).toEqual(skeletonToolCall);
      expect(((items.get(0) as LoroMap).get('ref') as LoroMap).toJSON()).toEqual(refBefore);
    } finally {
      mirror.dispose();
    }
  });

  it('appends a new turn without rewriting the stored skeleton, preserving item order', () => {
    const doc = new Loro();
    const mirror = openMirror(doc);
    try {
      mirror.historyWriter.append(turn('turn-1', [skeletonToolCall]) as never);
      const before = doc.getList('history').toJSON()[0];
      mirror.historyWriter.append(turn('turn-2', [{ type: 'text', text: 'next' }]) as never);
      const rows = doc.getList('history').toJSON() as Array<{ id: string }>;
      expect(rows[0]).toEqual(before);
      expect(rows.map((r) => r.id)).toEqual(['turn-1', 'turn-2']);
    } finally {
      mirror.dispose();
    }
  });

  it('rejects a new identity-less tool_call before writing anything', () => {
    const doc = new Loro();
    const mirror = openMirror(doc);
    try {
      expect(() =>
        mirror.historyWriter.append(
          turn('bad', [
            { type: 'tool_call', status: 'completed' } as unknown as MessageContent,
          ]) as never
        )
      ).toThrow('Invalid history write');
      expect(doc.getList('history').length).toBe(0);
    } finally {
      mirror.dispose();
    }
  });
});

describe('old-shape round-trip is unchanged', () => {
  it('round-trips a full tool_call payload without materializing new keys', () => {
    const doc = new Loro();
    const mirror = openMirror(doc);
    try {
      mirror.historyWriter.append(turn('turn-1', [fullToolCall]) as never);
      const snapshot = doc.export({ mode: 'snapshot' });
      const reopened = new Loro();
      reopened.import(snapshot);
      const reader = readMirror(reopened);
      try {
        expect(reader.getState().history[0]!.items?.[0]).toEqual(fullToolCall);
        expect(reader.getState().history[0]).not.toHaveProperty('summary');
        expect(reader.getState().history[0]).not.toHaveProperty('live');
      } finally {
        reader.dispose();
      }
    } finally {
      mirror.dispose();
    }
  });
});

describe('unrelated sealed turn-level keys do not break reading', () => {
  it('loads a turn carrying unknown derived keys and still accepts an unrelated write', () => {
    const doc = new Loro();
    const row = doc.getList('history').pushContainer(new LoroMap());
    row.set('id', 'turn-legacy');
    row.set('role', 'assistant');
    row.set('timestamp', 'old');
    // A future sealed writer may add these; readers must ignore them safely.
    const summary = row.setContainer('summary', new LoroMap());
    summary.set('itemCount', 3);
    const live = row.setContainer('live', new LoroMap());
    live.set('kind', 'text');
    (live.setContainer('text', new LoroText()) as LoroText).insert(0, 'streamed');
    const items = row.setContainer('items', new LoroList());
    const skeleton = items.pushContainer(new LoroMap());
    skeleton.set('type', 'tool_call');
    skeleton.set('status', 'completed');
    skeleton.set('kind', 'execute');
    const ref = skeleton.setContainer('ref', new LoroMap());
    ref.set('machineId', 'machine-1');
    ref.set('turnId', 'turn-1');
    ref.set('index', 2);
    doc.commit();
    const version = doc.version().toJSON();

    const mirror = openMirror(doc);
    try {
      // Opening is read-only even with the unknown keys present.
      expect(doc.version().toJSON()).toEqual(version);
      // An unrelated append must still succeed and leave the stored turn untouched.
      const before = doc.getList('history').toJSON()[0];
      mirror.historyWriter.append(turn('turn-2', [{ type: 'text', text: 'ok' }]) as never);
      expect(doc.getList('history').toJSON()[0]).toEqual(before);
    } finally {
      mirror.dispose();
    }
  });
});
