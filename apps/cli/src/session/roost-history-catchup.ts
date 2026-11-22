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
  response: CatchupResponse;
  start: number;
  range: readonly SessionTurnRead[];
  turns: ReadonlyMap<string, SessionTurnRead>;
  bytes: number;
};

type CaptureRead = {
  query: ChangesQuery;
  response: CatchupResponse;
  readRange(from: number, to: number): Promise<readonly SessionTurnRead[]>;
  readTurns(ids: readonly string[]): Promise<ReadonlyMap<string, ReadyTurn>>;
  validate(response: CatchupResponse, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
};

type CapturePreparation = CaptureRead & {
  owner: symbol;
  assertAvailable(signal: AbortSignal): void;
  onOwner<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T>;
  finish<T>(
    capture: (latest: CatchupResponse, tail: ReadyChanges) => Promise<T>,
    signal: AbortSignal
  ): Promise<T>;
};

type HistoryPreparation = {
  owner: symbol;
  key: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  result: Promise<CatchupResponse>;
  capture?: Capture;
};

const preparationKey = (query: ChangesQuery) =>
  JSON.stringify([query.checkpoint, query.includeBodiesFrom, query.withPatches ?? false]);

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
  await args.validate(response, signal);
  return {
    ...response,
    result: { ...changes, bodies: { changed, ...(from === undefined ? {} : { from }), suffix } },
  };
}

/** Bounded, detached data for exact-checkpoint reads on a single daemon. */
export class RoostHistoryCatchup {
  private readonly preparations = new Set<HistoryPreparation>();
  private bytes = 0;

  read(owner: symbol, query: BodyQuery): SessionHistoryReadResponse | undefined {
    if (!query.atCheckpoint) return undefined;
    for (const preparation of this.preparations) {
      const capture = preparation.capture;
      if (
        preparation.owner !== owner ||
        !capture ||
        capture.response.result.checkpoint !== query.atCheckpoint
      )
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
    for (const preparation of this.preparations)
      if (preparation.owner === owner) this.retire(preparation);
  }

  private retire(preparation: HistoryPreparation): void {
    preparation.controller.abort(
      Object.assign(new Error('History preparation expired or was superseded'), { code: 'stale' })
    );
    if (preparation.capture) this.remove(preparation);
  }

  private remove(preparation: HistoryPreparation): void {
    if (!this.preparations.delete(preparation)) return;
    clearTimeout(preparation.timer);
    if (preparation.capture) this.bytes -= preparation.capture.bytes;
  }

  private expire(preparation: HistoryPreparation) {
    clearTimeout(preparation.timer);
    const timer = setTimeout(() => this.retire(preparation), CAPTURE_LIFETIME_MS);
    timer.unref();
    return timer;
  }

  private hasCapture(owner: symbol, response: CatchupResponse, start: number): boolean {
    const changes = response.result;
    if (changes.state !== 'ready') return false;
    for (const preparation of this.preparations) {
      const capture = preparation.capture;
      if (
        preparation.owner === owner &&
        capture?.response.result.checkpoint === changes.checkpoint &&
        capture.start <= start &&
        changes.ids.every((id) => capture.turns.has(id))
      )
        return true;
    }
    return false;
  }

  resume(
    owner: symbol,
    query: ChangesQuery,
    signal?: AbortSignal
  ): Promise<CatchupResponse> | undefined {
    if (query.inlineOnly || query.includeBodiesFrom === undefined) return undefined;
    const key = preparationKey(query);
    for (const preparation of this.preparations) {
      if (
        preparation.owner === owner &&
        preparation.key === key &&
        !preparation.controller.signal.aborted
      )
        return this.waitForPreparation(preparation, signal);
    }
    return undefined;
  }

  prepare(args: CapturePreparation): Promise<CatchupResponse> | CatchupResponse {
    const { owner, response, query, signal } = args;
    signal?.throwIfAborted();
    const changes = response.result;
    if (changes.state !== 'ready' || query.includeBodiesFrom === undefined || query.inlineOnly)
      return response;
    const existing = this.resume(owner, query, signal);
    if (existing) return existing;
    const count = response.historyCount;
    const start = captureFrom(query, response) ?? count;
    if (
      Math.max(changes.ids.length, count - start) > MAX_CAPTURE_TURNS ||
      this.hasCapture(owner, response, start) ||
      this.preparations.size >= MAX_RETAINED_CAPTURES ||
      this.bytes >= MAX_RETAINED_BYTES
    )
      return response;

    const preparation: HistoryPreparation = {
      owner,
      key: preparationKey(query),
      controller: new AbortController(),
      timer: setTimeout(() => this.retire(preparation), CAPTURE_LIFETIME_MS),
      result: Promise.resolve().then(() => this.materialize(args, changes, start, preparation)),
    };
    preparation.timer.unref();
    this.preparations.add(preparation);
    void preparation.result.then(
      () => {
        if (!this.preparations.has(preparation)) return;
        if (preparation.capture) preparation.timer = this.expire(preparation);
        else this.remove(preparation);
      },
      () => this.remove(preparation)
    );
    return this.waitForPreparation(preparation, signal);
  }

  private async waitForPreparation(preparation: HistoryPreparation, caller?: AbortSignal) {
    const owner = preparation.controller.signal;
    const signal = caller ? AbortSignal.any([caller, owner]) : owner;
    signal.throwIfAborted();
    let onAbort!: () => void;
    try {
      const response = await new Promise<CatchupResponse>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        preparation.result.then(resolve, reject);
      });
      signal.throwIfAborted();
      return response;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async materialize(
    args: CapturePreparation,
    changes: ReadyChanges,
    start: number,
    preparation: HistoryPreparation
  ): Promise<CatchupResponse> {
    const signal = preparation.controller.signal;
    const { owner, response, query } = args;
    const count = response.historyCount;
    args.assertAvailable(signal);
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
        const page = await args.onOwner(() => args.readRange(position, end), signal);
        for (const value of page) {
          const read = captureBody(value);
          if (range.length >= MAX_CAPTURE_TURNS || !reserve(read.turn.id, read)) return response;
          turns.set(read.turn.id, read);
          range.push(read);
        }
        if (page.length < end - position) break;
      }
      const remaining = changes.ids.filter((id) => !turns.has(id));
      if (turns.size + remaining.length > MAX_CAPTURE_TURNS) return response;
      for (let offset = 0; offset < remaining.length; offset += SESSION_HISTORY_READ_MAX_RANGE) {
        const ids = remaining.slice(offset, offset + SESSION_HISTORY_READ_MAX_RANGE);
        const reads = await args.onOwner(() => args.readTurns(ids), signal);
        for (const id of ids) {
          const read = reads.get(id) ?? { state: 'missing' };
          if (!reserve(id, read)) return response;
          turns.set(id, read);
        }
      }
      const reconcile = async (latest: CatchupResponse, tail: ReadyChanges) => {
        args.assertAvailable(signal);
        const latestCount = latest.historyCount;
        const latestStart = captureFrom(query, latest) ?? latestCount;
        const latestChanges = latest.result;
        if (latestChanges.state !== 'ready' || this.hasCapture(owner, latest, latestStart))
          return { response: latest };
        if (latestChanges.checkpoint === changes.checkpoint) {
          if (range.length !== count - start)
            throw new Error('History catch-up range is incomplete');
          await args.validate(latest, signal);
          return { response: latest, data: { start, range, turns } };
        }
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
          signal.throwIfAborted();
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
        signal.throwIfAborted();
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
        await args.validate(latest, signal);
        return {
          response: latest,
          data: { start: latestStart, range: finalRange, turns: finalTurns },
        };
      };
      const final = await args.finish(reconcile, signal);
      args.assertAvailable(signal);
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
      preparation.capture = {
        response: final.response,
        ...final.data,
        bytes: retainedBytes,
      };
      bytes -= retainedBytes;
      return final.response;
    } finally {
      this.bytes -= bytes;
    }
  }
}
