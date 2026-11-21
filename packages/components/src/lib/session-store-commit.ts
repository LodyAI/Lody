import type { SessionDocStore, SessionDocUpdater } from '@/atoms/runtime';

/**
 * Applies a control-plane change and resolves once it is committed, with the
 * document's frontiers after it: at once for a local replica, after the engine
 * accepted the patch for a remote document.
 */
export async function commitSessionState(
  store: Pick<SessionDocStore, 'setState' | 'commitState' | 'doc'>,
  updater: SessionDocUpdater
): Promise<{ frontiers: unknown }> {
  if (store.commitState) return store.commitState(updater);
  store.setState(updater);
  return { frontiers: store.doc?.frontiers() };
}
