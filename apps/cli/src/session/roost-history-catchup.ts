import type {
  SessionHistoryChanges,
  SessionHistoryInput,
  SessionHistoryReadQuery,
  SessionHistoryReadResponse,
} from '@lody/shared';
import { SESSION_HISTORY_READ_MAX_RANGE } from '@lody/shared';
import type { SessionHistoryReader, SessionTurnRead } from '@lody/shared/session-data';

export type RoostCatchupQuery = Extract<
  SessionHistoryReadQuery,
  { kind: 'readChanges' | 'readRange' | 'readTurn' }
>;
type BodyQuery = Exclude<RoostCatchupQuery, { kind: 'readChanges' }>;
type CatchupResponse = SessionHistoryReadResponse & {
  result: SessionHistoryChanges;
  historyCount: number;
};

const MAX_CAPTURE_TURNS = 8 * SESSION_HISTORY_READ_MAX_RANGE;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 4 * MAX_CAPTURE_BYTES;
const MAX_RETAINED_CAPTURES = 16;
const CAPTURE_LIFETIME_MS = 120_000;

type Capture = {
  owner: symbol;
  response: CatchupResponse;
  start: number;
  range: readonly SessionTurnRead[];
  turns: ReadonlyMap<string, SessionTurnRead>;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
};

/** Bounded, detached data for exact-checkpoint reads on a single daemon. */
export class RoostHistoryCatchup {
  private readonly captures = new Set<Capture>();
  private bytes = 0;
  private preparing = 0;

  read(owner: symbol, query: BodyQuery): SessionHistoryReadResponse | undefined {
    if (!query.atCheckpoint) return undefined;
    for (const capture of this.captures) {
      if (capture.owner !== owner || capture.response.result.checkpoint !== query.atCheckpoint)
        continue;
      if (query.kind === 'readTurn') {
        const result = capture.turns.get(query.turnId);
        if (result) return { ...capture.response, result };
        continue;
      }
      const from = query.from - capture.start;
      const to = query.to - capture.start;
      if (from >= 0 && to <= capture.range.length)
        return { ...capture.response, result: capture.range.slice(from, to) };
    }
    return undefined;
  }

  release(owner: symbol): void {
    for (const capture of this.captures) if (capture.owner === owner) this.remove(capture);
  }

  private remove(capture: Capture): void {
    if (!this.captures.delete(capture)) return;
    this.bytes -= capture.bytes;
    clearTimeout(capture.timer);
  }

  async prepare(args: {
    owner: symbol;
    query: Extract<RoostCatchupQuery, { kind: 'readChanges' }>;
    response: CatchupResponse;
    readRange(from: number, to: number): Promise<readonly SessionTurnRead[]>;
    readTurn: SessionHistoryReader['readTurn'];
    validate(): Promise<void>;
    signal?: AbortSignal;
  }): Promise<CatchupResponse> {
    const { owner, response, query, signal } = args;
    const changes = response.result;
    const verifiedResponse = async () => {
      signal?.throwIfAborted();
      await args.validate();
      signal?.throwIfAborted();
      return response;
    };
    if (changes.state !== 'ready' || query.includeBodiesFrom === undefined)
      return verifiedResponse();

    const count = response.historyCount;
    const retainedFrom =
      query.includeBodiesFrom >= count && count > 0
        ? Math.max(0, count - 40)
        : Math.min(query.includeBodiesFrom, count);
    const from =
      changes.from === undefined
        ? undefined
        : Math.max(retainedFrom, Math.min(changes.from, count));
    const start = from ?? count;
    const work = changes.ids.length + count - start;
    if (work <= SESSION_HISTORY_READ_MAX_RANGE) {
      const patched = new Set(changes.patches?.turns.map((turn) => turn.turnId));
      const changed: SessionHistoryInput[] = [];
      for (const id of changes.ids) {
        signal?.throwIfAborted();
        if (patched.has(id)) continue;
        const read = await args.readTurn(id);
        if (read.state === 'ready') changed.push(read.turn as SessionHistoryInput);
      }
      const suffix =
        start === count
          ? []
          : (await args.readRange(start, count)).map((read) => {
              if (read.state !== 'ready') throw new Error('History suffix body is unavailable');
              return read.turn as SessionHistoryInput;
            });
      await verifiedResponse();
      return {
        ...response,
        result: {
          ...changes,
          bodies: { changed, ...(from === undefined ? {} : { from }), suffix },
        },
      };
    }

    for (const capture of this.captures) {
      if (
        capture.owner === owner &&
        capture.response.result.checkpoint === changes.checkpoint &&
        capture.start <= start &&
        changes.ids.every((id) => capture.turns.has(id))
      )
        return verifiedResponse();
    }
    // Capacity does not invalidate a checkpoint. Ordinary pages still verify
    // the current head and the reader can retry a superseded page.
    if (
      Math.max(changes.ids.length, count - start) > MAX_CAPTURE_TURNS ||
      this.captures.size + this.preparing >= MAX_RETAINED_CAPTURES ||
      this.bytes >= MAX_RETAINED_BYTES
    )
      return verifiedResponse();

    this.preparing++;
    let bytes = 0;
    let retained = false;
    const range: SessionTurnRead[] = [];
    const turns = new Map<string, SessionTurnRead>();
    const record = (id: string, read: SessionTurnRead) => {
      const size = Buffer.byteLength(JSON.stringify(read)) + Buffer.byteLength(id);
      if (
        turns.size >= MAX_CAPTURE_TURNS ||
        bytes + size > MAX_CAPTURE_BYTES ||
        this.bytes + size > MAX_RETAINED_BYTES
      )
        return false;
      bytes += size;
      this.bytes += size;
      turns.set(id, read);
      return true;
    };
    try {
      for (let position = start; position < count; position += SESSION_HISTORY_READ_MAX_RANGE) {
        signal?.throwIfAborted();
        const end = Math.min(count, position + SESSION_HISTORY_READ_MAX_RANGE);
        const page = await args.readRange(position, end);
        if (page.length !== end - position) throw new Error('History catch-up range is incomplete');
        for (const read of page) {
          if (read.state !== 'ready') throw new Error('History catch-up body is unavailable');
          if (!record(read.turn.id, read)) return verifiedResponse();
          range.push(read);
        }
      }
      for (const id of changes.ids) {
        signal?.throwIfAborted();
        if (!turns.has(id) && !record(id, await args.readTurn(id))) return verifiedResponse();
      }
      // The proof and the bodies belong to one local owner read. Pages can
      // now be sent independently of later Agent writes.
      await verifiedResponse();
      const timer = setTimeout(() => this.remove(capture), CAPTURE_LIFETIME_MS);
      timer.unref();
      const capture = { owner, response, start, range, turns, bytes, timer };
      this.captures.add(capture);
      retained = true;
      return response;
    } finally {
      this.preparing--;
      if (!retained) this.bytes -= bytes;
    }
  }
}
