import type {
  SessionHistoryChanges,
  SessionHistoryInput,
  SessionHistoryReadQuery,
  SessionHistoryReadResponse,
} from '@lody/shared';
import { SESSION_HISTORY_READ_MAX_RANGE } from '@lody/shared';
import type { SessionTurnRead } from '@lody/shared/session-data';

export type RoostCatchupQuery = Extract<
  SessionHistoryReadQuery,
  { kind: 'readChanges' | 'readRange' | 'readTurn' }
> & { inlineOnly?: true };
type BodyQuery = Exclude<RoostCatchupQuery, { kind: 'readChanges' }>;
type ChangesQuery = Extract<RoostCatchupQuery, { kind: 'readChanges' }>;
type ReadyChanges = Extract<SessionHistoryChanges, { state: 'ready' }>;
type CatchupResponse = SessionHistoryReadResponse & {
  result: SessionHistoryChanges;
  historyCount: number;
};

const MAX_CAPTURE_TURNS = 8 * SESSION_HISTORY_READ_MAX_RANGE;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 4 * MAX_CAPTURE_BYTES;
const MAX_RETAINED_CAPTURES = 16;
const CAPTURE_LIFETIME_MS = 120_000;

type ReadyTurn = Extract<SessionTurnRead, { state: 'ready' }>;

type Capture = {
  owner: symbol;
  response: CatchupResponse;
  start: number;
  range: readonly SessionTurnRead[];
  turns: ReadonlyMap<string, SessionTurnRead>;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
};

type CaptureRead = {
  query: ChangesQuery;
  response: CatchupResponse;
  readRange(from: number, to: number): Promise<readonly SessionTurnRead[]>;
  readTurns(ids: readonly string[]): Promise<ReadonlyMap<string, ReadyTurn>>;
  validate(response: CatchupResponse): Promise<void>;
  signal?: AbortSignal;
};

function captureFrom(query: ChangesQuery, response: CatchupResponse): number | undefined {
  const { historyCount: count, result: changes } = response;
  if (
    query.includeBodiesFrom === undefined ||
    changes.state !== 'ready' ||
    changes.from === undefined
  )
    return undefined;
  const retainedFrom =
    query.includeBodiesFrom >= count && count > 0
      ? Math.max(0, count - 40)
      : Math.min(query.includeBodiesFrom, count);
  return Math.max(retainedFrom, Math.min(changes.from, count));
}

function captureBody(read: SessionTurnRead): ReadyTurn {
  if (read.state !== 'ready') throw new Error('History catch-up body is unavailable');
  return read;
}

export async function readInlineRoostHistory(
  args: CaptureRead
): Promise<CatchupResponse | undefined> {
  const { response, signal, query } = args;
  const changes = response.result;
  if (changes.state !== 'ready' || query.includeBodiesFrom === undefined) return undefined;
  const from = captureFrom(query, response);
  if (
    changes.ids.length + response.historyCount - (from ?? response.historyCount) >
    SESSION_HISTORY_READ_MAX_RANGE
  )
    return undefined;
  const patched = new Set(changes.patches?.turns.map((turn) => turn.turnId));
  const ids = changes.ids.filter((id) => !patched.has(id));
  signal?.throwIfAborted();
  const reads = await args.readTurns(ids);
  const changed = ids.flatMap((id) => {
    const read = reads.get(id);
    return read ? [read.turn as SessionHistoryInput] : [];
  });
  const suffix =
    from === undefined || from === response.historyCount
      ? []
      : (await args.readRange(from, response.historyCount)).map(
          (read) => captureBody(read).turn as SessionHistoryInput
        );
  await args.validate(response);
  return {
    ...response,
    result: { ...changes, bodies: { changed, ...(from === undefined ? {} : { from }), suffix } },
  };
}

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

  private hasCapture(owner: symbol, response: CatchupResponse, start: number): boolean {
    const changes = response.result;
    if (changes.state !== 'ready') return false;
    for (const capture of this.captures) {
      if (
        capture.owner === owner &&
        capture.response.result.checkpoint === changes.checkpoint &&
        capture.start <= start &&
        changes.ids.every((id) => capture.turns.has(id))
      )
        return true;
    }
    return false;
  }

  async prepare(
    args: CaptureRead & {
      owner: symbol;
      assertAvailable(): void;
      onOwner<T>(read: () => Promise<T>): Promise<T>;
      // Called on the owner after staging. The receipt covers every change from
      // the initial response through the response at which we finalize the capture.
      finish<T>(capture: (latest: CatchupResponse, tail: ReadyChanges) => Promise<T>): Promise<T>;
    }
  ): Promise<CatchupResponse> {
    const { owner, response, query, signal } = args;
    const changes = response.result;
    if (changes.state !== 'ready' || query.includeBodiesFrom === undefined || query.inlineOnly)
      return response;
    const count = response.historyCount;
    const start = captureFrom(query, response) ?? count;
    // Capacity does not invalidate a checkpoint. Ordinary pages still verify
    // the current head and the reader can retry a superseded page.
    if (
      Math.max(changes.ids.length, count - start) > MAX_CAPTURE_TURNS ||
      this.hasCapture(owner, response, start) ||
      this.captures.size + this.preparing >= MAX_RETAINED_CAPTURES ||
      this.bytes >= MAX_RETAINED_BYTES
    )
      return response;

    this.preparing++;
    let bytes = 0;
    const range: ReadyTurn[] = [];
    const turns = new Map<string, SessionTurnRead>();
    const sizes = new Map<SessionTurnRead, number>();
    const reserve = (id: string, read: SessionTurnRead) => {
      const size = Buffer.byteLength(JSON.stringify(read)) + Buffer.byteLength(id);
      if (bytes + size > MAX_CAPTURE_BYTES || this.bytes + size > MAX_RETAINED_BYTES) return false;
      bytes += size;
      this.bytes += size;
      sizes.set(read, size);
      return true;
    };
    try {
      for (let position = start; position < count; position += SESSION_HISTORY_READ_MAX_RANGE) {
        const end = Math.min(count, position + SESSION_HISTORY_READ_MAX_RANGE);
        const page = await args.onOwner(() => args.readRange(position, end));
        for (const value of page) {
          const read = captureBody(value);
          if (range.length >= MAX_CAPTURE_TURNS || !reserve(read.turn.id, read)) return response;
          turns.set(read.turn.id, read);
          range.push(read);
        }
        // A concurrent structural change can shorten the window. The final
        // receipt decides which of these positions are safe to keep.
        if (page.length < end - position) break;
      }
      const remaining = changes.ids.filter((id) => !turns.has(id));
      if (turns.size + remaining.length > MAX_CAPTURE_TURNS) return response;
      for (let offset = 0; offset < remaining.length; offset += SESSION_HISTORY_READ_MAX_RANGE) {
        const ids = remaining.slice(offset, offset + SESSION_HISTORY_READ_MAX_RANGE);
        const reads = await args.onOwner(() => args.readTurns(ids));
        for (const id of ids) {
          const read = reads.get(id) ?? { state: 'missing' };
          if (!reserve(id, read)) return response;
          turns.set(id, read);
        }
      }
      const final = await args.finish(async (latest, tail) => {
        args.assertAvailable();
        const latestCount = latest.historyCount;
        const latestStart = captureFrom(query, latest) ?? latestCount;
        const latestChanges = latest.result;
        if (latestChanges.state !== 'ready' || this.hasCapture(owner, latest, latestStart))
          return { response: latest };
        if (latestChanges.checkpoint === changes.checkpoint) {
          if (range.length !== count - start)
            throw new Error('History catch-up range is incomplete');
          await args.validate(latest);
          return { response: latest, data: { start, range, turns } };
        }
        // Pages may have been read at different heads. Only the positions
        // before the first structural change and IDs untouched since staging
        // started can be reused. Read the dirty remainder at one certified head.
        const keepFrom = Math.min(latestCount, Math.max(latestStart, start));
        const keepTo = Math.max(
          keepFrom,
          Math.min(latestCount, start + range.length, tail.from ?? latestCount)
        );
        const missing = latestCount - latestStart - (keepTo - keepFrom);
        if (
          missing > SESSION_HISTORY_READ_MAX_RANGE ||
          latestCount - latestStart > MAX_CAPTURE_TURNS
        )
          return { response: latest };
        const readRange = async (from: number, to: number): Promise<ReadyTurn[]> => {
          signal?.throwIfAborted();
          const page = (from < to ? await args.readRange(from, to) : []).map(captureBody);
          if (page.length !== to - from) throw new Error('History catch-up range is incomplete');
          return page;
        };
        const kept = range.slice(keepFrom - start, keepTo - start);
        const prefix = await readRange(latestStart, keepFrom);
        const suffix = await readRange(keepTo, latestCount);
        const dirty = new Set(tail.ids);
        const rangeIds = new Set([...prefix, ...kept, ...suffix].map((read) => read.turn.id));
        const repairs = new Set(
          kept.filter((read) => dirty.has(read.turn.id)).map((read) => read.turn.id)
        );
        for (const id of latestChanges.ids) {
          if (rangeIds.has(id)) continue;
          if (tail.from !== undefined || dirty.has(id) || !turns.has(id)) repairs.add(id);
        }
        if (missing + repairs.size > SESSION_HISTORY_READ_MAX_RANGE) return { response: latest };
        signal?.throwIfAborted();
        const repaired = await args.readTurns([...repairs]);
        const finalRange = [
          ...prefix,
          ...kept.map((read) =>
            repairs.has(read.turn.id)
              ? captureBody(repaired.get(read.turn.id) ?? { state: 'missing' })
              : read
          ),
          ...suffix,
        ];
        const finalTurns = new Map<string, SessionTurnRead>(
          finalRange.map((read) => [read.turn.id, read])
        );
        for (const id of latestChanges.ids) {
          if (finalTurns.has(id)) continue;
          const read = repairs.has(id)
            ? (repaired.get(id) ?? { state: 'missing' })
            : turns.get(id)!;
          finalTurns.set(id, read);
        }
        await args.validate(latest);
        return {
          response: latest,
          data: { start: latestStart, range: finalRange, turns: finalTurns },
        };
      });
      args.assertAvailable();
      if (!final.data) return final.response;
      let retainedBytes = 0;
      for (const [id, read] of final.data.turns) {
        if (!sizes.has(read) && !reserve(id, read)) return final.response;
        retainedBytes += sizes.get(read)!;
      }
      if (
        final.data.turns.size > MAX_CAPTURE_TURNS ||
        this.hasCapture(owner, final.response, final.data.start)
      )
        return final.response;
      const timer = setTimeout(() => this.remove(capture), CAPTURE_LIFETIME_MS);
      timer.unref();
      const capture = {
        owner,
        response: final.response,
        ...final.data,
        bytes: retainedBytes,
        timer,
      };
      this.captures.add(capture);
      bytes -= retainedBytes;
      return final.response;
    } finally {
      this.preparing--;
      this.bytes -= bytes;
    }
  }
}
