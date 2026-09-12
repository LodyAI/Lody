import type { LoroDoc, LoroEventBatch } from 'loro-crdt';
import { Mirror, schema, type ContainerSchemaType } from 'loro-mirror';
import { sessionDocSchema } from './schema';
import type { SessionWriteState } from './session-mirror';

// # Session control-plane Mirror
//
// A session doc's `history` grows without bound, so a control-plane Mirror keeps
// session, queue, preview, fork, cursor and runtime-config state and never
// materializes `history`. Shared so both the renderer and the CLI construct the
// same control plane; the history itself is read through `@lody/shared/session-data`.

/**
 * A `LoroDoc` facade for the control-plane Mirror.
 *
 * Two things are intercepted, everything else is forwarded to the real doc:
 *
 * - `subscribe`: events under an ignored root are dropped before the Mirror's
 *   listener runs. loro-mirror's incremental event path applies every root it
 *   receives — including roots its schema marks `Ignore` — so without this a
 *   streaming turn would be materialized into the in-memory `history` slot
 *   turn by turn, which is the cost this module exists to avoid.
 * - `getShallowValue`: loro-mirror enumerates doc roots once at construction
 *   (`ignoreUnknownProperties` mirrors roots its schema does not declare).
 *   Enumerating roots makes Loro walk every container of a lazily loaded
 *   snapshot (~35 ms for a 2,000-turn session), so the facade answers with
 *   nothing. Unknown roots still reach the Mirror through the incremental
 *   event path the moment they change, and the Mirror never deletes a root it
 *   does not hold, so nothing a newer peer wrote is at risk.
 */
export function createControlPlaneDoc(
  doc: LoroDoc,
  options: { ignoredRootKeys: readonly string[] }
): LoroDoc {
  const ignored = new Set(options.ignoredRootKeys);
  const subscribe = (listener: (batch: LoroEventBatch) => void) =>
    doc.subscribe((batch) => {
      const events = batch.events.filter((event) => !ignored.has(String(event.path[0])));
      if (events.length === 0) return;
      listener(events.length === batch.events.length ? batch : { ...batch, events });
    });
  const getShallowValue = () => ({});
  return new Proxy(doc, {
    get(target, property, receiver) {
      if (property === 'subscribe') return subscribe;
      if (property === 'getShallowValue') return getShallowValue;
      const value = Reflect.get(target, property, receiver === undefined ? target : target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The session doc schema with `history` declared but never materialized.
 * `buildRootStateSnapshot` skips `Ignore` fields and, because the key IS
 * declared, the `ignoreUnknownProperties` root pass skips it too; the event
 * path is fenced by `createControlPlaneDoc`. History is read through
 * `SessionData.history` and written through the shared `HistoryWriter` instead.
 */
export const sessionControlPlaneSchema = schema({
  ...sessionDocSchema.definition,
  // Root definitions are typed as containers; loro-mirror handles `Ignore`
  // at the root at runtime (see `buildRootStateSnapshot`).
  history: schema.Ignore() as unknown as ContainerSchemaType,
});

/**
 * The roots the schema marks `Ignore`, read back from the schema so the doc
 * facade cannot drift from it. loro-mirror honours `Ignore` when it builds a
 * state snapshot but not on its incremental event path, which is what
 * `createControlPlaneDoc` fences.
 */
export const CONTROL_PLANE_IGNORED_ROOT_KEYS = Object.entries(sessionControlPlaneSchema.definition)
  .filter(([, field]) => (field as { type?: string }).type === 'ignore')
  .map(([key]) => key);

/** Control-plane state: every session field except the unbounded history list. */
export type SessionControlPlaneState = Omit<SessionWriteState, 'history'>;

export type SessionControlPlaneUpdater =
  | Partial<SessionControlPlaneState>
  | ((draft: SessionControlPlaneState) => SessionControlPlaneState | void);

/**
 * The control-plane Mirror used by the CLI and the renderer. It never carries a
 * `history` array: history is read through `@lody/shared/session-data` and
 * written through the shared `HistoryWriter`.
 */
export function createSessionControlPlaneMirror(options: {
  doc: LoroDoc;
  initialState: SessionControlPlaneState;
}) {
  const mirror = new Mirror({
    doc: createControlPlaneDoc(options.doc, { ignoredRootKeys: CONTROL_PLANE_IGNORED_ROOT_KEYS }),
    schema: sessionControlPlaneSchema,
    ignoreUnknownProperties: true,
    validateUpdates: false,
    initialState: options.initialState as never,
  });
  return {
    getState: () => mirror.getState() as SessionControlPlaneState,
    subscribe: (listener: (state: SessionControlPlaneState) => void) =>
      mirror.subscribe(() => listener(mirror.getState() as SessionControlPlaneState)),
    setState(updater: SessionControlPlaneUpdater): void {
      const previous = mirror.getState() as SessionControlPlaneState;
      const next =
        typeof updater === 'function'
          ? (() => {
              const draft = structuredClone(previous) as SessionControlPlaneState;
              return updater(draft) ?? draft;
            })()
          : { ...previous, ...updater };
      mirror.setState(next as never);
    },
    dispose: () => mirror.dispose(),
  };
}

export type SessionControlPlaneMirror = ReturnType<typeof createSessionControlPlaneMirror>;
