import { createSessionAgentWrites } from '../src/lib/loro/session-agent-writes';
import { describe, expect, it, vi } from 'vitest';
import { Loro, isContainer, LoroList, LoroMap } from 'loro-crdt';
import type { SessionHistory } from '@lody/shared';
import type { SessionId } from '@lody/shared/ids';
import { createHistoryWriter } from '@lody/shared';
import {
  createLoroSessionData as createStoredSession,
  pageVisibleTranscript,
  clearField,
  setFieldTo,
  type SessionSnapshot,
  hashHistoryEntry,
  hashText,
  type SessionTurn,
} from '@lody/shared/session-data';

const createLoroSessionData = (options: Parameters<typeof createStoredSession>[0]) => {
  const data = createStoredSession(options);
  return { ...data, commands: { ...data.commands, ...createSessionAgentWrites(data.writer) } };
};

const makeHarness = (doc = new Loro()) => {
  let cursor: unknown;
  const data = createLoroSessionData({
    historyImportCursor: {
      read: () => cursor,
      write: (value) => {
        cursor = value;
      },
    },
    sessionId: storageSessionId,
    doc,
  });
  const writer = createHistoryWriter(doc);
  const findMap = (turnId: string): LoroMap | undefined => {
    const list = doc.getList('history');
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const value = list.get(index);
      if (isContainer(value) && value.kind() === 'Map' && (value as LoroMap).get('id') === turnId)
        return value as LoroMap;
    }
    return undefined;
  };
  return {
    data,
    injectStoredField(turnId: string, key: string, value: unknown) {
      const map = findMap(turnId);
      if (!map) throw new Error(`missing turn ${turnId}`);
      // Raw write: models a field a newer peer or an older build stored that the
      // current schema does not declare.
      map.set(key, value as Parameters<LoroMap['set']>[1]);
      doc.commit();
    },
    injectStoredItem(turnId: string, item: unknown) {
      const map = findMap(turnId);
      if (!map) throw new Error(`missing turn ${turnId}`);
      // Raw item append: models opaque content the current build must retain.
      (map.get('items') as LoroList).push(item as never);
      doc.commit();
    },
    peerSetField(turnId: string, key: string, value: unknown) {
      // A second independent writer over the same doc, as a peer would use.
      createHistoryWriter(doc).setField(turnId, key as never, value as never);
    },
    peerAppend(turn: SessionTurn) {
      createHistoryWriter(doc).append(turn as unknown as SessionHistory);
    },
    readStored: () => writer.readStored() as SessionTurn[],
  };
};

const storageSessionId = 'stored-session' as SessionId;

const userTurn = (turnId: string, text = 'hello'): SessionTurn => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  items: [{ type: 'text', text }],
  fileDiff: [],
});

const assistantTurn = (turnId: string): SessionTurn => ({
  id: turnId,
  role: 'assistant',
  userTurnId: 'user-1',
  timestamp: '2026-01-01T00:00:01.000Z',
  items: [{ type: 'text', text: 'working' }],
  fileDiff: [],
  finished: true,
  endedAt: 1234,
  permissionWaitMs: 50,
});

const textOf = (turn: SessionTurn | undefined): unknown =>
  Array.isArray(turn?.items) ? (turn.items[0] as { text?: unknown } | undefined)?.text : undefined;

describe('stored history operations', () => {
  it('captures only the linked turn output and preserves observation order', async () => {
    const { data } = makeHarness();
    await data.commands.appendTurn(userTurn('before'));
    await data.commands.appendTurn(userTurn('user-1'));
    await data.commands.appendTurn({ ...assistantTurn('unrelated'), userTurnId: 'before' });
    await data.commands.appendTurn({
      ...assistantTurn('a1'),
      finished: false,
      endedAt: undefined,
    });
    const first = data.history.readTurnOutput('user-1');
    await data.commands.setTurnField('a1', 'finished', setFieldTo(true));
    expect((await first).map((t) => t.id)).toEqual(['user-1', 'a1']);
    expect((await first)[1]?.finished).toBe(false);
    expect((await data.history.readTurnOutput('user-1'))[1]?.finished).toBe(true);
    expect(await data.history.readTurnOutput('missing')).toEqual([]);
    await data.commands.setTurnField('user-1', 'status', setFieldTo('failed'));
    await data.commands.appendTurn({
      id: 'failure',
      role: 'system',
      timestamp: '2026-01-01T00:00:02Z',
      items: [
        {
          type: 'system_notice',
          name: 'chat_failed',
          meta: { reason: 'acp_provider_overloaded', message: 'busy' },
        },
      ],
      fileDiff: [],
    });
    expect((await data.history.readTurnOutput('user-1')).map((t) => t.id)).toEqual([
      'user-1',
      'a1',
      'failure',
    ]);
  });

  it('reads turns by business id and raw range', async () => {
    const { data } = makeHarness();
    await data.commands.appendTurn(userTurn('a'));
    await data.commands.appendTurn(userTurn('b'));
    await data.commands.appendTurn(userTurn('c'));

    expect(await data.history.count()).toBe(3);
    const read = await data.history.readTurn('b');
    expect(read.state).toBe('ready');
    if (read.state === 'ready') expect(textOf(read.turn)).toBe('hello');

    const range = await data.history.readRange(1, 3);
    expect(range.map((entry) => (entry.state === 'ready' ? entry.turn.id : entry.state))).toEqual([
      'b',
      'c',
    ]);
    expect((await data.history.readTurn('missing')).state).toBe('missing');
    expect((await data.history.readAt(9)).state).toBe('missing');
  });

  it('reads a shallow directory and observes changes gap-free', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));
    await data.commands.appendTurn(userTurn('b'));

    const rows = await data.history.readDirectory(0, 2);
    expect(rows.map((row) => row.turnId)).toEqual(['a', 'b']);

    const changes: number[] = [];
    const observation = data.history.observe(() => changes.push(1));
    // The initial directory is taken at the same moment the listener is live.
    const initial = await observation.initial;
    expect(initial.map((row) => row.turnId)).toEqual(['a', 'b']);
    await data.commands.appendTurn(userTurn('c'));
    expect(changes.length).toBeGreaterThan(0);
    observation.unsubscribe();
    const observed = changes.length;
    await data.commands.appendTurn(userTurn('d'));
    expect(changes.length).toBe(observed);
  });

  it('reports the changed raw range on observe', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));
    const ranges: { from?: number; to?: number }[] = [];
    const observation = data.history.observe((change) => {
      if (change.kind === 'structure') ranges.push({ from: change.from, to: change.to });
    });
    await observation.initial;
    await data.commands.appendTurn(userTurn('b'));
    expect(ranges.at(-1)).toEqual({ from: 1, to: 2 });
    observation.unsubscribe();
  });

  it('projects shallow directory facts without materializing the config body', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn({
      ...userTurn('cfg'),
      inputConfig: {
        prompt: 'SECRET PROMPT',
        inputBlocks: [{ type: 'text', text: 'SECRET BLOCK' }],
        cliType: 'builtin',
        agentType: 'codex',
        modelId: 'model-1',
        mcpServerIds: [],
        configOptionValues: { plan_mode: true },
      },
    } as unknown as SessionTurn);

    const [row] = await data.history.readDirectory(0, 1);
    expect(row?.state).toBe('ready');
    expect(row?.turnId).toBe('cfg');
    expect(row?.scalars).toMatchObject({ id: 'cfg', role: 'user' });
    expect(row?.inputConfig).toMatchObject({
      cliType: 'builtin',
      agentType: 'codex',
      modelId: 'model-1',
      mcpServerIds: [],
      configOptionValues: { plan_mode: true },
    });
    // The body-independent projection never carries the prompt or input blocks.
    expect(JSON.stringify(row?.inputConfig)).not.toContain('SECRET');
  });

  it('reads the whole stored history as one detached snapshot', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));
    await data.commands.appendTurn(userTurn('b'));

    const all = await data.history.readAll();
    expect(all.map((turn) => turn.id)).toEqual(['a', 'b']);
    // Detached: mutating the returned rows cannot change stored history.
    (all[0] as unknown as { id: string }).id = 'mutated';
    const read = await data.history.readTurn('a');
    expect(read.state).toBe('ready');
  });

  it('sets and clears a field explicitly, preserving unknown stored fields', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));
    harness.injectStoredField('a', 'legacyFlag', true);

    const set = await data.commands.setTurnField('a', 'status', setFieldTo('handled'));
    expect(set).toBeUndefined();

    let stored = harness.readStored().find((turn) => turn.id === 'a')!;
    expect(stored.status).toBe('handled');
    // The legacy field is not scrubbed by a new write to a different field.
    expect((stored as Record<string, unknown>).legacyFlag).toBe(true);

    const clear = await data.commands.setTurnField('a', 'status', clearField());
    expect(clear).toBeUndefined();
    stored = harness.readStored().find((turn) => turn.id === 'a')!;
    expect(Object.hasOwn(stored, 'status')).toBe(false);
    // A clear survives a JSON round-trip: absence, not an `undefined` property.
    const roundTripped = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    expect(Object.hasOwn(roundTripped, 'status')).toBe(false);
    expect(roundTripped.legacyFlag).toBe(true);
  });

  it('marks a turn seen idempotently with the legacy read flag', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));

    const first = await data.commands.markTurnSeen('a');
    expect(first).toBe(true);
    const stored = harness.readStored().find((turn) => turn.id === 'a')!;
    expect(stored.status).toBe('seen');
    expect(stored.read).toBe(true);

    // Idempotent, and a missing target is a validated rejection.
    expect(data.commands.markTurnSeen('a')).toBe(true);
    expect(data.commands.markTurnSeen('missing')).toBe(false);
  });

  it('refuses to regress an advanced status when marking seen', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));
    // A concurrent writer advanced the turn after the reader observed pending.
    harness.peerSetField('a', 'status', 'processing');

    const result = await data.commands.markTurnSeen('a');
    expect(result).toBe(false);
    const stored = harness.readStored().find((turn) => turn.id === 'a')!;
    expect(stored.status).toBe('processing');
    expect(stored.read).not.toBe(true);
  });

  it('resumes an assistant turn by clearing only its terminal footprint', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(assistantTurn('assistant-1'));
    harness.injectStoredField('assistant-1', 'legacyFlag', 'kept');

    const result = await data.commands.openAssistantTurn({
      turnId: 'assistant-1',
      timestamp: '2026-01-01T00:00:00Z',
    });
    expect(result).toBeUndefined();

    const stored = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
    expect(stored.finished).toBe(false);
    expect(Object.hasOwn(stored, 'endedAt')).toBe(false);
    expect(Object.hasOwn(stored, 'permissionWaitMs')).toBe(false);
    expect((stored as Record<string, unknown>).legacyFlag).toBe('kept');
    expect(textOf(stored)).toBe('working');
  });

  it('opens an assistant turn by creating or reopening it without duplicating', async () => {
    const harness = makeHarness();
    const { data } = harness;

    const created = await data.commands.openAssistantTurn({
      turnId: 'assistant-new',
      userTurnId: 'user-1',
      timestamp: '2026-01-01T00:00:02.000Z',
    });
    expect(created).toBeUndefined();
    expect(harness.readStored().filter((turn) => turn.id === 'assistant-new')).toHaveLength(1);

    await data.commands.appendTurn(assistantTurn('assistant-1'));
    harness.injectStoredField('assistant-1', 'legacyFlag', 'kept');
    const reopened = await data.commands.openAssistantTurn({
      turnId: 'assistant-1',
      userTurnId: 'replacement-user',
      timestamp: '2026-01-01T00:00:03.000Z',
    });
    expect(reopened).toBeUndefined();

    const stored = harness.readStored();
    expect(stored.filter((turn) => turn.id === 'assistant-1')).toHaveLength(1);
    const turn = stored.find((candidate) => candidate.id === 'assistant-1')!;
    expect(turn.finished).toBe(false);
    expect(Object.hasOwn(turn, 'endedAt')).toBe(false);
    expect(Object.hasOwn(turn, 'permissionWaitMs')).toBe(false);
    expect((turn as Record<string, unknown>).legacyFlag).toBe('kept');
    // Reopening never overwrites existing provenance.
    expect(turn.userTurnId).toBe('user-1');
  });

  it('answers permissions by request id and rejects a scoped miss', async () => {
    const harness = makeHarness();
    const { data } = harness;
    const withPermission = (turnId: string, requestId: string): SessionTurn => ({
      ...assistantTurn(turnId),
      items: [
        {
          type: 'tool_call',
          toolCallId: turnId,
          status: 'pending',
          permissionRequest: { requestId, options: [] },
        },
      ],
    });
    await data.commands.appendTurn(withPermission('assistant-1', 'req-1'));
    await data.commands.appendTurn(withPermission('assistant-2', 'req-2'));

    const scopedMiss = await data.commands.respondPermission(
      'req-1',
      { outcome: 'cancelled' },
      { turnId: 'assistant-2' }
    );
    expect(scopedMiss).toBe(false);

    const answered = await data.commands.respondPermission(
      'req-1',
      { outcome: 'cancelled' },
      { turnId: 'assistant-1' }
    );
    expect(answered).toBe(true);
    const stored = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
    const item = (stored.items as Array<Record<string, unknown>> | undefined)?.[0];
    const request = item?.permissionRequest as Record<string, unknown> | undefined;
    expect((request?.outcome as { outcome?: string } | undefined)?.outcome).toBe('cancelled');
  });

  it('applies a bound agent batch to its target turn and preserves the others', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(assistantTurn('assistant-1'));
    await data.commands.appendTurn(assistantTurn('assistant-2'));
    const otherBefore = JSON.stringify(
      harness.readStored().find((turn) => turn.id === 'assistant-2')
    );

    const result = await data.commands.applyAgentBatch({
      notifications: [
        {
          sessionId: 'synthetic',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' streamed' },
          },
        },
      ] as never,
      targetAssistantEntryId: 'assistant-1',
      entryBound: true,
      createId: () => 'assistant-1',
      now: () => '2026-01-01T00:00:02.000Z',
    });
    expect(result).toBeUndefined();

    const target = harness.readStored().find((turn) => turn.id === 'assistant-1')!;
    expect(JSON.stringify(target.items)).toContain('streamed');
    expect(JSON.stringify(harness.readStored().find((turn) => turn.id === 'assistant-2'))).toBe(
      otherBefore
    );

    // A bound batch with no stored target still creates it under the bound id,
    // matching the historical targeted-then-create fallthrough.
    const created = await data.commands.applyAgentBatch({
      contents: [{ type: 'text', text: 'created' }] as never,
      targetAssistantEntryId: 'missing',
      entryBound: true,
      createId: () => 'missing',
      now: () => '2026-01-01T00:00:03.000Z',
    });
    expect(created).toBeUndefined();
    const createdRead = await data.history.readTurn('missing');
    expect(createdRead.state).toBe('ready');
    if (createdRead.state === 'ready') {
      expect(JSON.stringify(createdRead.turn.items)).toContain('created');
    }
  });

  it('replaces one known field without re-validating unchanged stored items', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(assistantTurn('a'));
    // A newer peer's unknown item and a known item carrying a legacy extra
    // subfield: both are untouched by the replacement and must survive.
    const opaqueItems = [
      { type: 'future_item', futurePayload: 'opaque' },
      { type: 'text', text: 'legacy', legacyField: 7 },
    ];
    for (const item of opaqueItems) harness.injectStoredItem('a', item);

    const read = await data.history.readTurn('a');
    if (read.state !== 'ready') throw new Error('expected the appended turn');
    const result = await data.commands.replaceTurn('a', { ...read.turn, finished: false });
    expect(result).toBeUndefined();

    const stored = harness.readStored().find((turn) => turn.id === 'a')!;
    expect(stored.finished).toBe(false);
    expect(stored.items).toEqual([...(assistantTurn('a').items ?? []), ...opaqueItems]);

    // Control: a *changed* known item with an invalid field is still rejected,
    // and the stored turn is untouched.
    await expect(
      data.commands.replaceTurn('a', {
        ...read.turn,
        items: [...(read.turn.items ?? []), { type: 'text', text: 42 }] as never,
      })
    ).rejects.toThrow();
    expect(harness.readStored().find((turn) => turn.id === 'a')!.items).toEqual([
      ...(assistantTurn('a').items ?? []),
      ...opaqueItems,
    ]);
  });

  it('rejects invalid input before storage changes', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));
    const before = JSON.stringify(harness.readStored());

    await expect(
      data.commands.appendTurn({
        ...userTurn('b'),
        role: 'invalid',
      } as unknown as SessionTurn)
    ).rejects.toThrow();

    await expect(
      data.commands.setTurnField('a', 'finished', setFieldTo('yes' as unknown as boolean))
    ).rejects.toThrow();
    expect(JSON.stringify(harness.readStored())).toBe(before);
  });

  it('applies a conditional field write without overwriting a peer edit', async () => {
    const harness = makeHarness();
    const { data } = harness;
    await data.commands.appendTurn(userTurn('a'));

    // Peer writes a different field and appends while our caller "holds" a read.
    harness.peerSetField('a', 'status', 'handled');
    harness.peerAppend(userTurn('peer'));

    const result = await data.commands.setTurnField('a', 'finished', setFieldTo(true));
    expect(result).toBeUndefined();

    const stored = harness.readStored();
    const a = stored.find((turn) => turn.id === 'a')!;
    expect(a.finished).toBe(true);
    expect(a.status).toBe('handled');
    expect(stored.some((turn) => turn.id === 'peer')).toBe(true);
  });

  it('pages the visible transcript by raw cursor without falsifying the tail', async () => {
    const harness = makeHarness();
    const { data } = harness;
    for (const [index, turn] of [
      userTurn('u0'),
      { ...userTurn('s1'), role: 'system' as const },
      userTurn('u1'),
      { ...userTurn('s2'), role: 'system' as const },
      { ...userTurn('s3'), role: 'system' as const },
    ].entries()) {
      await data.commands.appendTurn({ ...turn, id: `t${index}` });
    }
    const isVisible = (turn: SessionTurn) => turn.role !== 'system';

    const first = await pageVisibleTranscript(data.history, { limit: 1, isVisible });
    expect(first.turns.map((turn) => turn.id)).toEqual(['t2']);
    expect(first.positions).toEqual([2]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = await pageVisibleTranscript(data.history, {
      limit: 1,
      cursor: first.nextCursor,
      isVisible,
    });
    expect(second.turns.map((turn) => turn.id)).toEqual(['t0']);
    expect(second.positions).toEqual([0]);
    expect(second.hasMore).toBe(false);

    // A tail of hidden turns must not be reported as an empty history.
    const tailHidden = await pageVisibleTranscript(data.history, {
      limit: 5,
      cursor: '1',
      isVisible: () => false,
    });
    expect(tailHidden.turns).toEqual([]);
    expect(tailHidden.hasMore).toBe(false);
  });

  it('refuses a forged stored-copy handle before writing', async () => {
    const { data, readStored } = makeHarness();
    const forged = { history: [] } as unknown as SessionSnapshot;
    await expect(data.snapshots.copyFrom(forged, [])).rejects.toThrow('invalid_snapshot');
    expect(readStored()).toEqual([]);
  });

  it('copies a cross-store selection, retaining opaque stored items and rejecting colliding ids', async () => {
    const sourceHarness = makeHarness();
    const source = sourceHarness.data;
    const sourceSnapshots = source.snapshots;
    if (!sourceSnapshots) throw new Error('the backend must expose its snapshot service');

    await source.commands.appendTurn(userTurn('a'));
    await source.commands.appendTurn(userTurn('b'));
    // A stored item carries a legacy subfield the caller never authored.
    sourceHarness.injectStoredItem('a', { type: 'text', text: 'legacy', legacyField: 7 });
    const snapshot = await sourceSnapshots.capture();

    // read() is the handle's own full, detached read of the captured source:
    // it sees the stored content, and mutating one copy cannot change it.
    const captured = snapshot.history as SessionTurn[];
    expect(captured.map((turn) => turn.id)).toEqual(['a', 'b']);
    expect(captured[0]!.items).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'legacy', legacyField: 7 },
    ]);
    captured.push(userTurn('mutated'));
    expect(snapshot.history.map((turn) => turn.id)).toEqual(['a', 'b']);

    const targetHarness = makeHarness();
    const target = targetHarness.data;
    await target.commands.appendTurn(userTurn('c')); // target initialization row

    // The business caller re-authors the selection without the opaque field.
    const selection: readonly SessionTurn[] = [
      {
        id: 'a',
        role: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        items: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'legacy' },
        ],
        fileDiff: [],
      },
    ];
    expect(JSON.stringify(selection)).not.toContain('legacyField');

    // The fork flow: a target store copies a source store's snapshot. The
    // copy is prepended, the opaque subfield comes from the captured source,
    // the target's initialization row is retained and the source is untouched.
    const copied = await target.snapshots!.copyFrom(snapshot, selection);
    expect(copied).toBeUndefined();

    expect(targetHarness.readStored().map((turn) => turn.id)).toEqual(['a', 'c']);
    expect(targetHarness.readStored()[0]!.items).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'legacy', legacyField: 7 },
    ]);
    expect(sourceHarness.readStored().map((turn) => turn.id)).toEqual(['a', 'b']);

    // A colliding id in the target store is a validated pre-write rejection.
    await expect(target.snapshots!.copyFrom(snapshot, selection)).rejects.toThrow();
    expect(targetHarness.readStored().map((turn) => turn.id)).toEqual(['a', 'c']);
  });

  it('replaces the editable tail, reports the previous user and compensates the range only', async () => {
    const harness = makeHarness();
    const { data } = harness;

    await data.commands.appendTurn(userTurn('u1'));
    await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
    await data.commands.appendTurn(userTurn('u2'));
    // Opaque stored content the current build never authored.
    harness.injectStoredItem('u1', { type: 'text', text: 'legacy', legacyField: 7 });
    harness.injectStoredItem('u2', { type: 'text', text: 'old', legacyField: 9 });

    const applied = await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u2',
      expectedForkTurnId: 'provider-1',
      replacement: userTurn('u2-new', 'edited'),
    });
    expect(applied.status).toBe('accepted');
    if (applied.status !== 'accepted') return;
    expect(applied.previousUserTurnId).toBe('u1');
    expect(textOf(harness.readStored()[2])).toBe('edited');
    expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2-new']);
    // The untouched prefix row keeps its opaque stored item.
    expect(harness.readStored()[0]!.items).toContainEqual({
      type: 'text',
      text: 'legacy',
      legacyField: 7,
    });

    // Compensation restores only the replaced range: a row appended after the
    // replacement survives the rollback, and the replaced row's opaque items
    // come back from the writer's captured stored values.
    await data.commands.appendTurn(userTurn('u3'));
    await applied.rollback();
    expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2', 'u3']);
    expect(harness.readStored()[2]!.items).toContainEqual({
      type: 'text',
      text: 'old',
      legacyField: 9,
    });
  });

  it('rejects the compensation when the replaced range was edited by a peer', async () => {
    const harness = makeHarness();
    const { data } = harness;

    await data.commands.appendTurn(userTurn('u1'));
    await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
    await data.commands.appendTurn(userTurn('u2'));

    const applied = await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u2',
      expectedForkTurnId: 'provider-1',
      replacement: userTurn('u2-new', 'edited'),
    });
    if (applied.status !== 'accepted') throw new Error('expected an accepted replacement');

    // A peer edit inside the replaced range invalidates the compensation: it
    // rejects instead of fabricating a restore over the peer's change.
    harness.peerSetField('u2-new', 'status', 'handled');
    await expect(applied.rollback()).rejects.toThrow();
    expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2-new']);
    expect(harness.readStored()[2]!.status).toBe('handled');
  });

  it('refuses a tail replacement whose tail moved at commit time', async () => {
    const harness = makeHarness();
    const { data } = harness;

    await data.commands.appendTurn(userTurn('u1'));
    await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
    await data.commands.appendTurn(userTurn('u2'));
    // A concurrent append lands before the command runs; the store re-locates
    // the tail instead of trusting the caller's earlier resolution.
    await data.commands.appendTurn(userTurn('u2-concurrent'));

    const refused = await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u2',
      expectedForkTurnId: 'provider-1',
      replacement: userTurn('u2-new', 'edited'),
    });
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(refused.reason.code).toBe('stale_boundary');
    expect(harness.readStored().map((turn) => turn.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'u2-concurrent',
    ]);
  });

  it('refuses a tail replacement whose provider boundary no longer matches', async () => {
    const harness = makeHarness();
    const { data } = harness;

    await data.commands.appendTurn(userTurn('u1'));
    await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
    await data.commands.appendTurn(userTurn('u2'));

    const refused = await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u2',
      expectedForkTurnId: 'provider-other',
      replacement: userTurn('u2-new', 'edited'),
    });
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(refused.reason.code).toBe('stale_boundary');
    expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('refuses a tail replacement while a session goal is active in history', async () => {
    const harness = makeHarness();
    const { data } = harness;

    await data.commands.appendTurn({
      ...userTurn('u1'),
      items: [
        { type: 'text', text: 'hello' },
        { type: 'goal', threadId: 'thread-1', objective: 'ship it', status: 'active' },
      ],
    });
    await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
    await data.commands.appendTurn(userTurn('u2'));

    const refused = await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u2',
      expectedForkTurnId: 'provider-1',
      replacement: userTurn('u2-new', 'edited'),
    });
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(refused.reason.code).toBe('active_goal');
    expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('consults the meta goal fallback when the history carries no goal item', async () => {
    const harness = makeHarness();
    const { data } = harness;

    await data.commands.appendTurn(userTurn('u1'));
    await data.commands.appendTurn({ ...assistantTurn('a1'), acpTurnId: 'provider-1' });
    await data.commands.appendTurn(userTurn('u2'));

    const refused = await data.commands.replaceEditableTail({
      expectedUserTurnId: 'u2',
      expectedForkTurnId: 'provider-1',
      replacement: userTurn('u2-new', 'edited'),
      fallbackGoal: {
        type: 'goal',
        threadId: 'thread-1',
        objective: 'ship it',
        status: 'active',
      },
    });
    expect(refused.status).toBe('rejected');
    if (refused.status === 'rejected') expect(refused.reason.code).toBe('active_goal');
    expect(harness.readStored().map((turn) => turn.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('imports history in one bound block: write, stored baseline and cursor', async () => {
    const harness = makeHarness();
    const { data } = harness;

    const imported = await data.commands.applyHistoryImport({
      mode: 'initialize',
      replay: {
        history: [userTurn('a'), userTurn('b')],
        turnHashes: ['hash-a', 'hash-b'],
        replayDigest: 'digest',
        droppedNotifications: 0,
        // Opaque placeholder hashes; initialize never compares, so the version label
        // only lands on the written cursor.
        hashVersion: 2,
      },
    });
    expect(imported.status).toBe('accepted');
    if (imported.status === 'accepted') expect(imported.appended).toBe(2);
    expect(harness.readStored().map((turn) => turn.id)).toEqual(['a', 'b']);
  });
});

describe('loro session data adapter', () => {
  it('converges two replicas after UI- and agent-side domain writes', async () => {
    const left = new Loro();
    const right = new Loro();
    const leftData = createLoroSessionData({
      sessionId: storageSessionId,
      doc: left,
    });
    const rightData = createLoroSessionData({
      sessionId: storageSessionId,
      doc: right,
    });

    await leftData.commands.appendTurn({
      id: 'user-1',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'hi' }],
      fileDiff: [],
      status: 'pending',
    });
    right.import(left.export({ mode: 'update' }));

    // Agent-side replica streams an answer into the shared turn.
    await rightData.commands.appendTurn({
      id: 'assistant-1',
      role: 'assistant',
      userTurnId: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      items: [{ type: 'text', text: 'hello' }],
      fileDiff: [],
    });
    left.import(right.export({ mode: 'update' }));

    // UI-side replica acknowledges read on its own copy.
    await leftData.commands.setTurnField('user-1', 'read', { kind: 'set', value: true });
    right.import(left.export({ mode: 'update' }));

    for (const doc of [left, right]) {
      const ids = doc
        .getList('history')
        .toJSON()
        .map((turn) => (turn as { id: string }).id);
      expect(ids).toEqual(['user-1', 'assistant-1']);
    }
    const readUser = await rightData.history.readTurn('user-1');
    expect(readUser.state === 'ready' && readUser.turn.read).toBe(true);
  });

  it('clears a field without disturbing unrelated stored keys', async () => {
    const harness = makeHarness();
    await harness.data.commands.appendTurn({
      id: 'a',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'x' }],
      fileDiff: [],
      finished: true,
      endedAt: 99,
    });
    harness.injectStoredField('a', 'futureField', { nested: [1, 2] });

    await harness.data.commands.setTurnField('a', 'finished', { kind: 'clear' });
    const stored = harness.readStored().find((turn) => turn.id === 'a') as Record<string, unknown>;
    expect(Object.hasOwn(stored, 'finished')).toBe(false);
    expect(stored.endedAt).toBe(99);
    expect(stored.futureField).toEqual({ nested: [1, 2] });
  });

  it('keeps a bad raw slot addressable without shifting its neighbours', async () => {
    const doc = new Loro();
    const harness = makeHarness(doc);
    // A corrupt slot no client wrote: a raw non-map value in the history list.
    doc.getList('history').insert(0, 'not-a-turn');
    doc.commit();

    expect(await harness.data.history.count()).toBe(1);
    expect((await harness.data.history.readRange(0, 1))[0]?.state).toBe('invalid');

    await harness.data.commands.appendTurn({
      id: 'valid',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [{ type: 'text', text: 'ok' }],
      fileDiff: [],
    });
    // The invalid slot keeps its raw position; the valid turn stays at index 1.
    expect(await harness.data.history.count()).toBe(2);
    const range = await harness.data.history.readRange(0, 2);
    expect(range.map((entry) => (entry.state === 'ready' ? entry.turn.id : entry.state))).toEqual([
      'invalid',
      'valid',
    ]);

    const page = await pageVisibleTranscript(harness.data.history, {
      limit: 5,
      isVisible: () => true,
    });
    expect(page.turns.map((turn) => turn.id)).toEqual(['valid']);
    expect(page.hasMore).toBe(false);
  });

  it('keeps a detached capture usable after source teardown', async () => {
    const source = createLoroSessionData({
      sessionId: storageSessionId,
      doc: new Loro(),
    });
    const target = createLoroSessionData({
      sessionId: 'fork-target' as SessionId,
      doc: new Loro(),
    });
    await source.commands.appendTurn({
      id: 'u',
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text: 'captured' }],
      fileDiff: [],
    });
    const snapshot = await source.snapshots.capture();
    source.dispose();
    const selection = snapshot.history;
    await target.snapshots.copyFrom(snapshot, selection);
    expect(await target.history.readTurn('u')).toMatchObject({
      state: 'ready',
      turn: { items: [{ type: 'text', text: 'captured' }] },
    });
  });

  it('binds an imported history write, its stored baseline and the cursor with no await gap', async () => {
    const doc = new Loro();
    let cursorState: unknown;
    const data = createLoroSessionData({
      sessionId: storageSessionId,
      doc,
      historyImportCursor: {
        read: () => cursorState,
        write: (value) => {
          cursorState = value;
        },
      },
    });
    const history: SessionTurn[] = [
      { id: 'a', role: 'user', timestamp: 'synthetic', items: [{ type: 'text', text: 'x' }] },
    ];
    const hashes = history.map(hashHistoryEntry);
    const result = await data.commands.applyHistoryImport({
      mode: 'initialize',
      replay: {
        history,
        turnHashes: hashes,
        replayDigest: hashText(hashes.join('\n')),
        droppedNotifications: 0,
        // A genuine v1 fixture: hashes computed with the frozen v1 canonical form.
        hashVersion: 1,
      },
    });
    expect(result).toMatchObject({ status: 'accepted', appended: 1 });
    const cursor = cursorState as {
      importedTurnHashes: string[];
      hashVersion?: number;
      storedHistoryBaseline: string;
    };
    expect(cursor.importedTurnHashes).toEqual(hashes);
    // The persisted cursor retains the version; the baseline records the same one.
    expect(cursor.hashVersion).toBe(1);
    const baseline = JSON.parse(cursor.storedHistoryBaseline);
    expect(baseline.hashVersion).toBe(1);
    expect(baseline.turnHashes).toEqual(
      createHistoryWriter(doc).readStored().map(hashHistoryEntry)
    );
  });

  it('reads one turn by shallow identity without materializing unrelated bodies', async () => {
    const doc = new Loro();
    const harness = makeHarness(doc);
    for (let index = 0; index < 10; index += 1) {
      await harness.data.commands.appendTurn({
        id: `a${index}`,
        role: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'text', text: `body ${index}` }],
        fileDiff: [],
      });
    }
    // Record which turn bodies are materialized while resolving the first id,
    // which sits at the far end of the list.
    const bodies: string[] = [];
    const original = LoroMap.prototype.toJSON;
    const spy = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function () {
      const id = this.get('id');
      if (typeof id === 'string') bodies.push(id);
      return original.call(this);
    });
    try {
      const read = await harness.data.history.readTurn('a0');
      expect(read.state === 'ready' && read.turn.id).toBe('a0');
      // Identity is read shallowly: only the target body is materialized.
      expect(bodies).toEqual(['a0']);
    } finally {
      spy.mockRestore();
    }
  });
});
