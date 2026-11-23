import type { MentionFileSearchEntry, PathSuggestion } from './engine';

export type FileSearchRequest =
  | { type: 'cancel' }
  | { type: 'index'; entry: MentionFileSearchEntry }
  | { type: 'query'; id: number; term: string };
export type FileSearchResponse =
  | { type: 'cancelled' }
  | { type: 'ready' }
  | { type: 'error' }
  | { type: 'result'; id: number; term: string; items: PathSuggestion[] };
export type FileSearchWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'
>;

/** One running query and one replaceable pending query; no keystroke backlog. */
export function createFileSearchClient(
  worker: FileSearchWorker,
  entry: MentionFileSearchEntry,
  onResult: (term: string, items: PathSuggestion[]) => void,
  onError: () => void
) {
  let disposed = false;
  let ready = false;
  let running = false;
  let revision = 0;
  let cancelRequested = false;
  let pending: Extract<FileSearchRequest, { type: 'query' }> | undefined;
  const dispose = () => {
    disposed = true;
    pending = undefined;
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
  };
  const fail = () => {
    if (disposed) return;
    dispose();
    onError();
  };
  const post = (message: FileSearchRequest) => {
    try {
      worker.postMessage(message);
    } catch {
      fail();
    }
  };
  const flush = () => {
    if (disposed || !ready || running || !pending) return;
    const request = pending;
    pending = undefined;
    running = true;
    post(request);
  };
  worker.onmessage = ({ data }: MessageEvent<FileSearchResponse>) => {
    if (disposed) return;
    if (data.type === 'error') {
      fail();
      return;
    }
    if (data.type === 'ready') ready = true;
    else {
      running = false;
      cancelRequested = false;
      if (data.type === 'result' && data.id === revision) onResult(data.term, data.items);
    }
    flush();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  post({ type: 'index', entry });
  return {
    query(term: string) {
      if (disposed) return;
      pending = { type: 'query', id: ++revision, term };
      if (running && !cancelRequested) {
        cancelRequested = true;
        post({ type: 'cancel' });
      }
      flush();
    },
    dispose,
  };
}
