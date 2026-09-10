import { describe, expect, it } from 'vitest';
import { Loro, LoroList, LoroMap, LoroText, isContainer } from 'loro-crdt';
import { createSessionMirror } from '../src/session-mirror';
import type { SessionId } from '../src/ids';
import type { SessionHistory } from '../src/schema';

/**
 * Storage policy for newly written history items:
 *
 * - A plain metadata string (`toolCallId`/`status`/`title`/`kind`/`locations[].path`)
 *   becomes a primitive, not a `LoroText`.
 * - Only fields that stream (`text`/`thought`, `markdown`, `tool_call.content`,
 *   `worktree_script.steps`) create Text containers.
 *
 * The second half proves the policy is insertion-only: opening old storage performs no
 * writes, and same-type string edits keep whatever representation is already stored.
 */

const id = 'synthetic-session' as SessionId;
const open = (doc: Loro) =>
  createSessionMirror({ doc, initialState: { session: { id }, history: [] } });
const kindOf = (value: unknown): string => (isContainer(value) ? value.kind() : typeof value);
/** Read a stored map entry whether it is a primitive or a `LoroText`. */
const readString = (value: unknown): string =>
  isContainer(value) ? (value as LoroText).toJSON() : (value as string);

const toolCallItem = (overrides: Record<string, unknown> = {}) =>
  ({
    type: 'tool_call',
    toolCallId: 'tool-1',
    status: 'in_progress',
    title: 'Run tests',
    kind: 'execute',
    locations: [{ path: 'packages/shared/src/schema.ts' }],
    content: [
      { type: 'terminal_command', command: 'pnpm test' },
      { type: 'terminal_output', output: 'streaming output' },
    ],
    ...overrides,
  }) as unknown as SessionHistory['items'][number];

const turn = (turnId: string, items: SessionHistory['items']): SessionHistory => ({
  id: turnId,
  role: 'assistant',
  timestamp: '2026-01-01T00:00:00Z',
  items,
  fileDiff: [],
});

const storedContainerKinds = (doc: Loro) => {
  const row = doc.getList('history').get(0) as LoroMap;
  const items = row.get('items') as LoroList;
  const text = items.get(0) as LoroMap;
  const thought = items.get(1) as LoroMap;
  const plan = items.get(2) as LoroMap;
  const tool = items.get(3) as LoroMap;
  const content = tool.get('content') as LoroList;
  const script = items.get(4) as LoroMap;
  const steps = script.get('steps') as LoroList;
  return {
    'row.id': kindOf(row.get('id')),
    'row.role': kindOf(row.get('role')),
    'text.text': kindOf(text.get('text')),
    'thought.text': kindOf(thought.get('text')),
    'plan.markdown': kindOf(plan.get('markdown')),
    'tool.type': kindOf(tool.get('type')),
    'tool.toolCallId': kindOf(tool.get('toolCallId')),
    'tool.status': kindOf(tool.get('status')),
    'tool.title': kindOf(tool.get('title')),
    'tool.kind': kindOf(tool.get('kind')),
    'tool.locations[0].path': kindOf(
      ((tool.get('locations') as LoroList).get(0) as LoroMap).get('path')
    ),
    'content[0].command': kindOf((content.get(0) as LoroMap).get('command')),
    'content[1].output': kindOf((content.get(1) as LoroMap).get('output')),
    'content[1].type': kindOf((content.get(1) as LoroMap).get('type')),
    'steps[0].command': kindOf((steps.get(0) as LoroMap).get('command')),
    'steps[0].output': kindOf((steps.get(0) as LoroMap).get('output')),
  };
};

const richItems = (output = 'streaming output'): SessionHistory['items'] =>
  [
    { type: 'text', text: 'hello' },
    { type: 'thought', text: 'thinking' },
    {
      type: 'proposed_plan',
      turnId: 'plan-1',
      markdown: '# plan',
      status: 'delta',
      isLatest: true,
    },
    toolCallItem({
      content: [
        { type: 'terminal_command', command: 'pnpm test' },
        { type: 'terminal_output', output },
      ],
    }),
    {
      type: 'worktree_script',
      phase: 'setup',
      status: 'completed',
      steps: [{ command: 'pnpm install', status: 'completed', output: 'ok' }],
    },
  ] as unknown as SessionHistory['items'];

const richTurn = (output = 'streaming output'): SessionHistory => turn('rich', richItems(output));

describe('new history storage policy', () => {
  it('stores metadata as primitives and only streaming fields as Text', () => {
    const doc = new Loro();
    const mirror = open(doc);
    try {
      mirror.historyWriter.append(richTurn());
      expect(storedContainerKinds(doc)).toEqual({
        'row.id': 'string',
        'row.role': 'string',
        'text.text': 'Text',
        'thought.text': 'Text',
        'plan.markdown': 'Text',
        'tool.type': 'string',
        'tool.toolCallId': 'string',
        'tool.status': 'string',
        'tool.title': 'string',
        'tool.kind': 'string',
        'tool.locations[0].path': 'string',
        'content[0].command': 'Text',
        'content[1].output': 'Text',
        'content[1].type': 'string',
        'steps[0].command': 'Text',
        'steps[0].output': 'Text',
      });
    } finally {
      mirror.dispose();
    }
  });

  it('keeps a streamed tool output Text container across repeated updates', () => {
    const doc = new Loro();
    const mirror = open(doc);
    try {
      mirror.historyWriter.append(richTurn());
      const tool = ((doc.getList('history').get(0) as LoroMap).get('items') as LoroList).get(
        3
      ) as LoroMap;
      const content = tool.get('content') as LoroList;
      const containerId = (content.get(1) as LoroMap).get('output') as LoroText;
      for (const output of ['streaming output', 'streaming output + more']) {
        mirror.historyWriter.replace('rich', richTurn(output));
      }
      expect(doc.getContainerById(containerId.id)?.toJSON()).toBe('streaming output + more');
    } finally {
      mirror.dispose();
    }
  });
});

describe('legacy storage is insertion-only', () => {
  /** Build a stored turn by hand so we control the pre-existing container kind. */
  function seedDoc(options: { pathAsText: boolean; unknownFields?: boolean }) {
    const doc = new Loro();
    const row = doc.getList('history').pushContainer(new LoroMap());
    row.set('id', 'legacy');
    row.set('role', 'assistant');
    row.set('timestamp', '2026-01-01T00:00:00Z');
    if (options.unknownFields) {
      row.set('futureTurnField', 7);
      row.set('sendStatus', 'timeout');
    }
    const items = row.setContainer('items', new LoroList());
    const tool = items.pushContainer(new LoroMap());
    tool.set('type', 'tool_call');
    tool.set('toolCallId', 'tool-legacy');
    tool.set('status', 'completed');
    tool.set('title', 'Read file');
    tool.set('kind', 'read');
    if (options.unknownFields) tool.set('futureToolField', 'kept');
    const locations = tool.setContainer('locations', new LoroList());
    const location = locations.pushContainer(new LoroMap());
    // The pre-#443 writer stored metadata strings as Text. A legacy peer may also have
    // stored a primitive; both layouts must survive an unrelated edit.
    if (options.pathAsText) {
      (location.setContainer('path', new LoroText()) as LoroText).insert(
        0,
        'packages/shared/src/schema.ts'
      );
    } else {
      location.set('path', 'packages/shared/src/schema.ts');
    }
    const content = tool.setContainer('content', new LoroList());
    const output = content.pushContainer(new LoroMap());
    output.set('type', 'terminal_output');
    (output.setContainer('output', new LoroText()) as LoroText).insert(0, 'legacy output');
    doc.commit();
    return { doc, tool, location, output };
  }

  for (const pathAsText of [true, false]) {
    it(`edits a legacy ${pathAsText ? 'Text' : 'primitive'} path in place without migrating it`, () => {
      const { doc, location } = seedDoc({ pathAsText });
      const pathBefore = location.get('path');
      const versionBefore = doc.version().toJSON();
      const mirror = open(doc);
      try {
        // Opening/reading must not write anything.
        expect(doc.version().toJSON()).toEqual(versionBefore);
        mirror.historyWriter.setField('legacy', 'finished', true);
        expect(doc.toJSON().history[0].finished).toBe(true);
        // The unrelated control-field write did not touch the stored path layout.
        expect(kindOf(location.get('path'))).toBe(pathAsText ? 'Text' : 'string');
        expect(readString(location.get('path'))).toBe('packages/shared/src/schema.ts');
        // A Text path keeps its exact container identity; a primitive stays primitive.
        const after = location.get('path');
        if (pathAsText) expect((after as LoroText).id).toBe((pathBefore as LoroText).id);
        else expect(readString(after)).toBe('packages/shared/src/schema.ts');
      } finally {
        mirror.dispose();
      }
    });
  }

  it('retains unknown stored fields and does not rewrite the legacy turn', () => {
    const { doc, tool } = seedDoc({ pathAsText: true, unknownFields: true });
    const before = doc.toJSON().history[0];
    const toolJsonBefore = tool.toJSON();
    const mirror = open(doc);
    try {
      mirror.historyWriter.append(turn('appended', [{ type: 'text', text: 'next' } as never]));
      const rows = doc.toJSON().history as Array<Record<string, unknown>>;
      expect(rows[0]).toEqual(before);
      expect(rows[1].id).toBe('appended');
      expect(tool.toJSON()).toEqual(toolJsonBefore);
    } finally {
      mirror.dispose();
    }
  });

  it('updates one item while retaining an unchanged opaque item verbatim', () => {
    const { doc } = seedDoc({ pathAsText: true, unknownFields: true });
    const row = doc.getList('history').get(0) as LoroMap;
    const items = row.get('items') as LoroList;
    const appended = items.pushContainer(new LoroMap());
    appended.set('type', 'future_item');
    appended.set('payload', { nested: true });
    doc.commit();
    const opaqueBefore = appended.toJSON();
    const mirror = open(doc);
    try {
      mirror.historyWriter.updateEntry('legacy', (entry) => ({
        ...entry,
        finished: true,
      }));
      expect(doc.toJSON().history[0].finished).toBe(true);
      expect((items.get(1) as LoroMap).toJSON()).toEqual(opaqueBefore);
    } finally {
      mirror.dispose();
    }
  });
});

describe('malformed legacy values do not block unrelated writes', () => {
  it('accepts an unrelated edit while an unparsed legacy list value stays stored', () => {
    const doc = new Loro();
    const row = doc.getList('history').pushContainer(new LoroMap());
    row.set('id', 'odd');
    row.set('role', 'assistant');
    row.set('timestamp', 'old');
    const items = row.setContainer('items', new LoroList());
    const tool = items.pushContainer(new LoroMap());
    tool.set('type', 'tool_call');
    tool.set('toolCallId', 'tool-odd');
    tool.set('status', 'completed');
    // Homogeneous legacy key, heterogeneous shape: `locations` is a Map, not a list.
    const locations = tool.setContainer('locations', new LoroMap());
    locations.set('legacy', 'shape');
    doc.commit();
    const mirror = open(doc);
    try {
      // Editing an independent field must not reparse or reject the odd payload.
      mirror.historyWriter.setField('odd', 'finished', true);
      expect(doc.toJSON().history[0].finished).toBe(true);
      expect(doc.toJSON().history[0].items[0].locations).toEqual({ legacy: 'shape' });
    } finally {
      mirror.dispose();
    }
  });
});

describe('two real peers exchange both representations', () => {
  it('keeps the new primitive layout and a legacy Text layout consistent across peers', () => {
    const a = new Loro();
    const b = new Loro();
    a.setPeerId('1');
    b.setPeerId('2');
    const mirrorA = open(a);
    const mirrorB = open(b);
    try {
      // A writes a new turn with the primitive metadata policy.
      mirrorA.historyWriter.append(richTurn());
      b.import(a.export({ mode: 'snapshot' }));
      const mirrorB2 = open(b);
      const tool = ((b.getList('history').get(0) as LoroMap).get('items') as LoroList).get(
        3
      ) as LoroMap;
      expect(tool.get('toolCallId')).toBe('tool-1');
      expect(kindOf(tool.get('toolCallId'))).toBe('string');

      // B concurrently updates the streamed output Text while A updates a scalar field.
      const content = tool.get('content') as LoroList;
      const output = (content.get(1) as LoroMap).get('output') as LoroText;
      output.update('streaming output + peer');
      b.commit();
      mirrorA.historyWriter.setField('rich', 'finished', true);

      a.import(b.export({ mode: 'update', from: a.version() }));
      b.import(a.export({ mode: 'update', from: b.version() }));
      expect(a.toJSON()).toEqual(b.toJSON());
      expect(a.toJSON().history[0].finished).toBe(true);
      expect(a.toJSON().history[0].items[3].content[1].output).toBe('streaming output + peer');
      mirrorB2.dispose();
    } finally {
      mirrorA.dispose();
      mirrorB.dispose();
    }
  });
});

describe('opening stored history is read-only', () => {
  it('hydrates a legacy doc without changing its version or layout', () => {
    const doc = new Loro();
    const row = doc.getList('history').pushContainer(new LoroMap());
    row.set('id', 'legacy');
    row.set('role', 'user');
    row.set('timestamp', 'old');
    const items = row.setContainer('items', new LoroList());
    const text = items.pushContainer(new LoroMap());
    text.set('type', 'text');
    (text.setContainer('text', new LoroText()) as LoroText).insert(0, 'old body');
    doc.commit();
    const version = doc.version().toJSON();
    const history = doc.getList('history').toJSON();
    const mirror = open(doc);
    try {
      // Mirror initializes empty control containers in memory; the durable version is
      // unchanged, which is what proves opening performed no writes.
      expect(doc.version().toJSON()).toEqual(version);
      expect(doc.getList('history').toJSON()).toEqual(history);
      expect(mirror.getState().history[0]!.items![0]).toEqual({ type: 'text', text: 'old body' });
    } finally {
      mirror.dispose();
    }
  });
});
