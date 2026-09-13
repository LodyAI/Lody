import type { SessionHistory } from '@lody/shared';
import type { StaticShare } from '@lody/shared/session-sharing';

export type SessionShareReaderSnapshot = {
  status: 'loading' | 'ready' | 'unavailable';
  history: readonly SessionHistory[];
};

/** One immutable conversation read. No subscription, source runtime or durable cache. */
export function createSessionShareReader(options: {
  share: StaticShare;
  conversationId: string;
  onChange: (snapshot: SessionShareReaderSnapshot) => void;
}) {
  const lifetime = new AbortController();
  let started = false;
  let closed = false;
  return {
    async start() {
      if (started || closed) return;
      started = true;
      options.onChange({ status: 'loading', history: [] });
      try {
        const history = await options.share.readHistory(options.conversationId, lifetime.signal);
        if (closed) return;
        // Storage validation preserves opaque future fields. The existing renderer
        // owns known message guards; its anonymous error boundary is content-free.
        options.onChange({ status: 'ready', history: history as unknown as SessionHistory[] });
      } catch {
        if (!closed) options.onChange({ status: 'unavailable', history: [] });
      }
    },
    close() {
      closed = true;
      lifetime.abort();
    },
  };
}
