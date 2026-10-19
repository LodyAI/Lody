import { Flock } from '@loro-dev/flock-wasm';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import type { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { makeLabDocumentSession } from './document-session';
/** Flock has no deterministic free/dispose; drop references only after actual SDK
 * settlement. Inject a logical clock; reopens must retain its monotonic semantics. */
export function makeLabFlockSession(
  input: Omit<Parameters<typeof makeStreamsUpdateBinding>[0], 'model'> & {
    readonly binding?: import('effect').Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>;
    readonly path: string;
    readonly mode: 'create' | 'open';
    readonly streamUrl: string;
    readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
    readonly snapshotUpload?: boolean;
    readonly replica: string;
    readonly now: () => number;
  }
) {
  const replica = input.replica,
    now = input.now;
  return makeLabDocumentSession({ ...input, model: 'flock' }, () => {
    let value: Flock | undefined = new Flock(replica);
    const current = () => {
      if (!value) throw new Error('flock-closed');
      return value;
    };
    type Adapter = ReturnType<typeof createFlockAdapter>;
    const replayListeners = new Set<Parameters<Adapter['subscribeLocalUpdates']>[0]>();
    return {
      adapter: () => {
        const adapter = createFlockAdapter(current());
        return {
          ...adapter,
          subscribeLocalUpdates: (listener: Parameters<Adapter['subscribeLocalUpdates']>[0]) => {
            replayListeners.add(listener);
            const unsubscribe = adapter.subscribeLocalUpdates(listener);
            return () => {
              replayListeners.delete(listener);
              unsubscribe();
            };
          },
        };
      },
      exportSnapshot: () => current().exportFile(),
      importSnapshot: (bytes) => {
        value = Flock.fromFile(bytes, replica);
      },
      importUpdate: (bytes) => {
        const adapter = createFlockAdapter(current()),
          before = adapter.exportUpdates(adapter.emptyVersion())?.version ?? adapter.emptyVersion();
        current().importJsonStr(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const actual = adapter.exportUpdates(before);
        if (actual)
          for (const listener of replayListeners)
            listener({ ...actual, updates: [new Uint8Array(bytes)] });
      },
      append: (text, captureDelta) => {
        const before = captureDelta ? current().version() : undefined;
        const old = current().get(['text']);
        if (old !== undefined && typeof old !== 'string') throw new Error('flock-state');
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0) throw new Error('flock-clock');
        current().put(['text'], (old ?? '') + text, time);
        return before
          ? new TextEncoder().encode(JSON.stringify(current().exportJson(before)))
          : undefined;
      },
      text: () => {
        const text = current().get(['text']);
        if (text === undefined) return '';
        if (typeof text !== 'string') throw new Error('flock-state');
        return text;
      },
      release: () => {
        value = undefined;
      },
    };
  });
}
