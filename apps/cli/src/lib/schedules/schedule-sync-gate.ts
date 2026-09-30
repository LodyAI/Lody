import type { StreamsRoomBinding } from '../loro/streams-room-binding';

/** A completed first sync does not authorize a later connection generation. */
export function createScheduleSyncGate(
  binding: StreamsRoomBinding,
  onReady: () => void,
  onError: () => void
) {
  let generation = 0;
  let stopped = false;
  let ready = false;
  const observe = () => {
    const current = ++generation;
    ready = false;
    if (binding.status !== 'joined' || stopped) return;
    void (async () => {
      await binding.firstSyncedWithRemote;
      await binding.waitUntilSynced();
      if (stopped || current !== generation || binding.status !== 'joined') return;
      ready = true;
      onReady();
    })().catch(onError);
  };
  const unsubscribe = binding.onStatusChange(observe);
  observe();
  return {
    isReady: () => ready,
    dispose: () => {
      stopped = true;
      ready = false;
      unsubscribe();
    },
  };
}
