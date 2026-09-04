import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { sessionDocSchema, type SessionHistoryInput, type SessionId } from '@lody/shared';

import {
  appendHistoryEntry,
  findHistoryIndex,
  replaceHistoryEntry,
  respondHistoryPermission,
} from '../src/lib/conversation-view/history-writer';

const sessionId = 'session-1' as SessionId;

/** Container-kind tree of the doc, with values, e.g. `<Map>{ text: <Text>"hi" }`. */
function shapeOf(doc: LoroDoc): unknown {
  const kindOf = (cid: string) => cid.slice(cid.lastIndexOf(':') + 1);
  const walk = (node: unknown): unknown => {
    if (node && typeof node === 'object' && 'cid' in (node as object)) {
      const { value, cid } = node as { value: unknown; cid: string };
      return { $kind: kindOf(cid), value: walk(value) };
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)])
      );
    }
    return node;
  };
  return walk((doc.getDeepValueWithID() as { history: unknown }).history);
}

function viaMirror(history: SessionHistoryInput[]): LoroDoc {
  const doc = new LoroDoc();
  const mirror = new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: sessionId }, history: [] },
  });
  mirror.setState((prev) => ({ ...prev, history: history as never }));
  doc.commit();
  return doc;
}

function viaWriter(history: SessionHistoryInput[]): LoroDoc {
  const doc = new LoroDoc();
  for (const entry of history) appendHistoryEntry(doc, entry);
  return doc;
}

const userTurn = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  status: 'seen',
  read: true,
  finished: true,
  fileDiff: [],
  items: [{ type: 'text', text: `hello ${id}` }] as never,
  inputConfig: {
    prompt: `hello ${id}`,
    cliType: 'builtin',
    agentType: 'claude',
    inputBlocks: [{ type: 'text', text: `hello ${id}` }],
    mcpServerIds: [],
    configOptionValues: { reasoning_effort: 'high' },
  } as never,
});

const assistantTurn = (id: string): SessionHistoryInput => ({
  id,
  role: 'assistant',
  timestamp: '2026-01-01T00:00:01.000Z',
  finished: true,
  endedAt: 1_700_000_000_000,
  fileDiff: [{ filePath: 'a.ts', additions: 1, deletions: 0 }],
  modelInfo: { id: 'model', name: 'Model' } as never,
  plan: [{ content: 'step', status: 'completed', priority: 'medium' }] as never,
  items: [
    { type: 'thought', text: 'thinking' },
    {
      type: 'tool_call',
      toolCallId: 'tc1',
      title: 'Run ls',
      kind: 'execute',
      status: 'completed',
      locations: [{ path: 'a.ts' }],
      content: [
        { type: 'terminal_command', command: 'ls', cwd: '/x', args: ['-la'] },
        {
          type: 'terminal_output',
          output: 'a\nb',
          stream: 'combined',
          truncated: false,
          exitStatus: { exitCode: 0, signal: null },
        },
      ],
      permissionRequest: { requestId: 'req-1', options: [{ optionId: 'allow', name: 'Allow' }] },
    },
    { type: 'text', text: 'done' },
  ] as never,
});

describe('HistoryWriter', () => {
  it('writes the same container shapes as a full-schema Mirror', () => {
    const history = [userTurn('u1'), assistantTurn('a1'), userTurn('u2')];
    expect(shapeOf(viaWriter(history))).toEqual(shapeOf(viaMirror(history)));
  });

  it('reads back through the full-schema Mirror as the same state', () => {
    const history = [userTurn('u1'), assistantTurn('a1')];
    const doc = viaWriter(history);
    const mirror = new Mirror({ doc, schema: sessionDocSchema, ignoreUnknownProperties: true });
    const expected = new Mirror({
      doc: viaMirror(history),
      schema: sessionDocSchema,
      ignoreUnknownProperties: true,
    });
    expect(JSON.parse(JSON.stringify(mirror.getState().history))).toEqual(
      JSON.parse(JSON.stringify(expected.getState().history))
    );
  });

  it('replaces an entry in place and keeps the turn container id', () => {
    const doc = viaWriter([userTurn('u1'), assistantTurn('a1')]);
    const before = (doc.getList('history').getShallowValue() as string[])[1];
    const changed = { ...assistantTurn('a1'), finished: false, endedAt: undefined, status: 'seen' };
    expect(replaceHistoryEntry(doc, 'a1', changed as SessionHistoryInput)).toBe(true);
    const after = (doc.getList('history').getShallowValue() as string[])[1];
    expect(after).toBe(before);
    const state = new Mirror({
      doc,
      schema: sessionDocSchema,
      ignoreUnknownProperties: true,
    }).getState().history as unknown as Record<string, unknown>[];
    expect(state[1]).toMatchObject({ id: 'a1', finished: false, status: 'seen' });
    expect(state[1]).not.toHaveProperty('endedAt');
    expect(findHistoryIndex(doc, 'a1')).toBe(1);
    expect(findHistoryIndex(doc, 'missing')).toBe(-1);
  });

  it('records a permission outcome the same way the Mirror path did', () => {
    const history = [assistantTurn('a1')];
    const outcome = { outcome: 'selected', optionId: 'allow' };
    const docW = viaWriter(history);
    expect(respondHistoryPermission(docW, 'req-1', outcome)).toBe(true);
    expect(respondHistoryPermission(docW, 'req-missing', outcome)).toBe(false);

    const docM = viaMirror(history);
    const mirror = new Mirror({
      doc: docM,
      schema: sessionDocSchema,
      ignoreUnknownProperties: true,
    });
    mirror.setState((draft) => {
      const items = (draft.history[0] as { items: { permissionRequest?: { outcome?: unknown } }[] })
        .items;
      items[1]!.permissionRequest!.outcome = outcome;
    });
    docM.commit();
    expect(shapeOf(docW)).toEqual(shapeOf(docM));
  });
});
