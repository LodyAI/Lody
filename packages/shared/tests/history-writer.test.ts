import { describe, expect, it } from 'vitest';
import { Loro, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { z } from 'zod';
import { parseHistoryWrite } from '../src/history-write-schema';
import { createSessionMirror } from '../src/session-mirror';
import { sessionDocSchema, type SessionHistory } from '../src/schema';
import type { SessionId } from '../src/ids';
import type { StoredHistorySnapshot } from '../src/history-writer';

const id = 'synthetic-session' as SessionId;
const entry = (turnId = 'turn'): SessionHistory => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-01-01T00:00:00Z',
  items: [{ type: 'text', text: 'hello' }],
  fileDiff: [],
});
const open = (doc: Loro) =>
  createSessionMirror({ doc, initialState: { session: { id }, history: [] } });

describe('single history writer', () => {
  it('filters nested config extensions on append and resend without rewriting stored input', () => {
    const doc = new Loro();
    const stored = {
      ...entry('old'),
      inputConfig: {
        cliType: 'claude',
        inputBlocks: [{ type: 'text', text: 'hello', futureKey: true }],
        issuePRMentions: [
          {
            type: 'issue',
            title: 'Synthetic',
            url: 'https://example.com/1',
            number: 1,
            futureKey: true,
          },
        ],
      },
    };
    const row = doc.getList('history').pushContainer(new LoroMap());
    for (const [key, value] of Object.entries(stored)) row.set(key, value);
    doc.commit();
    const mirror = open(doc);
    try {
      const expectedConfig = {
        cliType: 'builtin',
        agentType: 'claude',
        inputBlocks: [{ type: 'text', text: 'hello' }],
        issuePRMentions: [
          { type: 'issue', title: 'Synthetic', url: 'https://example.com/1', number: 1 },
        ],
      };
      mirror.historyWriter.append({ ...stored, id: 'appended' } as unknown as SessionHistory);
      expect(doc.getList('history').toJSON()[1].inputConfig).toEqual(expectedConfig);
      expect(row.toJSON()).toEqual(stored);
      // A fresh resend authors a new turn from the old turn's configuration.
      const rollback = mirror.historyWriter.updateWithRollback((history) => [
        ...history,
        { ...history[0]!, id: 'resent' },
      ]);
      expect(doc.getList('history').toJSON()[2].inputConfig).toEqual(expectedConfig);
      expect(row.toJSON()).toEqual(stored);
      rollback();
      const version = doc.version().toJSON();
      expect(() =>
        mirror.historyWriter.append({
          ...stored,
          id: 'invalid',
          inputConfig: {
            ...stored.inputConfig,
            inputBlocks: [{ type: 'text', text: 42, futureKey: true }],
          },
        } as unknown as SessionHistory)
      ).toThrow();
      expect(doc.version().toJSON()).toEqual(version);
      expect(row.toJSON()).toEqual(stored);
    } finally {
      mirror.dispose();
    }
  });

  it.each(['claude', 'codex'])('normalizes legacy %s config only on new writes', (cliType) => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append({
      ...entry(),
      inputConfig: { cliType },
    } as unknown as SessionHistory);
    expect(doc.getList('history').toJSON()[0].inputConfig).toEqual({
      cliType: 'builtin',
      agentType: cliType,
    });
    expect(() =>
      mirror.historyWriter.append({
        ...entry('invalid'),
        inputConfig: { cliType: 'invalid' },
      } as unknown as SessionHistory)
    ).toThrow();
    mirror.dispose();
  });

  it('edits independent fields without reparsing damaged stored config, tool or proposal fields', () => {
    const doc = new Loro();
    const row = doc.getList('history').pushContainer(new LoroMap());
    const stored = {
      ...entry(),
      inputConfig: { modeId: null, agentRoleId: '', future: true },
      items: [
        { type: 'tool_call', toolCallId: 'tool', status: 'in_progress', kind: 'future-kind' },
        {
          type: 'system_notice',
          name: 'task_proposal',
          meta: { proposalId: 'proposal', title: 42, future: true },
        },
      ],
    };
    for (const [key, value] of Object.entries(stored)) row.set(key, value);
    doc.commit();
    const mirror = open(doc);
    mirror.historyWriter.updateEntry('turn', (turn) => {
      turn.inputConfig!._lodyDeliveryKind = 'steer';
      const tool = turn.items![0]!;
      if (tool.type === 'tool_call') {
        tool.status = 'completed';
        tool.rawOutput = { ok: true };
      }
      const proposal = turn.items![1]!;
      if (proposal.type === 'system_notice' && proposal.name === 'task_proposal')
        proposal.meta!.outcome = 'dismissed';
    });
    expect(doc.getList('history').toJSON()[0]).toMatchObject({
      inputConfig: { ...stored.inputConfig, _lodyDeliveryKind: 'steer' },
      items: [
        { ...stored.items[0], status: 'completed', rawOutput: { ok: true } },
        { ...stored.items[1], meta: { ...stored.items[1]!.meta, outcome: 'dismissed' } },
      ],
    });
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.updateEntry('turn', (turn) => {
        const tool = turn.items![0]!;
        if (tool.type === 'tool_call') tool.rawOutput = 42 as never;
      })
    ).toThrow();
    expect(doc.version().toJSON()).toEqual(version);
    mirror.dispose();
  });

  it('derives an input parser without mutating strict schemas or dropping refinements', () => {
    const schema = z
      .object({ nested: z.object({ count: z.number() }).strict() })
      .strict()
      .superRefine((value, ctx) => {
        if (value.nested.count < 0) ctx.addIssue({ code: 'custom', message: 'negative' });
      });
    const input = { nested: { count: 2, future: true, $cid: 'transport' }, extra: true };
    expect(parseHistoryWrite(schema, input)).toEqual({ nested: { count: 2 } });
    expect(schema.safeParse(input).success).toBe(false);
    expect(() => parseHistoryWrite(schema, { nested: { count: -1, extra: true } })).toThrow(
      'custom'
    );
    expect(input.nested.$cid).toBe('transport');
    const pipeline = z
      .preprocess((value) => ({ nested: value }), schema)
      .transform((value) => ({ count: value.nested.count + 1 }));
    expect(parseHistoryWrite(pipeline, { count: 2, future: true })).toEqual({ count: 3 });
    expect(pipeline.safeParse({ count: 2, future: true }).success).toBe(false);
    expect(() => parseHistoryWrite(pipeline, { count: -1, future: true })).toThrow('custom');
  });

  it('updates a target after peer insert/delete without touching other turns', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('prefix'));
    mirror.historyWriter.append(entry('target'));
    const peer = new Loro();
    peer.import(doc.export({ mode: 'snapshot' }));
    const peerMirror = open(peer);
    const oldPrefix = doc.getList('history').get(0) as LoroMap;
    expect(
      mirror.historyWriter.updateEntry('target', (turn) => {
        turn.items = [{ type: 'text', text: 'first' }];
        return turn;
      })
    ).toBe(true);
    peerMirror.historyWriter.update((history) => [entry('inserted'), ...history]);
    doc.import(peer.export({ mode: 'update', from: doc.version() }));
    mirror.historyWriter.updateEntry('target', (turn) => {
      turn.items = [{ type: 'text', text: 'second' }];
      return turn;
    });
    expect(oldPrefix.toJSON().items).toEqual(entry().items);
    expect(mirror.historyWriter.read('inserted')?.items).toEqual(entry().items);
    expect(mirror.historyWriter.read('target')?.items).toEqual([{ type: 'text', text: 'second' }]);
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.updateEntry('target', (turn) => ({ ...turn, id: 'other' }))
    ).toThrow('immutable_id');
    expect(() =>
      mirror.historyWriter.updateEntry('target', (turn) => ({ ...turn, finished: 'bad' as never }))
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    peer.import(doc.export({ mode: 'update', from: peer.version() }));
    peerMirror.historyWriter.update((history) => history.filter((turn) => turn.id !== 'target'));
    doc.import(peer.export({ mode: 'update', from: doc.version() }));
    expect(mirror.historyWriter.updateEntry('target', (turn) => turn)).toBe(false);
    expect(doc.getList('history').toJSON()).toEqual(peer.getList('history').toJSON());
    mirror.dispose();
    peerMirror.dispose();
  });

  it('updates only the requested field beside opaque history and preserves nested extensions', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const turn = doc.getList('history').pushContainer(new LoroMap());
    turn.set('id', 'field-target');
    turn.set('role', 'assistant');
    turn.set('items', [{ type: 'future', payload: { text: 42 } }]);
    turn.set('fileDiff', [{ filePath: 'a.ts', add: 1, del: 0, future: 'keep' }]);
    doc.commit();
    const items = turn.get('items');
    mirror.historyWriter.setField('field-target', 'fileDiff', [
      { filePath: 'a.ts', add: 2, del: 0 },
    ]);
    expect(turn.toJSON().fileDiff).toEqual([{ filePath: 'a.ts', add: 2, del: 0, future: 'keep' }]);
    mirror.historyWriter.setField('field-target', 'finished', true);
    mirror.historyWriter.setField('field-target', 'finished', undefined);
    expect(turn.get('items')).toEqual(items);
    expect(turn.keys()).not.toContain('finished');
    const version = doc.version().toJSON();
    expect(() => mirror.historyWriter.setField('field-target', 'finished', 'bad' as never)).toThrow(
      'Invalid history write'
    );
    expect(() =>
      mirror.historyWriter.setField('field-target', 'items' as never, [] as never)
    ).toThrow('invalid_field');
    expect(doc.version().toJSON()).toEqual(version);
    const detached = mirror.historyWriter.readStored();
    detached[0]!.items = [];
    expect(turn.get('items')).toEqual(items);
    mirror.dispose();
  });

  it.each(['before-rollback', 'after-rollback'] as const)(
    'preserves a peer prefix edit arriving %s',
    (arrival) => {
      const doc = new Loro();
      const mirror = open(doc);
      for (const name of ['prefix', 'old', 'answer']) mirror.historyWriter.append(entry(name));
      const before = doc.getList('history').toJSON();
      const prefixCid = (doc.getList('history').get(0) as LoroMap).id;
      const peer = new Loro();
      peer.import(doc.export({ mode: 'snapshot' }));
      const peerMirror = open(peer);
      const rollback = mirror.historyWriter.updateWithRollback((history) => [
        history[0]!,
        entry('replacement'),
      ]);
      peerMirror.historyWriter.update((history) => {
        history[0]!.items = [{ type: 'text', text: 'peer edit' }];
        return history;
      });
      if (arrival === 'before-rollback')
        doc.import(peer.export({ mode: 'update', from: doc.version() }));
      rollback();
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
      peer.import(doc.export({ mode: 'update', from: peer.version() }));
      const expected = [
        { ...before[0], items: [{ type: 'text', text: 'peer edit' }] },
        ...before.slice(1),
      ];
      expect(doc.getList('history').toJSON()).toEqual(expected);
      expect(peer.getList('history').toJSON()).toEqual(expected);
      expect((doc.getList('history').get(0) as LoroMap).id).toBe(prefixCid);
      expect(() => rollback()).toThrow('stale_rollback');
      mirror.dispose();
      peerMirror.dispose();
    }
  );

  it('refuses edits to the replacement without partially restoring the tail', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('old'));
    const rollback = mirror.historyWriter.updateWithRollback(() => [entry('replacement')]);
    mirror.historyWriter.update((history) => {
      history[0]!.items = [{ type: 'text', text: 'new work' }];
      return history;
    });
    const version = doc.version().toJSON();
    expect(() => rollback()).toThrow('stale_rollback');
    expect(doc.version().toJSON()).toEqual(version);
    expect(mirror.historyWriter.read('replacement')?.items).toEqual([
      { type: 'text', text: 'new work' },
    ]);
    mirror.dispose();
  });

  it('appends beside damaged old tool blocks and keeps extensions on their own variants', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const map = doc.getList('history').pushContainer(new LoroMap());
    for (const [key, value] of Object.entries({
      ...entry(),
      items: [
        {
          type: 'tool_call',
          toolCallId: 'legacy',
          status: 'in_progress',
          content: [
            { type: 'text', text: 42 },
            { type: 'text', text: 'old', providerExtra: 1 },
          ],
        },
      ],
    }))
      map.set(key, value);
    doc.commit();
    mirror.historyWriter.update((history) => {
      const tool = history[0]!.items![0]!;
      if (tool.type === 'tool_call') tool.content!.push({ type: 'text', text: 'new' } as never);
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0].content[0]).toEqual({
      type: 'text',
      text: 42,
    });
    mirror.historyWriter.update((history) => {
      const tool = history[0]!.items![0]!;
      if (tool.type === 'tool_call')
        tool.content![1] = { type: 'text', text: 'edited', providerExtra: 2 } as never;
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0].content[1].providerExtra).toBe(2);
    mirror.historyWriter.update((history) => {
      const tool = history[0]!.items![0]!;
      if (tool.type === 'tool_call')
        tool.content![1] = { type: 'diff', path: 'synthetic.ts', newText: 'new' };
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0].content[1]).toEqual({
      type: 'diff',
      path: 'synthetic.ts',
      newText: 'new',
    });
    mirror.dispose();
  });

  it('retains JSON protocol extensions without admitting malformed known tool blocks', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const tool = {
      type: 'tool_call',
      toolCallId: 'extension-tool',
      status: 'in_progress',
      _meta: { provider: { revision: 1 } },
      locations: [{ path: 'synthetic.ts', endColumn: 12, futureLocation: true }],
      content: [{ type: 'future_block', payload: { revision: 1 } }],
    };
    mirror.historyWriter.append({
      ...entry(),
      role: 'assistant',
      items: [tool],
    } as unknown as SessionHistory);
    mirror.historyWriter.update((history) => {
      const item = history[0]!.items![0]!;
      if (item.type === 'tool_call')
        item.content!.push({ type: 'content', content: { type: 'text', text: 'later' } });
      return history;
    });
    expect(doc.getList('history').toJSON()[0].items[0]).toMatchObject({
      ...tool,
      content: [tool.content[0], { type: 'content', content: { type: 'text', text: 'later' } }],
    });
    expect(doc.getList('history').toJSON()[0].items[0].content).toHaveLength(2);
    const before = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.append({
        ...entry('bad'),
        items: [{ ...tool, content: [{ type: 'text', text: 42 }] }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(() =>
      mirror.historyWriter.append({
        ...entry('bad-json'),
        items: [{ ...tool, content: [{ type: 'future_block', payload: () => {} }] }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(before);
    mirror.dispose();
  });

  it('copies opaque stored content without blessing new malformed input or changing the source', () => {
    const source = new Loro();
    const sourceMirror = open(source);
    const map = source.getList('history').insertContainer(0, new LoroMap());
    const stored = {
      ...entry(),
      futureTurn: { version: 3 },
      items: [
        { type: 'future_item', text: 42, payload: { nested: [null, 'opaque'] } },
        { type: 'text', text: 42, futureField: 'keep' },
        { type: 'text', text: 'valid', futureMetadata: { revision: 3 } },
      ],
    };
    for (const [key, value] of Object.entries(stored)) map.set(key, value);
    source.commit();
    const snapshot = sourceMirror.historyWriter.capture();
    const sourceVersion = source.version().toJSON();
    // A consumer cannot mutate the private baseline, even through its returned view.
    snapshot.history[0]!.items = [{ type: 'text', text: 'tampered' }];
    const target = new Loro();
    const targetMirror = open(target);
    const version = target.version().toJSON();
    expect(() =>
      targetMirror.historyWriter.copyFrom(
        { history: snapshot.history } as StoredHistorySnapshot,
        snapshot.history
      )
    ).toThrow('invalid_snapshot');
    const malformed = {
      ...entry('new'),
      items: [{ type: 'text', text: 42 }],
    } as unknown as SessionHistory;
    expect(() =>
      targetMirror.historyWriter.copyFrom(snapshot, [...snapshot.history, malformed])
    ).toThrow('Invalid history write');
    expect(() =>
      targetMirror.historyWriter.copyFrom(snapshot, [
        { ...snapshot.history[0]!, finished: 'bad' } as unknown as SessionHistory,
      ])
    ).toThrow('Invalid history write');
    expect(target.version().toJSON()).toEqual(version);
    targetMirror.historyWriter.copyFrom(snapshot, [
      { ...snapshot.history[0]!, read: true },
      entry('new'),
    ]);
    expect(target.getList('history').toJSON()[0]).toEqual({ ...stored, read: true });
    expect(source.getList('history').toJSON()).toEqual([stored]);
    expect(source.version().toJSON()).toEqual(sourceVersion);
    expect(() => targetMirror.historyWriter.copyFrom(snapshot, snapshot.history)).toThrow(
      'copy_target_conflict'
    );
    const reopened = new Loro();
    reopened.import(target.export({ mode: 'snapshot' }));
    expect(reopened.getList('history').toJSON()).toEqual(target.getList('history').toJSON());
    targetMirror.historyWriter.replace('new', {
      ...entry('new'),
      items: [{ type: 'text', text: 'streamed' }],
    });
    expect(target.getList('history').toJSON()[0]).toEqual({ ...stored, read: true });
    sourceMirror.dispose();
    targetMirror.dispose();
  });

  it('updates tool permission and status without reparsing untouched opaque content', () => {
    const peer = new Loro();
    const row = peer.getList('history').pushContainer(new LoroMap());
    const tool = {
      type: 'tool_call',
      toolCallId: 'tool',
      status: 'pending',
      content: [{ type: 'future_tool_content', data: { value: 42 } }],
      permissionRequest: {
        requestId: 'request',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    };
    for (const [key, value] of Object.entries({ ...entry(), role: 'assistant', items: [tool] }))
      row.set(key, value);
    peer.commit();
    const doc = new Loro();
    doc.import(peer.export({ mode: 'snapshot' }));
    const mirror = open(doc);
    expect(
      mirror.historyWriter.respondPermission('request', { outcome: 'selected', optionId: 'allow' })
    ).toBe(true);
    mirror.historyWriter.update((history) => {
      const item = history[0]!.items![0]!;
      if (item.type === 'tool_call') item.status = 'completed';
      return history;
    });
    const stored = doc.getList('history').toJSON()[0].items[0];
    expect(stored.content).toEqual(tool.content);
    expect(stored.status).toBe('completed');
    expect(stored.permissionRequest.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.replace('turn', {
        ...mirror.historyWriter.read('turn')!,
        items: [{ ...stored, status: 42 }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(() =>
      mirror.historyWriter.replace('turn', {
        ...mirror.historyWriter.read('turn')!,
        items: [{ ...stored, content: [{ type: 'text', text: 42 }] }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    peer.import(doc.export({ mode: 'update', from: peer.version() }));
    expect(peer.getList('history').toJSON()).toEqual(doc.getList('history').toJSON());
    mirror.dispose();
  });

  it('restores deleted opaque history with a one-use receipt, refusing intervening peer edits', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('prefix'));
    const old = doc.getList('history').insertContainer(1, new LoroMap());
    for (const [key, value] of Object.entries({
      ...entry('old'),
      items: [{ type: 'future_item', value: 42 }],
    }))
      old.set(key, value);
    doc.commit();
    const before = doc.getList('history').toJSON();
    const prefixId = (doc.getList('history').get(0) as LoroMap).id;
    const rollback = mirror.historyWriter.updateWithRollback((history) => [
      history[0]!,
      entry('replacement'),
    ]);
    rollback();
    expect(doc.getList('history').toJSON()).toEqual(before);
    expect((doc.getList('history').get(0) as LoroMap).id).toBe(prefixId);
    expect(() => rollback()).toThrow('stale_rollback');
    const stale = mirror.historyWriter.updateWithRollback((history) => [
      history[0]!,
      entry('replacement'),
    ]);
    const peer = new Loro();
    peer.import(doc.export({ mode: 'snapshot' }));
    const peerMirror = open(peer);
    peerMirror.historyWriter.append(entry('peer'));
    doc.import(peer.export({ mode: 'update', from: doc.version() }));
    stale();
    expect(doc.getList('history').toJSON()).toEqual([...before, entry('peer')]);
    mirror.dispose();
    peerMirror.dispose();
  });

  it('checks fork-origin metadata before any write and preserves it on round trip', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const notice = {
      type: 'system_notice' as const,
      name: 'session_fork_origin' as const,
      meta: {
        sourceSessionId: 'source' as SessionId,
        sourceTurnId: 'turn',
        sourceTitle: 'Synthetic',
      },
    };
    const version = doc.version().toJSON();
    for (const meta of [
      { sourceSessionId: 'source' },
      { ...notice.meta, sourceTitle: 42 },
      { message: 'wrong notice metadata' },
    ]) {
      expect(() =>
        mirror.historyWriter.append({
          ...entry(),
          items: [{ ...notice, meta }],
        } as unknown as SessionHistory)
      ).toThrow('Invalid history write');
      expect(doc.version().toJSON()).toEqual(version);
    }
    mirror.historyWriter.append({ ...entry(), role: 'system', items: [notice] });
    expect(doc.getList('history').toJSON()[0].items).toEqual([notice]);
    mirror.dispose();
  });

  it('keeps legacy primitive text primitive and retains it on an invalid item update', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry());
    const item = ((doc.getList('history').get(0) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    item.set('text', 'legacy');
    doc.commit();
    mirror.historyWriter.replace('turn', {
      ...entry(),
      items: [{ type: 'text', text: 'streamed' }],
    });
    expect(item.get('text')).toBe('streamed');
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.replace('turn', {
        ...entry(),
        items: [{ type: 'text', text: 42 }],
      } as unknown as SessionHistory)
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    expect(item.get('text')).toBe('streamed');
    mirror.dispose();
  });

  it('accepts strict image objects read through Mirror and JSON list shape changes', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append({
      ...entry(),
      items: [
        { type: 'image', imageId: 'image', mimeType: 'image/png', sizeBytes: 1 },
        {
          type: 'tool_call',
          toolCallId: 'tool',
          status: 'pending',
          rawInput: { values: [{ before: true }] },
        },
      ],
    });
    const imageMap = ((doc.getList('history').get(0) as LoroMap).get('items') as LoroList).get(
      0
    ) as LoroMap;
    imageMap.set('futureImageField', 7);
    doc.commit();
    mirror.setState((s) => {
      const image = s.history[0]!.items![0];
      if (image?.type === 'image') image.sizeBytes = 2;
      const tool = s.history[0]!.items![1];
      if (tool?.type === 'tool_call') tool.rawInput = { values: ['after'] };
    });
    expect(doc.toJSON().history[0].items[0].sizeBytes).toBe(2);
    expect(doc.toJSON().history[0].items[0].futureImageField).toBe(7);
    expect(doc.toJSON().history[0].items[1].rawInput.values).toEqual(['after']);
    mirror.dispose();
  });

  it('preserves a shifted opaque item and the following edited item containers', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append({
      ...entry(),
      items: [
        { type: 'text', text: 'delete' },
        { type: 'text', text: 'opaque' },
        { type: 'text', text: 'tail' },
      ],
    });
    const items = (doc.getList('history').get(0) as LoroMap).get('items') as LoroList;
    const opaque = items.get(1) as LoroMap;
    opaque.set('type', 'future_item');
    opaque.set('future', 11);
    const tail = items.get(2) as LoroMap;
    tail.set('futureTail', 22);
    doc.commit();
    const body = tail.get('text') as LoroText;
    mirror.setState((s) => {
      s.history[0]!.items!.splice(0, 1);
      s.history[0]!.items![1] = { type: 'text', text: 'changed' };
    });
    expect((items.get(0) as LoroMap).id).toBe(opaque.id);
    expect((items.get(1) as LoroMap).id).toBe(tail.id);
    expect(tail.toJSON()).toMatchObject({ text: 'changed', futureTail: 22 });
    expect(doc.getContainerById(body.id)?.toJSON()).toBe('changed');
    mirror.dispose();
  });

  it('preflights a complete batch and does not publish control fields on invalid history', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const version = doc.version().toJSON();
    expect(() =>
      mirror.setState((state) => {
        state.externalHistoryCursor = { importedTurnHashes: ['must-not-land'] };
        state.history.push(entry('good'));
        state.history.push({
          ...entry('bad'),
          items: [{ type: 'text' }],
        } as unknown as SessionHistory);
      })
    ).toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    expect(doc.toJSON().externalHistoryCursor.importedTurnHashes).toBeUndefined();
    mirror.historyWriter.append(entry('after-failure'));
    expect(doc.toJSON().history).toHaveLength(1);
    mirror.dispose();
  });

  it('rejects non-JSON payloads and malformed completion before attaching containers', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const version = doc.version().toJSON();
    for (const item of [
      {
        type: 'tool_call',
        toolCallId: 'tool',
        status: 'pending',
        rawInput: { callback: () => {} },
      },
      {
        type: 'operation_completion',
        deliveryId: 'delivery',
        operationId: 'operation',
        operationKind: 'session_chat',
        completion: { type: 'result' },
      },
    ]) {
      expect(() =>
        mirror.historyWriter.append({ ...entry(), items: [item] } as unknown as SessionHistory)
      ).toThrow('Invalid history write');
      expect(doc.version().toJSON()).toEqual(version);
    }
    mirror.dispose();
  });

  it('keeps normal ACP permission and location fields and updates an outcome locally', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const turn: SessionHistory = {
      ...entry(),
      role: 'assistant',
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tool',
          status: 'pending',
          locations: [{ path: 'synthetic.ts', line: 3 }],
          permissionRequest: {
            requestId: 'request',
            options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_always' }],
          },
        },
      ],
    };
    mirror.historyWriter.append(turn);
    const map = (doc.getList('history').get(0) as LoroMap).get('items') as LoroList;
    const itemId = (map.get(0) as LoroMap).id;
    expect(
      mirror.historyWriter.respondPermission('request', { outcome: 'selected', optionId: 'reject' })
    ).toBe(true);
    expect((map.get(0) as LoroMap).id).toBe(itemId);
    expect(doc.toJSON().history[0].items[0]).toMatchObject({
      locations: [{ path: 'synthetic.ts', line: 3 }],
      permissionRequest: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });
    mirror.dispose();
  });
  it.each(['writer', 'callback'] as const)(
    'rejects malformed new items through %s before changing the doc',
    (path) => {
      const doc = new Loro();
      const mirror = open(doc);
      const version = doc.version().toJSON();
      const bad = { ...entry(), items: [{ type: 'text' }] } as unknown as SessionHistory;
      expect(() =>
        path === 'writer'
          ? mirror.historyWriter.append(bad)
          : mirror.setState((s) => {
              s.history.push(bad);
            })
      ).toThrow('Invalid history write');
      expect(doc.version().toJSON()).toEqual(version);
      expect(doc.getList('history').length).toBe(0);
      mirror.dispose();
    }
  );

  it('filters unknown new fields without allowing unknown new item types', () => {
    const doc = new Loro();
    const mirror = open(doc);
    const withExtras = {
      ...entry(),
      surprise: 'drop',
      items: [{ type: 'text', text: 'hello', mail: 'synthetic@example.invalid' }],
    } as SessionHistory;
    mirror.historyWriter.append(withExtras);
    expect(doc.toJSON().history[0]).toEqual(entry());
    const version = doc.version().toJSON();
    expect(() =>
      mirror.historyWriter.append({
        ...entry('future'),
        items: [{ type: 'future_item' }],
      } as unknown as SessionHistory)
    ).toThrow();
    expect(doc.version().toJSON()).toEqual(version);
    mirror.dispose();
  });

  it.each(['live import', 'snapshot reopen'] as const)(
    'keeps opaque and malformed history while appending, streaming and merging after %s',
    (mode) => {
      const peer = new Loro();
      peer.setPeerId('100');
      open(peer).dispose();
      const row = peer.getList('history').pushContainer(new LoroMap());
      row.set('id', 'old');
      row.set('role', 'assistant');
      row.set('timestamp', 'old');
      row.set('futureTurnField', 10);
      const items = row.setContainer('items', new LoroList());
      const future = items.pushContainer(new LoroMap());
      future.set('type', 'future_item');
      future.set('text', 42);
      const field = future.setContainer('payload', new LoroText());
      field.insert(0, 'before');
      const bad = items.pushContainer(new LoroMap());
      bad.set('type', 'text');
      const text = items.pushContainer(new LoroMap());
      text.set('type', 'text');
      const body = text.setContainer('text', new LoroText());
      body.insert(0, 'hello');
      text.set('futureItemField', 20);
      peer.commit();
      const doc = new Loro();
      doc.setPeerId('200');
      if (mode === 'snapshot reopen') doc.import(peer.export({ mode: 'snapshot' }));
      const before = doc.version().toJSON();
      const mirror = open(doc);
      if (mode === 'snapshot reopen') expect(doc.version().toJSON()).toEqual(before);
      else doc.import(peer.export({ mode: 'snapshot' }));
      const old = doc.toJSON().history[0];
      mirror.historyWriter.append(entry());
      expect(doc.toJSON().history[0]).toEqual(old);
      mirror.setState((s) => {
        s.history[0]!.items![2] = { type: 'text', text: 'streamed' };
      });
      expect(doc.getContainerById(body.id)?.toJSON()).toBe('streamed');
      expect(doc.toJSON().history[0].items[2].futureItemField).toBe(20);
      const version = doc.version().toJSON();
      expect(() =>
        mirror.historyWriter.setField('old', 'finished', 'bad' as unknown as boolean)
      ).toThrow();
      expect(doc.version().toJSON()).toEqual(version);
      mirror.historyWriter.setField('old', 'finished', true);
      field.update('concurrent');
      peer.commit();
      doc.import(peer.export({ mode: 'update', from: doc.version() }));
      peer.import(doc.export({ mode: 'update', from: peer.version() }));
      expect(doc.toJSON()).toEqual(peer.toJSON());
      expect(doc.getContainerById(future.id)?.toJSON()).toEqual({
        type: 'future_item',
        text: 42,
        payload: 'concurrent',
      });
      expect(doc.toJSON().history[0].items[1]).toEqual({ type: 'text' });
      mirror.dispose();
    }
  );

  it('retains turn and text container ids across scalar updates and list insertion/removal', () => {
    const doc = new Loro();
    const mirror = open(doc);
    mirror.historyWriter.append(entry('a'));
    mirror.historyWriter.append(entry('b'));
    const row = doc.getList('history').get(1) as LoroMap;
    const item = (row.get('items') as LoroList).get(0) as LoroMap;
    const body = item.get('text') as LoroText;
    mirror.historyWriter.update((history) => [entry('prefix'), ...history.slice(1)]);
    expect((doc.getList('history').get(1) as LoroMap).id).toBe(row.id);
    mirror.historyWriter.setField('b', 'finished', true);
    expect(doc.getContainerById(body.id)?.toJSON()).toBe('hello');
    expect(doc.toJSON().history.map((r: { id: string }) => r.id)).toEqual(['prefix', 'b']);
    mirror.dispose();
  });

  it('uses the same new storage shape as a Mirror write', () => {
    const oldDoc = new Loro();
    const newDoc = new Loro();
    oldDoc.setPeerId('1');
    newDoc.setPeerId('1');
    const old = new Mirror({
      doc: oldDoc,
      schema: sessionDocSchema,
      ignoreUnknownProperties: true,
      initialState: { session: { id }, history: [] },
    });
    const current = open(newDoc);
    old.setState((s) => {
      s.history.push(entry());
    });
    current.historyWriter.append(entry());
    expect(newDoc.toJSON()).toEqual(oldDoc.toJSON());
    expect(newDoc.getList('history').toJSON()).toEqual(oldDoc.getList('history').toJSON());
    const ops = (doc: Loro) =>
      JSON.parse(
        JSON.stringify(doc.exportJsonUpdates(), (key, value) =>
          key === 'timestamp' ? undefined : value
        )
      );
    expect(ops(newDoc)).toEqual(ops(oldDoc));
    expect((newDoc.getList('history').get(0) as LoroMap).get('items')).toBeInstanceOf(LoroList);
    expect(
      ((newDoc.getList('history').get(0) as LoroMap).get('items') as LoroList).get(0)
    ).toBeInstanceOf(LoroMap);
    old.dispose();
    current.dispose();
  });
});
