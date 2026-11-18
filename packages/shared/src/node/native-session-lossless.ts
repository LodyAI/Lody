import { RepoRpcError, type RepoClient } from '@loro-dev/loro-repo-client';
import { HistoryWriteError } from '../history-write-schema';
import { historyValuesEqual } from '../history-values-equal';
import { projectStoredSessionTurnForDisplay } from '../session-data/loro-reader';
import { selectTurnOutput } from '../session-data/read';
import type { SessionEntry, SessionTurn, SessionTurnRead } from '../session-data/domain';
import type { SessionSubagentRun } from '../session-data/types';
import type { NativeSessionQueryPort, NativeSessionReadView } from './native-session-reader';
import {
  supportsNativeSessionI64,
  type NativeSessionSdkCompatibility,
} from './native-session-compatibility';
type Path = readonly (string | number)[];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
export function hasUnsafeNativeProjectionNumber(value: unknown): boolean {
  if (typeof value === 'number')
    return !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value));
  if (value instanceof Uint8Array || value === null || typeof value !== 'object') return false;
  return Object.values(value).some(hasUnsafeNativeProjectionNumber);
}
class ExactValueNeeded {
  constructor(readonly path: Path) {}
}
/** Rebase an already validated field plan onto its exact i64 source. Equality
 * keeps unchanged opaque subtrees verbatim. No field acceptance rule lives here. */
function preserveExactLiteral(before: unknown, next: unknown, exact: unknown): unknown {
  if (historyValuesEqual(before, next)) return exact;
  if (record(before) && record(next) && record(exact))
    return Object.fromEntries(
      Object.entries(next).map(([key, value]) => [
        key,
        Object.hasOwn(before, key) ? preserveExactLiteral(before[key], value, exact[key]) : value,
      ])
    );
  if (Array.isArray(before) && Array.isArray(next) && Array.isArray(exact)) {
    // A lossy WASM projection cannot distinguish distinct i64 aliases. Refuse a
    // removal/reordering that cannot identify which opaque member was retained.
    const key = (value: unknown): string => {
      if (Array.isArray(value)) return '[' + value.map(key).join(',') + ']';
      if (value !== null && typeof value === 'object')
        return (
          '{' +
          Object.keys(value)
            .filter((k) => k !== '$cid' && (value as Record<string, unknown>)[k] !== undefined)
            .sort()
            .map((k) => JSON.stringify(k) + ':' + key((value as Record<string, unknown>)[k]))
            .join(',') +
          '}'
        );
      return JSON.stringify([typeof value, typeof value === 'bigint' ? String(value) : value]);
    };
    const groups = new Map<
      string,
      { count: number; next: number; exact: unknown; aliased: boolean }
    >();
    before.forEach((value, index) => {
      const fingerprint = key(value),
        group = groups.get(fingerprint);
      if (group) {
        group.count++;
        group.aliased ||= !historyValuesEqual(group.exact, exact[index]);
      } else groups.set(fingerprint, { count: 1, next: 0, exact: exact[index], aliased: false });
    });
    for (const value of next) {
      const group = groups.get(key(value));
      if (group) group.next++;
    }
    for (const group of groups.values())
      if (group.aliased && group.next > 0 && group.next !== group.count)
        throw new HistoryWriteError([{ path: [], code: 'ambiguous_lossless_literal' }]);
    let oldStart = 0,
      newStart = 0,
      last = -1;
    const result: unknown[] = [];
    const anchors = next.map((value) => {
      for (let at = last + 1; at < before.length; at++)
        if (historyValuesEqual(before[at], value)) {
          last = at;
          return at;
        }
      return -1;
    });
    const block = (oldEnd: number, newEnd: number) => {
      const overlap = Math.min(oldEnd - oldStart, newEnd - newStart);
      for (let offset = 0; offset < overlap; offset++)
        result.push(
          preserveExactLiteral(
            before[oldStart + offset],
            next[newStart + offset],
            exact[oldStart + offset]
          )
        );
      for (let index = newStart + overlap; index < newEnd; index++) result.push(next[index]);
    };
    for (let index = 0; index < next.length; index++)
      if (anchors[index]! >= oldStart) {
        block(anchors[index]!, index);
        result.push(exact[anchors[index]!]);
        oldStart = anchors[index]! + 1;
        newStart = index + 1;
      }
    block(before.length, next.length);
    return result;
  }
  return next;
}
/** WASM remains the synchronous index/causal projection. Only a requested body
 * or atomic field containing a potentially rounded integer needs a bounded SDK
 * read. Every such read must share its exact room head with the pure plan. */
export function createNativeSessionLosslessQueries(options: {
  readonly reader: () => NativeSessionQueryPort;
  readonly client: Partial<Pick<RepoClient, 'transactCas' | 'readDoc'>>;
  readonly namespace: string;
  readonly sessionId: string;
  readonly compatibility?: NativeSessionSdkCompatibility;
  assertCurrent?(): void;
}) {
  const room = { kind: 'loro_doc' as const, id: `session-${options.sessionId}` };
  const transaction = <A>(operation: () => Promise<A>) =>
    options.client.transactCas ? options.client.transactCas(operation) : operation();
  return async <A>(operation: (view: NativeSessionReadView) => A) =>
    transaction(async () => {
      const exactSources = new Map<string, { path: Path; value: unknown }>();
      let head: number | undefined;
      const exactAt = (path: Path): { found: boolean; value: unknown } => {
        for (const source of exactSources.values())
          if (
            source.path.length <= path.length &&
            source.path.every((part, index) => part === path[index])
          ) {
            let value = source.value;
            for (const segment of path.slice(source.path.length))
              value =
                value !== null && typeof value === 'object'
                  ? (value as Record<string | number, unknown>)[segment]
                  : undefined;
            return { found: true, value };
          }
        return { found: false, value: undefined };
      };
      for (;;) {
        options.assertCurrent?.();
        const prepared = options.reader().query((base) => {
          const exactValue = (path: Path, fallback: () => unknown) => {
            const resolved = exactAt(path);
            if (resolved.found) {
              const value = resolved.value;
              if (path[0] === 'mq' && Array.isArray(value) && path.length === 1)
                return value.map((row, index) =>
                  record(row) && base.kindAt(['mq', index]) === 'map'
                    ? { ...row, $cid: base.valueAt(['mq', index, '$cid']) }
                    : row
                );
              return value;
            }
            const value = fallback();
            if (hasUnsafeNativeProjectionNumber(value)) throw new ExactValueNeeded(path);
            return value;
          };
          const readAt = (position: number): SessionTurnRead => {
            if (position < 0 || position >= base.history.count()) return { state: 'missing' };
            const original = base.history.readAt(position);
            if (original.state !== 'ready') return original;
            const value = exactValue(['history', position], () => original.turn);
            return record(value)
              ? { state: 'ready', turn: value as SessionTurn }
              : { state: 'invalid' };
          };
          const history = {
            ...base.history,
            readAt,
            readTurn: (id: string): SessionTurnRead => {
              const position = base.positionOfTurn(id);
              return position === undefined ? { state: 'missing' } : readAt(position);
            },
            readTurnForDisplay: (id: string): SessionTurnRead => {
              const position = base.positionOfTurn(id);
              if (position === undefined) return { state: 'missing' };
              const original = base.history.readTurnForDisplay(id);
              if (original.state !== 'ready' || !hasUnsafeNativeProjectionNumber(original.turn))
                return original;
              const value = exactValue(['history', position], () => original.turn);
              const turn = projectStoredSessionTurnForDisplay(value);
              return turn ? { state: 'ready', turn } : { state: 'invalid' };
            },
            readRange: (from: number, to: number) =>
              Array.from(
                { length: Math.max(0, Math.min(to, base.history.count()) - Math.max(0, from)) },
                (_, index) => readAt(Math.max(0, from) + index)
              ),
            readAll: () => exactValue(['history'], () => base.history.readAll()) as SessionEntry[],
            readTurnOutput: (id: string) =>
              selectTurnOutput(
                base.history.count(),
                id,
                (index) => base.history.readDirectory(index, index + 1)[0]?.scalars,
                (index) => {
                  const row = readAt(index);
                  return row.state === 'ready' ? (row.turn as SessionEntry) : undefined;
                }
              ),
            readSubagentRun: (
              id: string,
              sessionId: string,
              runId: string
            ): SessionSubagentRun | undefined => {
              const original = base.history.readSubagentRun(id, sessionId, runId);
              if (!hasUnsafeNativeProjectionNumber(original)) return original;
              const position = base.positionOfTurn(id);
              if (position === undefined) return undefined;
              const path = ['history', position, 'items'] as const;
              for (let index = 0; index < base.lengthAt(path); index++)
                if (
                  base.valueAt([...path, index, 'type']) === 'subagent_task' &&
                  base.valueAt([...path, index, 'taskId']) === runId &&
                  base.valueAt([...path, index, 'run', 'sessionId']) === sessionId
                )
                  return exactValue([...path, index, 'run'], () => original) as SessionSubagentRun;
              return undefined;
            },
          };
          const view: NativeSessionReadView = {
            ...base,
            history,
            valueAt: (path) => exactValue(path, () => base.valueAt(path)),
            planAgentUpdate(...args) {
              const planned = base.planAgentUpdate(...args);
              return {
                ...planned,
                patches: planned.patches.map((patch) => {
                  if (!hasUnsafeNativeProjectionNumber(patch.before)) return patch;
                  const raw = exactAt(patch.path);
                  if (!raw.found) throw new ExactValueNeeded(patch.path);
                  const exact =
                    Array.isArray(raw.value) && patch.rangeStart !== undefined
                      ? raw.value.slice(
                          patch.rangeStart,
                          patch.rangeStart + (Array.isArray(patch.before) ? patch.before.length : 0)
                        )
                      : raw.value;
                  return {
                    ...patch,
                    before: exact,
                    next: preserveExactLiteral(patch.before, patch.next, exact),
                  };
                }),
              };
            },
          };
          try {
            return { ready: true as const, value: operation(view) };
          } catch (error) {
            if (error instanceof ExactValueNeeded)
              return { ready: false as const, path: error.path };
            throw error;
          }
        });
        if (head !== undefined && prepared.checkpoint.roomTxId !== head)
          throw new RepoRpcError('precondition_failed');
        head = prepared.checkpoint.roomTxId;
        if (prepared.value.ready) return { ...prepared, value: prepared.value.value };
        if (!supportsNativeSessionI64(options.compatibility) || !options.client.readDoc)
          throw new HistoryWriteError([
            { path: prepared.value.path, code: 'unsupported_unsafe_integer' },
          ]);
        const current = await options.client.readDoc(options.namespace, room, prepared.value.path);
        options.assertCurrent?.();
        if (current.roomTxId !== head) throw new RepoRpcError('precondition_failed');
        exactSources.set(JSON.stringify(prepared.value.path), {
          path: prepared.value.path,
          value: current.value,
        });
      }
    });
}
