import type { ChildProcess } from 'node:child_process';

// All workspace runtimes in this daemon use the same Sorbet data directory.
// An unconfirmed child remains fenced until a later caller confirms its termination.
let busy = false;
let survivor: { child: ChildProcess; terminate: () => Promise<void> } | undefined;
let recovery: Promise<void> | undefined;

export async function acquireSorbetCredentialMutation(signal?: AbortSignal): Promise<{
  release: () => void;
  retain: (child: ChildProcess, terminate: () => Promise<void>) => void;
}> {
  signal?.throwIfAborted();
  if (busy) throw new Error('Sorbet credentials are busy');
  busy = true;
  try {
    if (survivor) {
      const retained = survivor;
      recovery ??= retained
        .terminate()
        .then(() => {
          if (survivor === retained) survivor = undefined;
        })
        .finally(() => {
          recovery = undefined;
        });
      await recovery;
      signal?.throwIfAborted();
    }
  } catch {
    busy = false;
    throw new Error('Sorbet credentials cleanup is unconfirmed');
  }
  let held = true;
  return {
    release() {
      if (held) {
        held = false;
        busy = false;
      }
    },
    retain(child, terminate) {
      survivor = { child, terminate };
    },
  };
}
