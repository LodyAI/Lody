import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Identity, decodeBatch, decodeJson } from '@loro-dev/roost';
import {
  planAgentHistoryMutation,
  prepareReplacement,
  type SessionHistoryInput,
} from '@lody/shared';
import {
  fromApplicationJson,
  toApplicationJson,
  applicationJsonText,
} from '@loro-dev/roost/lody-history';
import {
  agentReceiptPut,
  coalesceAgentTextAppends,
  contentPathKey,
  roostContentPatches,
  stageRoostContent,
} from '../src/session/roost-content-patches';
import { createRoostHistoryReader } from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';
import {
  createRoostHistoryChanges,
  roostCommitMetadata,
} from '../src/session/roost-history-changes';
import {
  encodeRoostHistoryChange,
  decodeRoostHistoryChange,
} from '../src/session/roost-history-change-codec';
import {
  createRoostMessageState,
  projectRoostMessageState,
  roostMessageStatePatches,
} from '../src/session/roost-message-state';

const assistantContent = (text: string, finished = false) =>
  fromApplicationJson({
    role: 'assistant',
    timestamp: '2026-10-03T00:00:01.000Z',
    items: [{ type: 'text', text }],
    finished,
  });

describe('local Roost history writes', () => {
  it('persists a moved long state patch without copying text and recovers its receipt after reopen', async () => {
    const { RoostNativeClient } = await import('@loro-dev/roost-node');
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-state-move-'));
    const seed = new Uint8Array(32).fill(74);
    const options = {
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [Identity.fromSeed(seed).owner()],
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    };
    let client = new RoostNativeClient(options);
    try {
      await client.ready;
      let stream = client.stream('state-move');
      const primary = { id: 'assistant', text: 'baseline', finished: true };
      const primaryId = '01'.repeat(16);
      const state = createRoostMessageState(primary, primaryId, {
        ...primary,
        text: primary.text + 'long🙂🚀'.repeat(4096),
        finished: false,
      });
      const anchor = state.patches.find((patch) => patch.kind === 'appendText');
      const flag = state.patches.find((patch) => patch !== anchor);
      if (!anchor || !flag) throw new Error('Expected independent state patches');
      const before = { ...state, patches: [flag, anchor] };
      const next = { ...state, patches: [anchor, flag] };
      const created = await stream.create([], applicationJsonText({ content: before }));
      const id = created.updates[0]?.turnId;
      if (!id) throw new Error('Expected state turn');
      const ops = roostMessageStatePatches(before, next);
      const receipt = agentReceiptPut(
        {
          kind: 'publication',
          businessId: primary.id,
          segmentId: `agent:${'ab'.repeat(32)}`,
        },
        'cd'.repeat(32)
      );
      const writes = [{ kind: 'edit' as const, turnId: id, expectedNextSeq: 1n, ops }];
      const commitOptions = {
        expectedEventCursor: 1n,
        indexPuts: [receipt],
        receiptChecks: [receipt],
      };
      await stream.writeBatch(writes, commitOptions);
      const updates = await stream.exportUpdates(id, 1n, BigInt(ops.length));
      expect(updates.byteLength).toBeLessThan(2048);
      expect((await stream.writeBatch(writes, commitOptions)).replayed).toEqual([true]);
      await client.close();
      client = new RoostNativeClient(options);
      await client.ready;
      stream = client.stream('state-move');
      const reopened = await stream.readTurn(id);
      if (reopened.kind !== 'found') throw new Error('Expected reopened state');
      const content: unknown = JSON.parse(reopened.turn.contentJson).content;
      expect(content).toEqual(next);
      expect(projectRoostMessageState(primary, primaryId, content)).toEqual({
        ...primary,
        text: primary.text + 'long🙂🚀'.repeat(4096),
        finished: false,
      });
      expect((await stream.writeBatch(writes, commitOptions)).replayed).toEqual([true]);
      expect(await stream.exportUpdates(id, 1n, BigInt(ops.length))).toEqual(updates);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'keeps a parsed thought split through receipt retry, export and reopen (float fields: %s)',
    async (floats) => {
      const { RoostNativeClient } = await import('@loro-dev/roost-node');
      const directory = await mkdtemp(join(tmpdir(), 'lody-roost-thought-split-'));
      const seed = new Uint8Array(32).fill(73);
      const options = {
        dbPath: join(directory, 'history.db'),
        seed,
        allowedOwners: [Identity.fromSeed(seed).owner()],
        maxQueuedRequests: 16,
        maxQueuedBytes: 8 * 1024 * 1024,
      };
      let client = new RoostNativeClient(options);
      const initial: SessionHistoryInput = {
        id: 'synthetic-assistant',
        role: 'assistant',
        timestamp: '2026-10-25T00:00:00.000Z',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'synthetic-tool',
            status: 'completed',
            title: 'Synthetic output',
            rawOutput: {
              text: 'tool output'.repeat(128),
              safe: Number.MAX_SAFE_INTEGER,
              unicode: '\u0000\n🙂🚀',
              ownKeys: JSON.parse('{"__proto__":{"kept":true}}'),
              ...(floats ? { fraction: 0.25, large: 1e21, tiny: 1e-7 } : {}),
            },
          },
          { type: 'text', text: '' },
        ],
      };
      const event = (text: string) => ({
        kind: 'notification' as const,
        value: {
          sessionId: 'synthetic-acp',
          update: {
            sessionUpdate: 'agent_message_chunk' as const,
            content: { type: 'text' as const, text },
          },
        },
      });
      const plan = (before: SessionHistoryInput, text: string) => {
        const planned = planAgentHistoryMutation([before], [event(text)], undefined, {
          targetAssistantEntryId: initial.id,
        });
        const after = planned.history[0];
        if (!after) throw new Error('Expected synthetic assistant');
        const hints = coalesceAgentTextAppends(planned.textAppends, initial.id);
        return { after: prepareReplacement(before, after), hints, changes: planned.changes };
      };
      const body = Array.from({ length: 2048 }, (_, i) => `body-${i}🙂🚀\n`).join('');
      const opened = plan(initial, `\n<thinking>\n${body}`);
      const openingOps = roostContentPatches(initial, opened.after, opened.hints, opened.changes);
      const stored = stageRoostContent(initial, openingOps, opened.hints);
      if (!stored) throw new Error('Expected staged opening');
      const closed = plan(stored, '\n</thinking>\nVisible tail 🚀');
      const ops = roostContentPatches(stored, closed.after, closed.hints, closed.changes);
      expect(stageRoostContent(stored, ops, closed.hints)).toEqual(closed.after);
      expect(closed.after.items).toEqual([
        initial.items[0],
        { type: 'text', text: '\n' },
        { type: 'thought', text: `\n${body}\n` },
        { type: 'text', text: '\nVisible tail 🚀' },
      ]);
      try {
        await client.ready;
        let stream = client.stream('thought-split');
        const created = await stream.create([], applicationJsonText({ content: initial }));
        const id = created.updates[0]?.turnId;
        if (!id) throw new Error('Expected native turn');
        await stream.edit(id, 1n, openingOps);
        const seq = 1n + BigInt(openingOps.length);
        const digest = createHash('sha256').update('synthetic-close-notification').digest('hex');
        const receipt = agentReceiptPut(
          { kind: 'publication', businessId: initial.id, segmentId: `agent:${digest}` },
          digest
        );
        const writes = [{ kind: 'edit' as const, turnId: id, expectedNextSeq: seq, ops }];
        const commitOptions = {
          expectedEventCursor: seq,
          indexPuts: [receipt],
          receiptChecks: [receipt],
        };
        const committed = await stream.writeBatch(writes, commitOptions);
        expect(committed.updates).toHaveLength(ops.length);
        expect(committed.through).toBe(seq + BigInt(ops.length));
        const appendedFrames = await stream.exportUpdates(id, seq, BigInt(ops.length));
        expect(decodeBatch(appendedFrames)).toHaveLength(ops.length);
        // Exported retained operations contain only the new delimiters/tail and
        // scalar edits, not another copy of the previously streamed 30+ KiB body.
        expect(appendedFrames.byteLength).toBeLessThan(2048);
        expect((await stream.writeBatch(writes, commitOptions)).replayed).toEqual([true]);
        expect(await stream.exportUpdates(id, seq, BigInt(ops.length))).toEqual(appendedFrames);
        await stream.seal(id, seq + BigInt(ops.length));
        const exported = await stream.exportTurns([id]);
        await client.close();
        client = new RoostNativeClient(options);
        await client.ready;
        stream = client.stream('thought-split');
        const reopened = await stream.readTurn(id);
        if (reopened.kind !== 'found') throw new Error('Expected reopened split');
        expect(JSON.parse(reopened.turn.contentJson).content).toEqual(closed.after);
        expect(reopened.turn.sealed).not.toBeNull();
        expect((await stream.writeBatch(writes, commitOptions)).replayed).toEqual([true]);
        expect(await stream.exportTurns([id])).toEqual(exported);
        const peerClient = new RoostNativeClient({
          ...options,
          dbPath: join(directory, 'peer.db'),
        });
        try {
          await peerClient.ready;
          const peer = peerClient.stream('thought-split');
          await peer.importBatch(exported);
          expect(await peer.readTurn(id)).toEqual(reopened);
        } finally {
          await peerClient.close();
        }
      } finally {
        await client.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('restricts text relocation to exact unique tail evidence and preserves unknown fields', () => {
    const body = 'body🙂🚀'.repeat(1024);
    const prefix = { type: 'future_item', opaque: { kept: true } };
    const previous = `🧭header\n${body}`;
    const value = `${previous}\nnew tail`;
    const before = {
      items: [prefix, { type: 'text', text: previous, opaque: { retained: ['value'] } }],
      unknown: { retained: 'outside the authored items' },
    };
    const target = { type: 'thought', text: `${body}\n`, opaque: { retained: ['value'] } };
    const after = {
      ...before,
      items: [
        prefix,
        { type: 'text', text: 'new prefix' },
        target,
        { type: 'text', text: 'new tail' },
      ],
    };
    const key = contentPathKey([
      { key: 'content' },
      { key: 'items' },
      { index: 1n },
      { key: 'text' },
    ]);
    const hints = new Map([[key, { previous, value, text: '\nnew tail' }]]);
    const saved = structuredClone(before);
    const ops = roostContentPatches(before, after, hints);
    expect(stageRoostContent(before, ops, hints)).toEqual(after);
    expect(before).toEqual(saved);
    const insertedBytes = (edits: typeof ops) =>
      edits.reduce(
        (sum, op) =>
          sum +
          Buffer.byteLength(
            'text' in op
              ? op.text
              : 'valuesJson' in op
                ? op.valuesJson
                : 'contentJson' in op
                  ? op.contentJson
                  : ''
          ),
        0
      );
    expect(insertedBytes(ops)).toBeLessThan(1024);
    expect(insertedBytes(roostContentPatches(before, after))).toBeGreaterThan(
      Buffer.byteLength(body)
    );
    for (const invalid of [
      new Map([[key, { previous: 'stale', value, text: '\nnew tail' }]]),
      new Map([[key, { previous, value: previous, text: '\nnew tail' }]]),
    ]) {
      const fallback = roostContentPatches(before, after, invalid);
      expect(fallback).toEqual(roostContentPatches(before, after));
      expect(stageRoostContent(before, fallback)).toEqual(after);
    }
    const ambiguous = { ...after, items: [...after.items, target] };
    expect(roostContentPatches(before, ambiguous, hints)).toEqual(
      roostContentPatches(before, ambiguous)
    );
    const unrelated = { other: before.items },
      next = { other: after.items };
    expect(roostContentPatches(unrelated, next, hints)).toEqual(
      roostContentPatches(unrelated, next)
    );
    for (const opaque of [{ value: '\uD800' }, { ['\uDC00']: 'value' }]) {
      const invalidBefore = { ...before, unknown: opaque },
        invalidAfter = { ...after, unknown: opaque };
      expect(() => roostContentPatches(invalidBefore, invalidAfter, hints)).toThrow();
    }
  });

  it('appends and seals assistant output, merges late segments, and records permission separately', async () => {
    const [{ RoostNativeClient }, { NodeLodyHistory }] = await Promise.all([
      import('@loro-dev/roost-node'),
      import('@loro-dev/roost/lody-history'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-writes-'));
    const seed = new Uint8Array(32).fill(9);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [owner],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });

    try {
      await client.ready;
      const stream = client.stream('lody-writes');
      const history = new NodeLodyHistory(stream, owner);
      const primary = await history.accept({
        kind: 'message',
        businessId: 'assistant-1',
        segmentId: 'primary',
        parents: [],
        content: assistantContent('hello'),
      });

      await history.append(primary.turnId, 1n, [
        {
          kind: 'appendText',
          path: [{ key: 'items' }, { index: 0n }, { key: 'text' }],
          text: ' world',
        },
      ]);
      await history.finish(primary.turnId, 2n);

      const beforePermission = await stream.readTurn(primary.turnId);
      const late = await history.accept({
        kind: 'message',
        businessId: 'assistant-1',
        segmentId: 'late-output',
        parents: [],
        content: assistantContent('late', true),
      });

      const reader = createRoostHistoryReader(
        createRoostReadPort(history, () => ({
          initial: history.readProjectedMessages(),
          unsubscribe: () => {},
        }))
      );
      const projected = await reader.readAll();
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({
        id: 'assistant-1',
        role: 'assistant',
        finished: true,
      });
      expect(projected[0]?.items).toEqual([
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'late' },
      ]);

      const permission = await history.respondPermission({
        requestId: 'permission-1',
        assistantBusinessId: 'assistant-1',
        outcome: fromApplicationJson('approved'),
        parents: [],
      });
      const permissionRetry = await history.respondPermission({
        requestId: 'permission-1',
        assistantBusinessId: 'assistant-1',
        outcome: fromApplicationJson('approved'),
        parents: [],
      });
      expect(permission.created).toBe(true);
      expect(permissionRetry.created).toBe(false);
      expect([...permissionRetry.turnId]).toEqual([...permission.turnId]);

      const afterPermission = await stream.readTurn(primary.turnId);
      expect(afterPermission).toEqual(beforePermission);
      expect(late.created).toBe(true);
      const permissionTurn = await stream.readTurn(permission.turnId);
      expect(permissionTurn.kind).toBe('found');
      if (permissionTurn.kind === 'found') expect(permissionTurn.turn.sealed).not.toBeNull();
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});

it('recovers verified native change intervals and refuses a missing interval after reopen', async () => {
  const { RoostNativeClient } = await import('@loro-dev/roost-node');
  const directory = await mkdtemp(join(tmpdir(), 'lody-roost-changes-'));
  const seed = new Uint8Array(32).fill(17);
  const owner = Identity.fromSeed(seed).owner();
  const dbPath = join(directory, 'history.db');
  let client = new RoostNativeClient({
    dbPath,
    seed,
    allowedOwners: [owner],
    clockMs: 1_700_000_000_000n,
    maxQueuedRequests: 16,
    maxQueuedBytes: 8 * 1024 * 1024,
  });
  try {
    await client.ready;
    let stream = client.stream('synthetic-changes');
    const scope = createHash('sha256').update(owner).update('synthetic-changes').digest('hex');
    let journal = createRoostHistoryChanges(
      () => stream,
      () => scope
    );
    const initial = await journal.checkpoint(0n);
    const first = await stream.create([], '{"text":"first"}');
    await journal.record(0n, 1n, { kind: 'changed', businessIds: ['logical-first'] }, true);
    await stream.edit(first.updates[0]!.turnId, 1n, [
      { kind: 'appendText', path: [{ key: 'text' }], text: ' update' },
    ]);
    await journal.record(1n, 2n, { kind: 'structure', from: 4, to: 5 }, true, [
      'logical-early-status',
    ]);
    const recovered = await journal.read(initial, 2n);
    expect(recovered).toMatchObject({
      state: 'ready',
      from: 4,
      ids: ['logical-first', 'logical-early-status'],
    });
    await client.close();
    client = new RoostNativeClient({
      dbPath,
      seed,
      allowedOwners: [owner],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    await client.ready;
    stream = client.stream('synthetic-changes');
    journal = createRoostHistoryChanges(
      () => stream,
      () => scope
    );
    expect(await journal.read(initial, 2n)).toEqual(recovered);
    await stream.create([], '{"text":"unrecorded"}');
    await stream.create([], '{"text":"later"}');
    await journal.record(3n, 4n, { kind: 'changed', businessIds: ['later'] }, true);
    expect(await journal.read(initial, 4n)).toMatchObject({ state: 'reset' });
    const foreign = createRoostHistoryChanges(
      () => stream,
      () => '00'.repeat(32)
    );
    await expect(foreign.read(initial, 4n)).rejects.toThrow();
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Production Roost compact renderer receipts', () => {
  const scope = 'abcdef0123456789'.repeat(4);
  const nonce = 'fedcba98-7654-4321-8765-0123456789ab';
  const otherIds = [
    nonce.toUpperCase(),
    `${nonce}\n`,
    '中文🙂',
    '',
    '\ud800',
    '\udc00',
    'e\u0301',
    'é',
    '\ufeff',
  ];

  it('preserves exact identities and nonces, rejecting malformed encodings', () => {
    const receipt = {
      nonce,
      reset: false,
      ids: [nonce],
    };
    for (const ids of [[], [nonce], otherIds, [nonce, ...otherIds]]) {
      for (const from of [undefined, 0, Number.MAX_SAFE_INTEGER]) {
        const expected = { ...receipt, ids, from, reset: from !== undefined };
        expect(decodeRoostHistoryChange(encodeRoostHistoryChange(expected))).toEqual(expected);
      }
    }
    const encoded = Buffer.from(encodeRoostHistoryChange(receipt));
    // Native owns the scope/cursors; the payload retains all nonce and ID bits.
    expect(encoded.length).toBe(38);
    for (let length = 0; length < encoded.length; length++)
      expect(() => decodeRoostHistoryChange(encoded.subarray(0, length))).toThrow();
    const corrupt = [Buffer.concat([encoded, Buffer.from([0])]), Buffer.from('{"version":1}')];
    for (const [offset, value] of [
      [0, 2],
      [1, 8],
      [18, 255],
    ] as const) {
      const bytes = Buffer.from(encoded);
      bytes[offset] = value;
      corrupt.push(bytes);
    }
    const replaced = { ...receipt, reset: true };
    expect(decodeRoostHistoryChange(encodeRoostHistoryChange(replaced))).toEqual(replaced);
    const unsafePosition = Buffer.from(encodeRoostHistoryChange({ ...receipt, from: 0 }));
    unsafePosition.writeBigUInt64BE(0xffffffffffffffffn, 18);
    corrupt.push(unsafePosition);
    const jsonHeader = Buffer.from(
      encodeRoostHistoryChange({ ...receipt, ids: ['text'] })
    ).subarray(0, 18);
    for (const body of [
      Buffer.from('[1]'),
      Buffer.from('["text"]x'),
      Buffer.from([91, 34, 255, 34, 93]),
    ])
      corrupt.push(Buffer.concat([jsonHeader, body]));
    for (const bytes of corrupt) expect(() => decodeRoostHistoryChange(bytes)).toThrow();
    expect(() => encodeRoostHistoryChange({ ...receipt, nonce: nonce.toUpperCase() })).toThrow();
    expect(() =>
      encodeRoostHistoryChange({ ...receipt, from: Number.MAX_SAFE_INTEGER + 1 })
    ).toThrow();
  });

  it('recovers a paged receipt chain after reopen and refuses gaps, foreign identities and intervening mutations', async () => {
    const { RoostNativeClient } = await import('@loro-dev/roost-node');
    const seed = new Uint8Array(32).fill(67);
    const directory = await mkdtemp(join(tmpdir(), 'lody-renderer-receipts-'));
    const options = {
      dbPath: join(directory, 'renderer-receipts.db'),
      seed,
      allowedOwners: [Identity.fromSeed(seed).owner()],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    };
    let client = new RoostNativeClient(options);
    try {
      await client.ready;
      let stream = client.stream('renderer-receipts');
      const changes = createRoostHistoryChanges(
        () => stream,
        () => scope
      );
      const peers = createRoostHistoryChanges(
        () => stream,
        () => scope
      );
      const [checkpoint, concurrent] = await Promise.all([
        changes.checkpoint(0n),
        peers.checkpoint(0n),
      ]);
      expect(concurrent).toBe(checkpoint);
      const advance = (cursor: number) =>
        stream.writeBatch([], {
          indexPuts: [
            {
              table: 'app_synthetic_events',
              key: Buffer.from(String(cursor)),
              value: Buffer.from([1]),
              emitEvent: true,
            },
          ],
        });
      for (let index = 0; index < 129; index++) {
        await advance(index);
        await changes.record(
          BigInt(index),
          BigInt(index + 1),
          index === 128
            ? { kind: 'structure', from: 3, to: 129 }
            : { kind: 'changed', businessIds: [nonce] },
          true,
          index === 128 ? otherIds : []
        );
      }
      const expected = {
        state: 'ready',
        checkpoint: await changes.checkpoint(129n),
        from: 3,
        ids: [nonce, ...otherIds],
      };
      expect(await changes.read(checkpoint, 129n)).toEqual(expected);
      await client.close();
      client = new RoostNativeClient(options);
      await client.ready;
      stream = client.stream('renderer-receipts');
      expect(await changes.read(checkpoint, 129n)).toEqual(expected);
      expect(await changes.read(expected.checkpoint, 129n)).toEqual({
        state: 'ready',
        checkpoint: expected.checkpoint,
        ids: [],
      });
      const wrongScope = JSON.parse(checkpoint) as string[];
      wrongScope[0] = '00'.repeat(32);
      expect(await changes.read(JSON.stringify(wrongScope), 129n)).toMatchObject({
        state: 'reset',
      });
      const wrongNonce = JSON.parse(checkpoint) as string[];
      wrongNonce[2] = `${wrongNonce[2]}x`;
      expect(await changes.read(JSON.stringify(wrongNonce), 129n)).toMatchObject({
        state: 'reset',
      });

      const bound = Buffer.from(scope, 'hex');
      const stored = await stream.readCommitMetadata(bound, 129n);
      if (!stored) throw new Error('Expected persisted renderer metadata');
      const original = decodeRoostHistoryChange(stored.value);
      await stream.annotateCommit(bound, 129n, { ...stored, before: 129n });
      expect(await changes.read(checkpoint, 129n)).toMatchObject({ state: 'reset' });
      await stream.annotateCommit(bound, 129n, {
        ...stored,
        value: encodeRoostHistoryChange({ ...original, reset: true }),
      });
      expect(await changes.read(checkpoint, 129n)).toMatchObject({ state: 'reset' });
      await expect(stream.annotateCommit(Buffer.alloc(32), 129n, stored)).rejects.toThrow();
      await expect(stream.annotateCommit(bound, 1n, stored)).rejects.toThrow();
      await stream.annotateCommit(bound, 129n, { ...stored, value: stored.value.subarray(0, 10) });
      await expect(changes.read(checkpoint, 129n)).rejects.toThrow('receipt is invalid');
      await stream.annotateCommit(bound, 129n, stored);
      await expect(changes.record(129n, 130n, undefined, true)).rejects.toThrow();
      expect(await changes.read(checkpoint, 129n)).toEqual(expected);
      // A native commit without its derived receipt must still require full recovery.
      await advance(129);
      expect(await changes.read(expected.checkpoint, 130n)).toMatchObject({ state: 'reset' });

      // A batch may straddle scan pages. Only its final annotation proves coverage.
      const batched = client.stream('multi-event-batch');
      const batchChanges = createRoostHistoryChanges(
        () => batched,
        () => scope
      );
      const batchStart = await batchChanges.checkpoint(0n);
      await batched.writeBatch([], {
        indexPuts: Array.from({ length: 129 }, (_, i) => ({
          table: 'app_batch',
          key: Buffer.from(String(i)),
          value: Buffer.from([1]),
          emitEvent: true,
        })),
        expectedEventCursor: 0n,
        commitMetadata: roostCommitMetadata(scope, [nonce]),
      });
      expect(await batchChanges.read(batchStart, 129n)).toMatchObject({
        state: 'ready',
        ids: [nonce],
      });
      const batchCheckpoint = await batchChanges.checkpoint(129n);
      await batched.create([], '"unannotated"');
      await batched.writeBatch([{ kind: 'create', parents: [], contentJson: '"later"' }], {
        commitMetadata: roostCommitMetadata(scope, ['later']),
      });
      expect(await batchChanges.read(batchCheckpoint, 131n)).toMatchObject({ state: 'reset' });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('stages all content operations exactly like Native, including Unicode and own keys, then reopens', async () => {
  const { RoostNativeClient } = await import('@loro-dev/roost-node');
  const directory = await mkdtemp(join(tmpdir(), 'lody-roost-staging-'));
  const seed = new Uint8Array(32).fill(39),
    owner = Identity.fromSeed(seed).owner();
  const options = {
    dbPath: join(directory, 'history.db'),
    seed,
    allowedOwners: [owner],
    maxQueuedRequests: 16,
    maxQueuedBytes: 8 * 1024 * 1024,
  };
  let client = new RoostNativeClient(options);
  try {
    await client.ready;
    const stream = client.stream('staged-operations');
    const initial = {
      items: [{ type: 'text', text: 'a🙂bc🚀d' }],
      nested: { rows: [1, 2] },
      remove: true,
    };
    const created = await stream.create([], applicationJsonText({ content: initial }));
    const id = created.updates[0]?.turnId;
    if (!id) throw new Error('Expected native identity');
    let before: unknown = initial,
      sdk: unknown = fromApplicationJson(initial),
      seq = 1n;
    const versions: unknown[] = [
      {
        items: [
          { type: 'thought', text: 'a🙂XYZ🚀d' },
          { type: 'text', text: 'new' },
        ],
        nested: { rows: [3] },
      },
      JSON.parse(
        '{"items":[{"type":"text","text":"🙂🚀suffix"}],"nested":{"rows":[]},"__proto__":{"own":true}}'
      ),
      ...Array.from({ length: 12 }, (_, i) => ({
        items: [{ type: 'text', text: ['🙂', 'a🚀', '🚀🙂', ''][i % 4] + 'x'.repeat(i) }],
        nested: { rows: [i, null, { x: true }] },
      })),
    ];
    for (const after of versions) {
      const saved = structuredClone(before);
      const changes = [
        ...new Set([...Object.keys(before as object), ...Object.keys(after as object)]),
      ].map((key) => ({ turnId: 'synthetic', path: [key] }));
      const ops = roostContentPatches(before, after, undefined, changes);
      const staged = stageRoostContent(before, ops),
        stagedSdk = stageRoostContent(sdk, ops, undefined, 'sdk');
      expect(staged).toEqual(after);
      expect(stageRoostContent(before, roostContentPatches(before, after))).toEqual(staged);
      expect(before).toEqual(saved);
      await stream.edit(id, seq, ops);
      seq += BigInt(ops.length);
      const read = await stream.readTurn(id);
      if (read.kind !== 'found') throw new Error('Expected native content');
      const actual = decodeJson(new TextEncoder().encode(read.turn.contentJson));
      if (!(actual instanceof Map)) throw new Error('Expected envelope');
      expect(stagedSdk).toEqual(actual.get('content'));
      expect(toApplicationJson(actual.get('content') ?? null)).toEqual(after);
      before = staged;
      sdk = stagedSdk;
    }
    const immutable = structuredClone(before);
    const bad = [
      {
        kind: 'spliceText' as const,
        path: [{ key: 'content' }, { key: 'items' }, { index: 0n }, { key: 'text' }],
        index: 99999n,
        delete: 0n,
        text: 'bad',
      },
    ];
    expect(stageRoostContent(before, bad)).toBeUndefined();
    await expect(stream.edit(id, seq, bad)).rejects.toThrow();
    expect(before).toEqual(immutable);
    await stream.seal(id, seq);
    await client.close();
    client = new RoostNativeClient(options);
    await client.ready;
    const reopened = await client.stream('staged-operations').readTurn(id);
    if (reopened.kind !== 'found') throw new Error('Expected reopened content');
    expect(JSON.parse(reopened.turn.contentJson).content).toEqual(before);
    expect(reopened.turn.sealed).not.toBeNull();
    expect(Object.hasOwn(Object.prototype, 'own')).toBe(false);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
