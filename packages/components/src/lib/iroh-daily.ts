/** Device-local, cross-workspace diagnostics. Only fixed integer fields leave this store. */
export const IROH_DAY_MS = 24 * 60 * 60 * 1000;
export const IROH_STATS_KEY = 'lody:iroh-daily:v1';
const LIMIT = 1_000_000;
const kinds = ['dispatch', 'feature'] as const;
export const IROH_METRICS = [
  'iroh_ok',
  'fallback_not_ready',
  'fallback_not_ready_known',
  'fallback_not_ready_never',
  'fallback_call_failed',
  'fallback_unverified',
  'unavailable',
  'chunked',
  'lt200',
  'lt800',
  'ge800',
  'direct',
  'relay',
  'unknown',
] as const;
export type IrohOutcome =
  | 'iroh_ok'
  | 'fallback_not_ready'
  | 'fallback_call_failed'
  | 'fallback_unverified'
  | 'unavailable'
  | 'chunked';
export type IrohObservation = {
  kind: (typeof kinds)[number];
  outcome: IrohOutcome;
  target: string;
  connected?: boolean;
  elapsedMs?: number;
  path?: 'direct' | 'relay' | 'unknown' | Promise<'direct' | 'relay' | 'unknown'>;
};
type State = {
  start: number;
  lastReportedAt: number;
  salt: string;
  known: string[];
  pending?: {
    id: string;
    start: number;
    end: number;
    version: string;
    counts: Record<string, number>;
  };
  counts: Record<string, number>;
};
export function createIrohDaily(options: {
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  digest: (text: string) => Promise<string>;
  random: () => string;
  online: () => boolean;
  enqueue: (properties: Record<string, unknown>, eventId: string) => boolean;
  enabled?: () => boolean;
  platform: 'desktop' | 'ios' | 'android';
  version: () => string;
}) {
  const read = (): State => {
    const raw = options.storage.getItem(IROH_STATS_KEY);
    if (raw) {
      const value = JSON.parse(raw) as State;
      if (
        !Number.isFinite(value.start) ||
        !Number.isFinite(value.lastReportedAt) ||
        typeof value.salt !== 'string' ||
        !Array.isArray(value.known) ||
        !value.known.every((key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))
      )
        throw new Error('iroh_stats_invalid');
      return value;
    }
    const now = options.now();
    return { start: now, lastReportedAt: now, salt: options.random(), known: [], counts: {} };
  };
  const countsOf = (state: State) =>
    Object.fromEntries(
      kinds.flatMap((kind) =>
        IROH_METRICS.map((metric) => {
          const key = `${kind}_${metric}`;
          const value = state.counts?.[key];
          return [key, Number.isSafeInteger(value) && value! >= 0 ? Math.min(LIMIT, value!) : 0];
        })
      )
    );
  return {
    record: (observation: IrohObservation) =>
      options.exclusive(async () => {
        if (options.enabled?.() === false) return;
        const state = read();
        const counts = (state.counts = countsOf(state));
        const increment = (metric: (typeof IROH_METRICS)[number]) => {
          const key = `${observation.kind}_${metric}`;
          counts[key] = Math.min(LIMIT, counts[key]! + 1);
        };
        increment(observation.outcome);
        if (
          observation.connected ||
          observation.outcome === 'iroh_ok' ||
          observation.outcome === 'fallback_not_ready'
        ) {
          const target = await options.digest(`${state.salt}:${observation.target}`);
          if (
            (observation.connected || observation.outcome === 'iroh_ok') &&
            !state.known.includes(target)
          )
            state.known.push(target);
          if (observation.outcome === 'iroh_ok') {
            increment(
              observation.elapsedMs! < 200
                ? 'lt200'
                : observation.elapsedMs! < 800
                  ? 'lt800'
                  : 'ge800'
            );
            increment((await observation.path) ?? 'unknown');
          } else if (observation.outcome === 'fallback_not_ready')
            increment(
              state.known.includes(target) ? 'fallback_not_ready_known' : 'fallback_not_ready_never'
            );
        }
        options.storage.setItem(IROH_STATS_KEY, JSON.stringify(state));
      }),
    check: () =>
      options.exclusive(async () => {
        if (options.enabled?.() === false || !options.online()) return;
        const state = read();
        const now = options.now();
        if (now - state.lastReportedAt < IROH_DAY_MS) return;
        if (!state.pending) {
          const counts = countsOf(state);
          if (!Object.values(counts).some(Boolean)) return;
          state.pending = {
            id: options.random(),
            start: state.start,
            end: now,
            version: options.version(),
            counts,
          };
          state.counts = {};
          state.start = now;
          // Freeze the original before SDK enqueue. New observations belong to the
          // active window, including after a crash before the receipt is committed.
          options.storage.setItem(IROH_STATS_KEY, JSON.stringify(state));
        }
        const pending = state.pending;
        if (
          options.enabled?.() === false ||
          !options.enqueue(
            {
              ...countsOf({ ...state, counts: pending.counts }),
              platform: options.platform,
              app_version: pending.version,
              window_start: pending.start,
              window_end: pending.end,
            },
            pending.id
          )
        )
          return;
        delete state.pending;
        state.lastReportedAt = now;
        options.storage.setItem(IROH_STATS_KEY, JSON.stringify(state));
      }),
  };
}

let recorder: ((observation: IrohObservation) => Promise<void>) | undefined;
export function installIrohDailyRecorder(next: typeof recorder) {
  recorder = next;
  return () => {
    if (recorder === next) recorder = undefined;
  };
}
export function hasIrohDailyRecorder() {
  return recorder !== undefined;
}
export function recordIrohObservation(observation: IrohObservation) {
  void recorder?.(observation).catch(() => undefined);
}

/** Runs after SDK super-properties are merged: no workspace groups or URL/IP metadata. */
export function sanitizeIrohDailyProperties(properties: Record<string, unknown>) {
  const safe: Record<string, unknown> = {
    $geoip_disable: true,
    $ip: null,
    $process_person_profile: false,
  };
  for (const field of ['token', 'distinct_id', '$lib', '$lib_version', 'app_version']) {
    const value = properties[field];
    if (typeof value === 'string') safe[field] = value.slice(0, 500);
  }
  if (['desktop', 'ios', 'android'].includes(String(properties.platform)))
    safe.platform = properties.platform;
  for (const field of ['window_start', 'window_end']) {
    const value = properties[field];
    if (typeof value === 'number' && Number.isFinite(value)) safe[field] = value;
  }
  for (const kind of kinds)
    for (const metric of IROH_METRICS) {
      const field = `${kind}_${metric}`;
      const value = properties[field];
      safe[field] =
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          ? Math.min(value, LIMIT)
          : 0;
    }
  return safe;
}
