import { Immer, type Draft } from 'immer';
import { Mirror } from 'loro-mirror';
import type { LoroDoc } from 'loro-crdt';
import {
  sessionDocSchema,
  type SessionDocMeta,
  type SessionHistory,
  type SessionPreviewDocState,
  type SessionExternalHistoryCursorDocState,
  type SessionAcpRuntimeConfigSnapshot,
} from './schema';
import { createHistoryWriter, historyValuesEqual, type HistoryWriter } from './history-writer';
import { HistoryEntryWriteSchema, parseHistoryWrite } from './history-write-schema';
import type { SessionForkOperation } from './message-schemas';

const immer = new Immer({ autoFreeze: false, useStrictShallowCopy: true });
export type SessionWriteState = Omit<
  SessionDocMeta,
  'forkOperation' | 'preview' | 'externalHistoryCursor' | 'acpRuntimeConfig'
> & {
  forkOperation?: SessionForkOperation;
  preview?: SessionPreviewDocState;
  externalHistoryCursor?: SessionExternalHistoryCursorDocState;
  acpRuntimeConfig?: SessionAcpRuntimeConfigSnapshot;
};
export type SessionWriteUpdater =
  | Partial<SessionWriteState>
  | ((draft: Draft<SessionWriteState>) => SessionWriteState | void);

/**
 * Compatibility facade while full-Mirror readers remain. Mirror observes history
 * but cannot author it: every callback's history delta goes to the same writer.
 * #376 can replace the read side without adding a second history write path.
 */
export function createSessionMirror(options: {
  doc: LoroDoc;
  initialState: Partial<SessionWriteState>;
}) {
  const initialHistory =
    options.doc.getList('history').length === 0 ? (options.initialState.history ?? []) : [];
  // Fail before seeding any CRDT state if initial new history is malformed.
  initialHistory.forEach((entry) => parseHistoryWrite(HistoryEntryWriteSchema, entry));
  const mirror = new Mirror({
    doc: options.doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    validateUpdates: false,
    initialState: { ...options.initialState, history: [] } as never,
  });
  const writer = createHistoryWriter(
    options.doc,
    () => mirror.getState().history as SessionHistory[]
  );
  if (initialHistory.length > 0) writer.update(() => initialHistory);
  return {
    historyWriter: writer as HistoryWriter,
    getState: () => mirror.getState(),
    subscribe: mirror.subscribe.bind(mirror),
    dispose: () => mirror.dispose(),
    setState(updater: SessionWriteUpdater): void {
      const previous = mirror.getState() as SessionWriteState;
      const next =
        typeof updater === 'function'
          ? immer.produce(previous, (draft) => {
              const result = updater(draft);
              if (result && result !== draft) return result;
              return undefined;
            })
          : { ...previous, ...updater };
      const writeHistory = historyValuesEqual(previous.history, next.history)
        ? undefined
        : writer.prepare(previous.history, next.history);
      // Preflight history before control fields; Mirror only writes the control delta.
      const controlChanged = [...new Set([...Object.keys(previous), ...Object.keys(next)])].some(
        (key) =>
          key !== 'history' &&
          !historyValuesEqual(
            previous[key as keyof SessionWriteState],
            next[key as keyof SessionWriteState]
          )
      );
      if (controlChanged) mirror.setState({ ...next, history: previous.history } as never);
      writeHistory?.();
    },
  };
}

export type SessionMirror = ReturnType<typeof createSessionMirror>;
