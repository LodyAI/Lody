import { randomUUID, createHash } from 'node:crypto';
import { decodeJson } from '@loro-dev/roost';
import {
  NodeLodyHistory,
  applicationJsonText,
  toApplicationJson,
  type HistoryBatchCommand,
  type HistoryIdentity,
  type ForkAndActivateInput,
  type RestoreActiveBranchInput,
  type ReplaceActiveBranchMembersInput,
  type HistoryInputIdentity,
} from '@loro-dev/roost/lody-history';
import type {
  RoostNativeClient,
  RoostNodeStream,
  Write,
  IndexPut,
  IndexEntry,
} from '@loro-dev/roost-node';
import type { SessionHistoryInput } from '@lody/shared';
import { encodeRoostContent } from './roost-history-port';
import { AGENT_RECEIPTS_TABLE, agentReceiptKey, decodeAgentReceipt } from './roost-content-patches';
import { roostCommitMetadata } from './roost-history-changes';
import { ROOST_HEAD_KEY, decodeRoostHead, encodeRoostHead } from './roost-history-head';

const nextKey = { table: 'lody_history_generation_v1', key: new TextEncoder().encode('next') };
const epochKey = { table: 'lody_history_epoch_v1', key: new TextEncoder().encode('current') };
const sameEpoch = (left: Uint8Array | null, right: Uint8Array | null) =>
  left === null || right === null ? left === right : Buffer.from(left).equals(Buffer.from(right));
const stale = () => Object.assign(new Error('Roost history generation changed'), { code: 'stale' });
type WriteEvidence = {
  raw: RoostNodeStream;
  updates: Map<string, number>;
  indexes: Map<string, number>;
  metadataThrough: bigint | undefined;
  settledThrough: bigint | undefined;
  exclusiveThrough: bigint | undefined;
};
const updateKey = (id: Uint8Array, seq: bigint) => `${Buffer.from(id).toString('hex')}:${seq}`;
const indexKey = (table: string, key: Uint8Array) => `${table}:${Buffer.from(key).toString('hex')}`;
const addEvidence = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

/** Application-owned activation; branch/envelope formats remain entirely SDK-owned. */
export class RoostHistoryGeneration {
  private readonly root: string;
  private streamId: string;
  private raw: RoostNodeStream;
  private readonly ancestors: NodeLodyHistory[] = [];
  private readonly checkedReceiptFormats = new WeakSet<RoostNodeStream>();
  private resolveSerial: Promise<void> = Promise.resolve();
  private epoch: Uint8Array | null = null;
  private retireBinding: (() => void) | undefined;
  private writeEvidence: WriteEvidence | undefined;
  private activation:
    | { raw: RoostNodeStream; operationId: string; cursor: bigint; key: Uint8Array }
    | undefined;
  externalHistoryCursor: import('@lody/shared').SessionExternalHistoryCursorDocState | undefined;
  history: NodeLodyHistory;

  constructor(
    private readonly client: RoostNativeClient,
    private readonly owner: Uint8Array,
    private readonly viewId: string
  ) {
    this.root = `lody-session:${viewId}`;
    this.streamId = this.root;
    this.raw = client.stream(this.streamId);
    this.history = this.bind(this.raw);
  }

  get observationScope(): string {
    return createHash('sha256').update(this.owner).update(this.streamId).digest('hex');
  }

  get observationStream(): string {
    return this.streamId;
  }

  get observationIndexKeys() {
    return [nextKey, epochKey];
  }

  get host(): RoostNodeStream {
    return this.history.stream as RoostNodeStream;
  }

  commitPatches(
    writes: Write[],
    receipts: IndexPut[],
    cursor: bigint | undefined,
    changedIds: readonly string[],
    derivedIndexPuts: IndexPut[] = [],
    expectedIndexes: IndexEntry[] = [],
    unclaimedIdentities: HistoryIdentity[] = []
  ) {
    return this.history.commitContentBatch(writes, {
      indexPuts: receipts,
      receiptChecks: receipts.map(({ table, key, value }) => ({ table, key, value })),
      expectedEventCursor: cursor,
      expectedIndexes: [
        ...receipts.map(({ table, key }) => ({ table, key, value: null })),
        ...expectedIndexes,
      ],
      commitMetadata: roostCommitMetadata(this.observationScope, changedIds),
      derivedIndexPuts,
      unclaimedIdentities,
    });
  }

  private async assertReceiptFormat(raw: RoostNodeStream): Promise<void> {
    if (this.checkedReceiptFormats.has(raw)) return;
    // Presence check only: experimental v1 sessions are rejected, never migrated
    // or looked up as missing v2 receipts. Cache only for this stream handle's lifetime.
    const previous = await raw.scanIndex('lody_agent_operation_receipts_v1', new Uint8Array(), 1n);
    if (previous.length)
      throw new Error('Unsupported Roost agent receipt format; create a new test session');
    for (const table of ['lody_renderer_history_changes_v1', 'lody_renderer_history_changes_v2']) {
      if ((await raw.scanIndex(table, new Uint8Array(), 1n)).length)
        throw new Error('Unsupported Roost renderer receipt format; create a new test session');
    }
    this.checkedReceiptFormats.add(raw);
  }

  /** A derived cache may advance only across writes whose receipts we own. */
  trackWrites(after: bigint) {
    const evidence: WriteEvidence = {
      raw: this.raw,
      updates: new Map(),
      indexes: new Map(),
      metadataThrough: after,
      settledThrough: after,
      exclusiveThrough: after,
    };
    this.writeEvidence = evidence;
    return {
      hasCommitted: () =>
        evidence.raw !== this.raw || evidence.updates.size > 0 || evidence.indexes.size > 0,
      metadataCovered: (through: bigint) =>
        evidence.raw === this.raw && evidence.metadataThrough === through,
      verify: async (through: bigint): Promise<boolean> => {
        // Native certifies the whole interval only when no pending remote work
        // added events. Contiguous certified commits need no second event scan.
        if (
          evidence.raw === this.raw &&
          (evidence.metadataThrough === through || evidence.exclusiveThrough === through)
        )
          return true;
        if (evidence.raw !== this.raw || through < after || through - after > 256n) return false;
        const events = await evidence.raw.eventsAfter(after, 256n);
        const updates = new Map(evidence.updates);
        const indexes = new Map(evidence.indexes);
        let last = after;
        for (const record of events) {
          if (record.cursor > through) break;
          last = record.cursor;
          const event = record.event;
          const counts = event.kind === 'changed' ? updates : indexes;
          const key =
            event.kind === 'changed'
              ? updateKey(event.update.turnId, event.update.seq)
              : event.kind === 'indexChanged'
                ? indexKey(event.table, event.key)
                : undefined;
          if (key === undefined || !counts.get(key)) return false;
          counts.set(key, (counts.get(key) ?? 0) - 1);
        }
        // Native index puts emit only when their value changes; unused index
        // candidates are expected, unlike the signed update receipts.
        return last === through && [...updates.values()].every((count) => count === 0);
      },
      stop: () => {
        if (this.writeEvidence === evidence) this.writeEvidence = undefined;
      },
    };
  }

  private recordWrite(
    raw: RoostNodeStream,
    result: {
      updates: Awaited<ReturnType<RoostNodeStream['writeBatch']>>['updates'];
      before?: bigint;
      through?: bigint;
      metadataAttached?: boolean;
      derivedIndexesApplied?: boolean;
    },
    options: Parameters<RoostNodeStream['writeBatch']>[1]
  ) {
    const evidence = this.writeEvidence;
    if (!evidence || evidence.raw !== raw) return;
    if (options?.requireLocalInterval && result.before === evidence.exclusiveThrough) {
      evidence.exclusiveThrough = result.through;
    } else if (result.before !== result.through || result.updates.length) {
      evidence.exclusiveThrough = undefined;
    }
    if (
      result.metadataAttached &&
      result.derivedIndexesApplied &&
      result.before === evidence.settledThrough
    ) {
      evidence.settledThrough = result.through;
    } else if (result.before !== result.through || result.updates.length) {
      evidence.settledThrough = undefined;
    }
    if (result.metadataAttached && result.before === evidence.metadataThrough) {
      evidence.metadataThrough = result.through;
    } else if (result.before !== result.through || result.updates.length) {
      evidence.metadataThrough = undefined;
    }
    for (const update of result.updates)
      addEvidence(evidence.updates, updateKey(update.turnId, update.seq));
    for (const put of options?.indexPuts ?? []) {
      if (!put.emitEvent) continue;
      if (put.onceKey && put.key.length === 0) {
        // The public native onceKey contract substitutes its Turn id for an
        // empty key. Candidate ids come only from this transaction's receipts.
        for (const update of result.updates)
          addEvidence(evidence.indexes, indexKey(put.table, update.turnId));
      } else addEvidence(evidence.indexes, indexKey(put.table, put.key));
    }
  }

  /** Only the current command's exact, fully indexed local commit interval. */
  settledWriteCursor(): bigint | undefined {
    return this.writeEvidence?.raw === this.raw ? this.writeEvidence.settledThrough : undefined;
  }

  exclusiveWriteCursor(): bigint | undefined {
    return this.writeEvidence?.raw === this.raw ? this.writeEvidence.exclusiveThrough : undefined;
  }

  private bind(raw: RoostNodeStream): NodeLodyHistory {
    const generation = this;
    const unguarded = new NodeLodyHistory(raw, this.owner);
    let retired = false;
    this.retireBinding = () => {
      retired = true;
    };
    let boundEpoch = this.epoch?.slice() ?? null;
    const checkCurrent = async () => {
      await this.assertReceiptFormat(raw);
      const [next, epoch] = await raw.readIndex([nextKey, epochKey]);
      if (retired || next !== null || !sameEpoch(boundEpoch, epoch ?? null)) throw stale();
    };
    const guardedWrite: RoostNodeStream['writeBatch'] = async (writes, options) => {
      const activation = this.activation?.raw === raw ? this.activation : undefined;
      const cursor =
        activation?.cursor ??
        options?.expectedEventCursor ??
        (await unguarded.observedEventCursor());
      await this.assertReceiptFormat(raw);
      if (retired) throw stale();
      // Compare the bound generation in the SAME transaction as content and
      // receipts. This also catches pointer changes that emit no history event.
      const expectedIndexes = [
        ...(options?.expectedIndexes ?? []),
        { ...nextKey, value: null },
        { ...epochKey, value: boundEpoch },
      ];
      if (!activation) {
        const result = await raw.writeBatch(writes, {
          ...options,
          expectedEventCursor: cursor,
          expectedIndexes,
        });
        this.recordWrite(raw, result, options);
        return result;
      }
      const indexPuts = [
        ...(options?.indexPuts ?? []),
        { ...epochKey, value: new Uint8Array(), onceKey: activation.key, emitEvent: true },
      ];
      const result = await raw.writeBatch(
        [
          ...writes,
          {
            kind: 'createOnce',
            key: activation.key,
            parents: [],
            contentJson: applicationJsonText({
              version: 1,
              viewId: this.viewId,
              operationId: activation.operationId,
            }),
          },
          { kind: 'sealOnce', key: activation.key, expectedNextSeq: 1n },
        ],
        {
          ...options,
          expectedEventCursor: cursor,
          expectedIndexes,
          indexPuts,
        }
      );
      this.recordWrite(raw, result, { ...options, indexPuts });
      const epoch = result.updates.at(-1)?.turnId;
      if (!epoch) throw new Error('Roost branch activation receipt is missing');
      // Advance only from this transaction's receipt. A subsequent index read
      // could accidentally bind this writer to somebody else's activation.
      boundEpoch = epoch.slice();
      this.epoch = epoch.slice();
      this.activation = undefined;
      return result;
    };
    const guarded = new Proxy(raw, {
      get(target, property) {
        if (property === 'compareAndWriteIndex')
          return async (...args: Parameters<RoostNodeStream['compareAndWriteIndex']>) => {
            await generation.assertReceiptFormat(raw);
            const committed = await raw.compareAndWriteIndex(...args);
            const evidence = generation.writeEvidence;
            if (committed && evidence?.raw === raw) {
              if (args[2]?.eventKeys?.length) {
                evidence.metadataThrough = undefined;
                evidence.settledThrough = undefined;
                evidence.exclusiveThrough = undefined;
              }
              for (const key of args[2]?.eventKeys ?? [])
                addEvidence(evidence.indexes, indexKey(key.table, key.key));
            }
            return committed;
          };
        if (property === 'writeBatch') return guardedWrite;
        if (property === 'edit')
          return (
            turnId: Uint8Array,
            expectedNextSeq: bigint,
            ops: Parameters<RoostNodeStream['edit']>[2]
          ) => guardedWrite([{ kind: 'edit', turnId, expectedNextSeq, ops }]);
        if (property === 'seal')
          return (turnId: Uint8Array, expectedNextSeq: bigint) =>
            guardedWrite([{ kind: 'seal', turnId, expectedNextSeq }]);
        if (property === 'createOnce')
          return async (...args: Parameters<RoostNodeStream['createOnce']>) => {
            const cursor = args[3]?.expectedEventCursor ?? (await unguarded.observedEventCursor());
            await checkCurrent();
            const result = await raw.createOnce(args[0], args[1], args[2], {
              ...args[3],
              expectedEventCursor: cursor,
            });
            generation.recordWrite(
              raw,
              { updates: result.created ? [{ turnId: result.turnId, seq: 0n }] : [] },
              undefined
            );
            return result;
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new NodeLodyHistory(guarded, this.owner);
  }

  private async readEpoch(raw: RoostNodeStream, epoch: Uint8Array | null): Promise<void> {
    if (epoch === null) return;
    const proof = await raw.readTurn(epoch);
    if (
      proof.kind !== 'found' ||
      !proof.turn.sealed ||
      !Buffer.from(proof.turn.owner).equals(Buffer.from(this.owner))
    )
      throw new Error('Roost branch activation is unavailable');
    const value = toApplicationJson(decodeJson(new TextEncoder().encode(proof.turn.contentJson)));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('version' in value) ||
      value.version !== 1 ||
      !('viewId' in value) ||
      value.viewId !== this.viewId ||
      !('operationId' in value) ||
      typeof value.operationId !== 'string'
    )
      throw new Error('Invalid Roost branch activation');
  }

  private async activate<T>(
    operationId: string,
    cursor: bigint,
    operation: (history: NodeLodyHistory) => Promise<T>
  ): Promise<T> {
    if (this.activation) throw new Error('Roost branch activation is already running');
    const activation = {
      raw: this.raw,
      operationId,
      cursor,
      key: new TextEncoder().encode(`branch-epoch:${randomUUID()}`),
    };
    this.activation = activation;
    const history = this.history;
    const retire = this.retireBinding;
    try {
      return await operation(history);
    } finally {
      if (this.activation === activation) this.activation = undefined;
      // The SDK may use this binding to finish publication after its atomic
      // activation. Once it returns, retire even our own old references; only
      // a fresh binding may author writes against the new branch epoch.
      if (this.history === history) {
        retire?.();
        this.history = this.bind(this.raw);
      }
    }
  }

  fork(input: ForkAndActivateInput, cursor: bigint) {
    return this.activate(input.operationId, cursor, (history) => history.forkAndActivate(input));
  }

  replaceMembers(input: ReplaceActiveBranchMembersInput, cursor: bigint) {
    return this.activate(input.operationId, cursor, (history) =>
      history.replaceActiveBranchMembers(input)
    );
  }

  restore(input: RestoreActiveBranchInput, cursor: bigint) {
    return this.activate(input.operationId, cursor, (history) =>
      history.restoreActiveBranch(input)
    );
  }

  resolve(): Promise<boolean> {
    const next = this.resolveSerial.then(() => this.resolveCurrent());
    this.resolveSerial = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async resolveCurrent(): Promise<boolean> {
    let changed = false;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(this.streamId)) throw new Error('Roost history generation cycle');
      seen.add(this.streamId);
      await this.assertReceiptFormat(this.raw);
      const [turnId, epoch] = await this.raw.readIndex([nextKey, epochKey]);
      if (turnId === null || turnId === undefined) {
        if (!sameEpoch(this.epoch, epoch ?? null)) {
          await this.readEpoch(this.raw, epoch ?? null);
          this.epoch = epoch?.slice() ?? null;
          this.history = this.bind(this.raw);
          changed = true;
        }
        return changed;
      }
      const activation = await this.raw.readTurn(turnId);
      if (
        activation.kind !== 'found' ||
        !activation.turn.sealed ||
        !Buffer.from(activation.turn.owner).equals(Buffer.from(this.owner))
      )
        throw new Error('Roost history activation is unavailable');
      const content = toApplicationJson(
        decodeJson(new TextEncoder().encode(activation.turn.contentJson))
      );
      if (!content || typeof content !== 'object' || Array.isArray(content))
        throw new Error('Invalid Roost history activation');
      const value = content as Record<string, unknown>;
      if (
        value.version !== 1 ||
        value.previous !== this.streamId ||
        typeof value.next !== 'string' ||
        !value.next.startsWith(`${this.root}:generation:`)
      )
        throw new Error('Invalid Roost history generation');
      if (value.externalHistoryCursor !== undefined) {
        this.externalHistoryCursor =
          value.externalHistoryCursor as import('@lody/shared').SessionExternalHistoryCursorDocState;
      }
      this.ancestors.push(this.history);
      this.streamId = value.next;
      this.raw = this.client.stream(this.streamId);
      await this.assertReceiptFormat(this.raw);
      const [nextEpoch] = await this.raw.readIndex([epochKey]);
      await this.readEpoch(this.raw, nextEpoch ?? null);
      this.epoch = nextEpoch?.slice() ?? null;
      this.history = this.bind(this.raw);
      await this.history.catchUpIndex();
      await this.history.recoverPendingBatches();
      changed = true;
    }
  }

  async lookupOperation(identity: HistoryIdentity) {
    for (const history of [this.history, ...[...this.ancestors].reverse()]) {
      await this.assertReceiptFormat(history.stream as RoostNodeStream);
      if (identity.kind === 'publication') {
        const [receipt] = await history.stream.readIndex([
          { table: AGENT_RECEIPTS_TABLE, key: agentReceiptKey(identity) },
        ]);
        if (receipt) return decodeAgentReceipt(receipt);
      }
      const found = await history.lookup(identity);
      if (found?.kind === 'found') {
        const inner = await history.read(found.turn.turnId);
        if (inner.kind !== 'found') throw new Error('Roost operation receipt is incomplete');
        return toApplicationJson(decodeJson(new TextEncoder().encode(inner.turn.contentJson)));
      }
    }
    return undefined;
  }

  async lookupInputAcceptance(input: HistoryInputIdentity) {
    for (const history of [this.history, ...[...this.ancestors].reverse()]) {
      const found = await history.readInputAcceptance(input);
      if (found) return found;
    }
    return undefined;
  }

  /** Prepare privately; one CAS publishes all rows or none. The old stream survives. */
  async replace(
    next: readonly SessionHistoryInput[],
    operationId: string,
    expectedCursor?: bigint,
    options: {
      commands?: readonly HistoryBatchCommand[];
      externalHistoryCursor?: import('@lody/shared').SessionExternalHistoryCursorDocState;
    } = {}
  ): Promise<void> {
    const previous = this.raw;
    const previousId = this.streamId;
    const previousEpoch = this.epoch?.slice() ?? null;
    const previousHistory = this.history;
    await this.assertReceiptFormat(previous);
    const cursor = expectedCursor ?? (await previousHistory.observedEventCursor());
    const [previousHeadRaw] = await previous.readIndex([ROOST_HEAD_KEY]);
    const previousRevision = previousHeadRaw ? decodeRoostHead(previousHeadRaw).historyRevision : 0;
    if ((await previous.readIndex([nextKey]))[0] !== null) throw stale();
    const nextId = `${this.root}:generation:${randomUUID()}`;
    const staged = new NodeLodyHistory(this.client.stream(nextId), this.owner);
    let head: Parameters<NodeLodyHistory['acceptToView']>[0]['expectedHead'] = null;
    let parents: Parameters<NodeLodyHistory['acceptToView']>[0]['input']['parents'] = [];
    for (const [position, entry] of next.entries()) {
      const accepted = await staged.acceptToView({
        viewId: this.viewId,
        expectedRevision: BigInt(position),
        expectedHead: head,
        operationId: `stage:${position}`,
        input: {
          kind: 'message',
          businessId: entry.id,
          segmentId: 'primary',
          parents,
          content: encodeRoostContent(entry),
        },
      });
      head = accepted.newHead;
      if (position < next.length - 1 || entry.finished === true) {
        await staged.finish(accepted.turnId, 1n);
        const sealed = await staged.stream.readTurnHeader(accepted.turnId);
        if (sealed.kind !== 'found' || !sealed.turn?.sealed)
          throw new Error('Roost staged history is incomplete');
        parents = [{ id: accepted.turnId, hash: sealed.turn.sealed }];
      }
    }
    const verified = await staged.readActiveBranch(this.viewId);
    if (!verified.complete || verified.messages.length !== next.length)
      throw new Error('Roost staged history is incomplete');
    if (options.commands?.length)
      await staged.commitHistoryBatch(`stage:${operationId}`, [...options.commands], {
        recovery: 'local',
      });
    const stagedCursor = await staged.observedEventCursor();
    const stagedHead = encodeRoostHead({
      version: 1,
      scope: createHash('sha256').update(this.owner).update(nextId).digest('hex'),
      cursor: stagedCursor.toString(),
      historyRevision: previousRevision + 1,
      historyCount: next.length,
      change: { kind: 'structure', from: 0, to: next.length },
    });
    await staged.stream.writeBatch([], {
      expectedEventCursor: stagedCursor,
      expectedIndexes: [{ ...ROOST_HEAD_KEY, value: null }],
      indexPuts: [{ ...ROOST_HEAD_KEY, value: stagedHead }],
    });
    const key = new TextEncoder().encode(
      `generation:${createHash('sha256').update(nextId).digest('hex')}`
    );
    await previous.writeBatch(
      [
        {
          kind: 'createOnce',
          key,
          parents: [],
          contentJson: applicationJsonText({
            version: 1,
            previous: previousId,
            next: nextId,
            operationId,
            ...((options.externalHistoryCursor ?? this.externalHistoryCursor)
              ? {
                  externalHistoryCursor:
                    options.externalHistoryCursor ?? this.externalHistoryCursor,
                }
              : {}),
          }),
        },
        { kind: 'sealOnce', key, expectedNextSeq: 1n },
      ],
      {
        expectedEventCursor: cursor,
        expectedIndexes: [
          { ...ROOST_HEAD_KEY, value: previousHeadRaw ?? null },
          { ...nextKey, value: null },
          { ...epochKey, value: previousEpoch },
        ],
        indexPuts: [{ ...nextKey, value: new Uint8Array(), onceKey: key, emitEvent: true }],
      }
    );
    await this.resolve();
  }
}
