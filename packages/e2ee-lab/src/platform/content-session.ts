import { LoroDoc } from 'loro-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import type { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { makeLabDocumentSession } from './document-session';
export {
  LabContentError,
  LabLocalEditReplay,
  type LabLocalEditReplayHooks,
} from './document-session';
/** Real Loro native owner on the common protected document lifecycle. */
export function makeLabLoroSession(
  input: Omit<Parameters<typeof makeStreamsUpdateBinding>[0], 'model'> & {
    readonly binding?: import('effect').Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>;
    readonly path: string;
    readonly mode: 'create' | 'open';
    readonly streamUrl: string;
    readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
    readonly snapshotUpload?: boolean;
  }
) {
  return makeLabDocumentSession({ ...input, model: 'loro' }, () => {
    const doc = new LoroDoc();
    type Adapter = ReturnType<typeof createLoroDocAdapter>;
    const replayListeners = new Set<Parameters<Adapter['subscribeLocalUpdates']>[0]>();
    return {
      adapter: () => {
        const adapter = createLoroDocAdapter(doc);
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
      exportSnapshot: () => doc.export({ mode: 'snapshot' }),
      importSnapshot: (bytes) => {
        doc.import(bytes);
      },
      importUpdate: (bytes) => {
        const adapter = createLoroDocAdapter(doc),
          before = adapter.exportUpdates(adapter.emptyVersion())?.version ?? adapter.emptyVersion();
        const result = doc.import(bytes);
        if (result.pending?.size) throw new Error('pending-local-edit-input');
        const actual = adapter.exportUpdates(before);
        if (actual)
          for (const listener of replayListeners)
            listener({ ...actual, updates: [new Uint8Array(bytes)] });
      },
      append: (text, captureDelta) => {
        const before = captureDelta ? doc.version() : undefined;
        try {
          const value = doc.getText('text');
          value.insert(value.length, text);
          doc.commit();
          return before ? doc.export({ mode: 'update', from: before }) : undefined;
        } finally {
          before?.free();
        }
      },
      text: () => doc.getText('text').toString(),
      release: () => doc.free(),
    };
  });
}
