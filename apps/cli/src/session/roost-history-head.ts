import type { IndexEntry, IndexPut, RoostNodeStream } from '@loro-dev/roost-node';
import type { RoostHistoryChange } from '@lody/shared/session-data';

export const ROOST_HEAD_KEY = {
  table: 'lody_history_published_head_v1',
  key: new Uint8Array(),
};

export type RoostPublishedHead = {
  version: 1;
  scope: string;
  cursor: string;
  historyRevision: number;
  historyCount: number;
  change: RoostHistoryChange | null;
};

export function decodeRoostHead(raw: Uint8Array): RoostPublishedHead {
  const value = JSON.parse(new TextDecoder().decode(raw)) as RoostPublishedHead;
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    typeof value.scope !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.scope) ||
    typeof value.cursor !== 'string' ||
    value.cursor.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(value.cursor) ||
    BigInt(value.cursor) > 0xffffffffffffffffn ||
    !Number.isSafeInteger(value.historyRevision) ||
    value.historyRevision < 0 ||
    !Number.isSafeInteger(value.historyCount) ||
    value.historyCount < 0 ||
    (value.change !== null &&
      (!value.change ||
        (value.change.kind === 'changed'
          ? !Array.isArray(value.change.businessIds) ||
            value.change.businessIds.some((id) => typeof id !== 'string')
          : value.change.kind !== 'structure' ||
            !Number.isSafeInteger(value.change.from) ||
            value.change.from < 0 ||
            !Number.isSafeInteger(value.change.to) ||
            value.change.to < value.change.from)))
  )
    throw new Error('Invalid Roost published head');
  return value;
}

export function encodeRoostHead(head: RoostPublishedHead): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(head));
  decodeRoostHead(bytes);
  return bytes;
}

export type RoostHeadPlan = {
  host: RoostNodeStream;
  head: RoostPublishedHead;
  expected: IndexEntry;
  put: IndexPut;
};

/** One current publication record. Never a second history or a read cache proof. */
export class RoostHistoryHead {
  private cached: { host: RoostNodeStream; head: RoostPublishedHead; raw: Uint8Array } | undefined;

  constructor(
    private readonly host: () => RoostNodeStream,
    private readonly scope: () => string
  ) {}

  current(): RoostPublishedHead | undefined {
    return this.cached?.host === this.host() ? this.cached.head : undefined;
  }

  async read(): Promise<RoostPublishedHead | undefined> {
    const host = this.host();
    const [raw] = await host.readIndex([ROOST_HEAD_KEY]);
    if (!raw) {
      this.cached = undefined;
      return undefined;
    }
    const head = decodeRoostHead(raw);
    if (head.scope !== this.scope()) throw new Error('Roost publication scope mismatch');
    this.cached = { host, head, raw: raw.slice() };
    return head;
  }

  plan(cursor: bigint, count: number, change: RoostHistoryChange | undefined): RoostHeadPlan {
    const host = this.host();
    const previous = this.cached?.host === host ? this.cached : undefined;
    const head: RoostPublishedHead = {
      version: 1,
      scope: this.scope(),
      cursor: cursor.toString(),
      historyRevision: (previous?.head.historyRevision ?? 0) + 1,
      historyCount: count,
      change: change ?? null,
    };
    const raw = encodeRoostHead(head);
    return {
      host,
      head,
      expected: { ...ROOST_HEAD_KEY, value: previous?.raw.slice() ?? null },
      put: { ...ROOST_HEAD_KEY, value: raw },
    };
  }

  accept(plan: RoostHeadPlan): void {
    if (plan.host !== this.host() || plan.head.scope !== this.scope())
      throw new Error('Roost publication changed');
    this.cached = {
      host: plan.host,
      head: decodeRoostHead(plan.put.value),
      raw: plan.put.value.slice(),
    };
  }

  async publish(
    cursor: bigint,
    count: number,
    change: RoostHistoryChange | undefined,
    fence: readonly IndexEntry[]
  ): Promise<RoostPublishedHead> {
    const current = this.current() ?? (await this.read());
    if (current?.cursor === cursor.toString() && current.historyCount === count) return current;
    const plan = this.plan(cursor, count, change);
    await plan.host.writeBatch([], {
      expectedEventCursor: cursor,
      expectedIndexes: [plan.expected, ...fence],
      indexPuts: [plan.put],
    });
    this.accept(plan);
    return plan.head;
  }
}
