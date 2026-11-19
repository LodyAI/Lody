import type { RepoTransportRoomSubscription } from 'loro-repo';

export type ConversationSyncPhase =
  | 'connecting'
  | 'syncing'
  | 'retrying'
  | 'disconnected'
  | 'confirmed';
export type ConversationSyncRoute = 'local' | 'cloud';
export type ConversationSyncReason =
  | 'timeout'
  | 'connectTimeout'
  | 'network'
  | 'authorization'
  | 'owner'
  | 'read';
export type ConversationSyncStep = {
  phase: ConversationSyncPhase;
  route?: ConversationSyncRoute;
  reason?: ConversationSyncReason;
};
export type ConversationSyncSnapshot = {
  phase: ConversationSyncPhase;
  since: number;
  document: ConversationSyncStep;
  history?: ConversationSyncStep;
};

export function createConversationSync(hasSeparateHistory: boolean, now = Date.now) {
  let snapshot: ConversationSyncSnapshot = {
    phase: 'connecting',
    since: now(),
    document: { phase: 'connecting' },
    ...(hasSeparateHistory ? { history: { phase: 'connecting' } } : {}),
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(key: 'document' | 'history', step: ConversationSyncStep) {
      const previous = snapshot[key];
      if (!previous) return;
      const route = step.route ?? previous.route;
      if (
        previous.phase === step.phase &&
        previous.reason === step.reason &&
        previous.route === route
      )
        return;
      const next = { ...snapshot, [key]: { ...step, route } };
      const states = [next.document.phase, next.history?.phase];
      const phase =
        (['disconnected', 'retrying', 'connecting', 'syncing'] as const).find((phase) =>
          states.includes(phase)
        ) ?? 'confirmed';
      snapshot = {
        ...next,
        phase,
        since:
          (phase === 'confirmed') !== (snapshot.phase === 'confirmed') ? now() : snapshot.since,
      };
      for (const listener of listeners) listener();
    },
  };
}

export type ConversationSync = ReturnType<typeof createConversationSync>;

/** Observe one already-routed binding, including its current receive confirmation. */
export function observeConversationDocument(
  binding: Pick<
    RepoTransportRoomSubscription,
    'transportId' | 'status' | 'onStatusChange' | 'waitFor'
  >,
  publish: (step: ConversationSyncStep) => void,
  observeReceive?: (listener: (confirmed: boolean) => void) => (() => void) | undefined
): () => void {
  let status: RepoTransportRoomSubscription['status'] | undefined;
  let read: AbortController | undefined;
  let stopReceive: (() => void) | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const route =
    binding.transportId === 'local' || binding.transportId === 'cloud'
      ? binding.transportId
      : undefined;
  const update = (next: RepoTransportRoomSubscription['status']) => {
    if (next === status) return;
    status = next;
    read?.abort();
    read = undefined;
    stopReceive?.();
    stopReceive = undefined;
    clearTimeout(connectTimer);
    if (next !== 'joined') {
      if (next === 'error') publish({ route, phase: 'disconnected', reason: 'read' });
      else if (next === 'reconnecting') publish({ route, phase: 'retrying' });
      else publish({ route, phase: next === 'disconnected' ? 'disconnected' : 'connecting' });
      if (next === 'connecting' || next === 'reconnecting') {
        connectTimer = setTimeout(
          () =>
            publish({
              route,
              phase: next === 'reconnecting' ? 'retrying' : 'connecting',
              reason: 'connectTimeout',
            }),
          15_000
        );
      }
      return;
    }
    if (observeReceive) {
      let confirmed: boolean | undefined;
      const publishReceive = (next: boolean) => {
        if (next === confirmed) return;
        confirmed = next;
        clearTimeout(connectTimer);
        publish({ route, phase: next ? 'confirmed' : 'syncing' });
        if (!next) {
          connectTimer = setTimeout(
            () => publish({ route, phase: 'syncing', reason: 'timeout' }),
            15_000
          );
        }
      };
      stopReceive = observeReceive(publishReceive);
      if (stopReceive) return;
    }
    const attempt = new AbortController();
    read = attempt;
    publish({ route, phase: 'syncing' });
    void (async () => {
      // A timeout is observable. Keep using the same live subscription for its eventual receipt.
      try {
        const result = await binding.waitFor({
          phase: 'caught-up',
          signal: attempt.signal,
          timeoutMs: 15_000,
        });
        if (attempt.signal.aborted) return;
        if (result.status === 'timeout') {
          publish({ route, phase: 'syncing', reason: 'timeout' });
          const recovery = await binding.waitFor({ phase: 'caught-up', signal: attempt.signal });
          if (attempt.signal.aborted) return;
          if (recovery.status === 'complete') publish({ route, phase: 'confirmed' });
          else publish({ route, phase: 'disconnected', reason: 'read' });
        } else if (result.status === 'complete') {
          publish({ route, phase: 'confirmed' });
        } else {
          publish({ route, phase: 'disconnected', reason: 'read' });
        }
      } catch {
        if (!attempt.signal.aborted) publish({ route, phase: 'disconnected', reason: 'read' });
      }
    })();
  };
  const detach = binding.onStatusChange(update);
  update(binding.status);
  return () => {
    read?.abort();
    stopReceive?.();
    clearTimeout(connectTimer);
    detach();
  };
}
