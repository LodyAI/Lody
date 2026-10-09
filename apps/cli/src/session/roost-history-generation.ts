import { randomUUID, createHash } from 'node:crypto';
import { decodeJson } from '@loro-dev/roost';
import {
  NodeLodyHistory,
  applicationJsonText,
  toApplicationJson,
  type HistoryBatchCommand,
  type HistoryIdentity,
} from '@loro-dev/roost/lody-history';
import type { RoostNativeClient, RoostNodeStream } from '@loro-dev/roost-node';
import type { SessionHistoryInput } from '@lody/shared';
import { encodeRoostContent } from './roost-history-port';

const nextKey = { table: 'lody_history_generation_v1', key: new TextEncoder().encode('next') };
const stale = () => Object.assign(new Error('Roost history generation changed'), { code: 'stale' });

/** Application-owned activation; branch/envelope formats remain entirely SDK-owned. */
export class RoostHistoryGeneration {
  private readonly root: string;
  private streamId: string;
  private raw: RoostNodeStream;
  private readonly ancestors: NodeLodyHistory[] = [];
  private resolveSerial: Promise<void> = Promise.resolve();
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

  get host(): RoostNodeStream {
    return this.history.stream as RoostNodeStream;
  }

  private bind(raw: RoostNodeStream): NodeLodyHistory {
    const unguarded = new NodeLodyHistory(raw, this.owner);
    const guardedWrite: RoostNodeStream['writeBatch'] = async (writes, options) => {
      const cursor = options?.expectedEventCursor ?? (await unguarded.observedEventCursor());
      if ((await raw.readIndex([nextKey]))[0] !== null) throw stale();
      // The cursor was observed BEFORE checking the pointer, so activation racing
      // this write invalidates the entire native transaction, including receipts.
      return raw.writeBatch(writes, { ...options, expectedEventCursor: cursor });
    };
    const guarded = new Proxy(raw, {
      get(target, property) {
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
            if ((await raw.readIndex([nextKey]))[0] !== null) throw stale();
            return raw.createOnce(args[0], args[1], args[2], {
              ...args[3],
              expectedEventCursor: cursor,
            });
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return new NodeLodyHistory(guarded, this.owner);
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
      const [turnId] = await this.raw.readIndex([nextKey]);
      if (turnId === null || turnId === undefined) return changed;
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
      this.history = this.bind(this.raw);
      await this.history.catchUpIndex();
      await this.history.recoverPendingBatches();
      changed = true;
    }
  }

  async lookupOperation(identity: HistoryIdentity) {
    for (const history of [this.history, ...[...this.ancestors].reverse()]) {
      const found = await history.lookup(identity);
      if (found?.kind === 'found') {
        const inner = await history.read(found.turn.turnId);
        if (inner.kind !== 'found') throw new Error('Roost operation receipt is incomplete');
        return toApplicationJson(decodeJson(new TextEncoder().encode(inner.turn.contentJson)));
      }
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
    const cursor = expectedCursor ?? (await this.history.observedEventCursor());
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
      await staged.commitHistoryBatch(`stage:${operationId}`, [...options.commands]);
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
        indexPuts: [{ ...nextKey, value: new Uint8Array(), onceKey: key, emitEvent: true }],
      }
    );
    await this.resolve();
  }
}
