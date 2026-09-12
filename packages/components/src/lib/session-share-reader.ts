import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { StreamsCrdt, createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { streamsSnapshotCodec, type SessionHistory } from '@lody/shared';
import { isSessionShareSecret } from '@lody/shared/session-sharing';
import { fetchSessionShare } from './session-share-fetch';

export type SessionShareReaderSnapshot = {
  status: 'loading' | 'live' | 'paused' | 'unavailable';
  history: readonly SessionHistory[];
};

/** An in-memory, single-doc reader. No Repo, Flock, workspace auth, or local writes. */
export function createSessionShareReader(options: {
  streamUrl: string;
  secret: string;
  onChange: (snapshot: SessionShareReaderSnapshot) => void;
  fetch?: typeof globalThis.fetch;
}) {
  if (!isSessionShareSecret(options.secret)) throw new Error('Invalid share credential');
  const streamUrl = new URL(options.streamUrl);
  if (
    !/^\/api\/shares\/[a-zA-Z0-9_-]+\/sessions\/[a-zA-Z0-9_-]+\/stream$/.test(streamUrl.pathname)
  ) {
    throw new Error('Invalid share stream');
  }
  const lifetime = new AbortController();
  const doc = new LoroDoc();
  // Read the original document incrementally. No schema defaults, initialState,
  // setState, or ephemeral store: this mirror never writes to the document.
  const mirror = new Mirror({ doc, ignoreUnknownProperties: true, debug: false });
  const adapter = createLoroDocAdapter(doc);
  let disposed = false;
  let publishQueued = false;
  let loaded = false;
  let snapshot: SessionShareReaderSnapshot = { status: 'loading', history: [] };
  const notify = () => {
    if (!disposed) options.onChange(snapshot);
  };
  const unavailable = () => {
    snapshot = { status: 'unavailable', history: [] };
    notify();
    lifetime.abort();
  };
  const publish = () => {
    publishQueued = false;
    if (disposed || snapshot.status === 'unavailable') return;
    const json = mirror.getState() as { history?: unknown };
    snapshot = {
      ...snapshot,
      history: Array.isArray(json.history) ? (json.history as SessionHistory[]) : [],
    };
    notify();
  };
  const unsubscribeDoc = mirror.subscribe(() => {
    if (publishQueued || disposed) return;
    publishQueued = true;
    queueMicrotask(publish);
  });
  const createTransport = () =>
    new StreamsCrdt({
      streamUrl: streamUrl.href,
      // Even accidental future mutations cannot produce an upload, snapshot, or
      // stream creation. The network gate independently rejects every write.
      adapter: { ...adapter, subscribeLocalUpdates: () => () => {}, exportUpdates: () => null },
      createStreamIfMissing: false,
      snapshotUpload: { enabled: false, canUpload: () => false },
      snapshotCodec: streamsSnapshotCodec,
      debug: false,
      fetch: async (input, init) => {
        const target = new URL(input);
        const suffix = target.pathname.slice(streamUrl.pathname.length);
        if (
          target.origin !== streamUrl.origin ||
          !target.pathname.startsWith(streamUrl.pathname) ||
          !/^(?:|\/bootstrap|\/snapshot(?:\/[a-zA-Z0-9_-]+)?)$/.test(suffix) ||
          !['GET', 'HEAD'].includes(init?.method ?? 'GET')
        ) {
          throw new Error('Read-only share transport');
        }
        if (disposed || lifetime.signal.aborted) throw new Error('Share reader closed');
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${options.secret}`);
        const response = await fetchSessionShare(
          input,
          {
            ...init,
            headers,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
          },
          lifetime.signal,
          options.fetch
        );
        if ([401, 403, 404].includes(response.status)) unavailable();
        return response;
      },
    });

  let transport = createTransport();
  let started = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  lifetime.signal.addEventListener(
    'abort',
    () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
    { once: true }
  );

  const join = async () => {
    const result = await transport.join({
      onStatusChange(status) {
        if (disposed || snapshot.status === 'unavailable') return;
        if (status === 'joined') loaded = true;
        snapshot = {
          ...snapshot,
          status: status === 'joined' ? 'live' : loaded ? 'paused' : 'loading',
        };
        publish();
      },
    });
    if (disposed || lifetime.signal.aborted) {
      await transport.close();
      return;
    }
    if (result.ok) {
      loaded = true;
      snapshot = { ...snapshot, status: 'live' };
      publish();
      return;
    }
    snapshot = { ...snapshot, status: 'paused' };
    notify();
    // StreamsCrdt retries live reads, but an initial join failure removes its
    // status listener and needs caller recovery. Replace only the closed
    // transport so every attempt subscribes anew; the original LoroDoc remains.
    await transport.close();
    if (disposed || lifetime.signal.aborted || !result.error.retryable) return;
    const delay = Math.min(1_000 * 2 ** Math.min(retryAttempt++, 5), 30_000);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (disposed || lifetime.signal.aborted) return;
      transport = createTransport();
      void join();
    }, delay);
  };

  return {
    async start() {
      if (started || disposed || lifetime.signal.aborted) return;
      started = true;
      await join();
    },
    /** Used when the authorized manifest removes the selected tab or whole share. */
    invalidate: unavailable,
    async close() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      unsubscribeDoc();
      await transport.close();
      mirror.dispose();
      doc.free();
    },
  };
}
