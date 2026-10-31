import { Clock, Effect, Schema } from 'effect';
import type { LedgerPinStore } from '../../services/ledger';
import { LocalStoreError } from '../../services/errors';
import { own } from '../lifecycle';
import { bytesEqual } from '../foundation/cbor';

export const EPOCH_WRITE_GRACE_MS = 15 * 60_000;
const MAX_BYTES = 1024 * 1024;
const Point = Schema.Struct({
  epoch: Schema.Int,
  clock: Schema.String,
  wall: Schema.Int,
  mono: Schema.Int,
  lastWall: Schema.Int,
  lastMono: Schema.Int,
  spent: Schema.Int,
});
const State = Schema.Struct({ version: Schema.Literal(1), points: Schema.Array(Point) });
type Point = typeof Point.Type;
const decode = Schema.decodeUnknownSync(State, { onExcessProperty: 'error' });
const domains = new WeakMap<Clock.Clock, string>();
const fail = () => new LocalStoreError({ store: 'EpochWriteObservations', reason: 'corrupt' });
const attempt = <A>(work: () => A) => Effect.try({ try: work, catch: fail });
const encode = (points: readonly Point[]) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, points }));
  if (bytes.length > MAX_BYTES) throw fail();
  return bytes;
};
const read = (bytes: Uint8Array | null) => {
  if (bytes === null) return [];
  if (bytes.length > MAX_BYTES) throw fail();
  const { points } = decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  let previous = -1;
  for (const point of points) {
    if (
      point.epoch <= previous ||
      point.epoch > 0xffffffff ||
      point.clock.length > 128 ||
      ![point.wall, point.mono, point.lastWall, point.lastMono, point.spent].every(
        Number.isSafeInteger
      ) ||
      point.lastWall < point.wall ||
      point.lastMono < point.mono ||
      point.spent < 0 ||
      point.spent > EPOCH_WRITE_GRACE_MS
    )
      throw fail();
    previous = point.epoch;
  }
  return points;
};

/** Device-local timing only. It grants no ledger, device, role or key authority. */
export function makeEpochWriteGrace(pins: LedgerPinStore['Service'], clock: Clock.Clock) {
  const journal = pins.writeGrace ? own(pins.writeGrace) : undefined;
  const first = new Map<number, Point>();
  const persisted = new Set<number>();
  const unknown = new Set<number>();
  const sample = () => {
    let domain = domains.get(clock);
    if (!domain) {
      domain = globalThis.crypto.randomUUID();
      domains.set(clock, domain);
    }
    const wall = clock.currentTimeMillisUnsafe();
    const mono = Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
    if (![wall, mono].every(Number.isSafeInteger)) throw fail();
    return { clock: domain, wall, mono };
  };
  const edit = Effect.fnUntraced(function* <A>(
    change: (points: readonly Point[]) => { points: readonly Point[]; result: A }
  ) {
    if (!journal) return yield* fail();
    for (let retry = 0; retry < 3; retry++) {
      const before = yield* journal.read();
      const next = yield* attempt(() => change(read(before)));
      const bytes = yield* attempt(() => encode(next.points));
      if ((before && bytesEqual(before, bytes)) || (yield* journal.compareAndSet(before, bytes)))
        return next.result;
    }
    return yield* new LocalStoreError({ store: 'EpochWriteObservations', reason: 'conflict' });
  });
  const capture = Effect.fnUntraced(function* (epoch: number) {
    if (!journal || first.has(epoch) || unknown.has(epoch)) return;
    const result = yield* Effect.result(attempt(sample));
    if (result._tag === 'Failure') {
      unknown.add(epoch);
      return;
    }
    const now = result.success;
    first.set(epoch, { epoch, ...now, lastWall: now.wall, lastMono: now.mono, spent: 0 });
  });
  return {
    capture,
    observe: Effect.fnUntraced(
      function* (epoch: number, priorPinOnFirstRead: boolean) {
        if (!journal || persisted.has(epoch)) return;
        yield* capture(epoch);
        const point = first.get(epoch);
        if (!point) return;
        const original = priorPinOnFirstRead ? { ...point, spent: EPOCH_WRITE_GRACE_MS } : point;
        yield* edit((points) => ({
          points: points.some((p) => p.epoch === epoch)
            ? points
            : [...points, original].sort((a, b) => a.epoch - b.epoch),
          result: undefined,
        }));
        persisted.add(epoch);
      },
      Effect.catch(() => Effect.void)
    ),
    allowed: Effect.fnUntraced(
      function* (epoch: number) {
        if (
          !journal ||
          [...unknown].some((observed) => observed > epoch) ||
          [...first.keys()].some((observed) => observed > epoch && !persisted.has(observed))
        )
          return false;
        const now = yield* attempt(sample);
        return yield* edit((points) => {
          // A later rotation cannot restart the old key's original budget.
          const index = points.findIndex((point) => point.epoch > epoch);
          if (index < 0) return { points, result: false };
          const point = points[index]!;
          // Unknown monotonic continuity (including a new process/page) grants no new window.
          if (point.clock !== now.clock) return { points, result: false };
          const spent =
            now.wall < point.lastWall || now.mono < point.lastMono
              ? EPOCH_WRITE_GRACE_MS
              : Math.min(
                  EPOCH_WRITE_GRACE_MS,
                  Math.max(point.spent, now.wall - point.wall, now.mono - point.mono)
                );
          const next = {
            ...point,
            spent,
            lastWall: Math.max(point.lastWall, now.wall),
            lastMono: Math.max(point.lastMono, now.mono),
          };
          return {
            points: points.map((p, i) => (i === index ? next : p)),
            result: spent < EPOCH_WRITE_GRACE_MS,
          };
        });
      },
      Effect.catch(() => Effect.succeed(false))
    ),
  };
}
