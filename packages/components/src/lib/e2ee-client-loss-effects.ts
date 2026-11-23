import { E2EE_CLIENT_LOSS_PROBE } from '@lody/shared/electron-ipc';

/**
 * E2E-only transport evidence for the desktop client-loss probe. Counters come from
 * the live protected transport boundaries (the SDK's seal/open of each frame,
 * successful appends of encrypted dispatch frames, transport attach/remove and
 * runtime close). Reports carry
 * counts and booleans only; this never reads or forwards content, tokens or errors.
 */
type Effects = {
  contentWrites: number;
  contentReadEvents: number;
  turnStarts: number;
  activeContentStreams: number;
  pendingWrites: number;
  pendingDispatches: number;
  transportOwnerClosed: boolean;
};
type State = Omit<Effects, 'transportOwnerClosed'> & { liveOwners: number };

// One cumulative row per workspace for this renderer, across runtime instances.
const states = new Map<string, State>();

export function clientLossEffects(workspaceId: string) {
  if (typeof window === 'undefined' || window.__LODY_E2E_CLIENT_LOSS__ !== true) return null;
  const send = window.ipc?.send;
  if (!send) return null;
  let state = states.get(workspaceId);
  if (!state) {
    state = {
      contentWrites: 0,
      contentReadEvents: 0,
      turnStarts: 0,
      activeContentStreams: 0,
      pendingWrites: 0,
      pendingDispatches: 0,
      liveOwners: 0,
    };
    states.set(workspaceId, state);
  }
  const current = state;
  const report = () => {
    const { liveOwners, ...counters } = current;
    const effects: Effects = {
      ...counters,
      transportOwnerClosed:
        liveOwners === 0 &&
        current.activeContentStreams === 0 &&
        current.pendingWrites === 0 &&
        current.pendingDispatches === 0,
    };
    try {
      send(E2EE_CLIENT_LOSS_PROBE.effects, { workspaceId, effects });
    } catch {
      // Observational only: a failed report never affects the operation.
    }
  };
  return {
    async track<A>(kind: 'write' | 'read' | 'dispatch', work: () => Promise<A>): Promise<A> {
      const pending =
        kind === 'write' ? 'pendingWrites' : kind === 'dispatch' ? 'pendingDispatches' : null;
      if (pending) {
        current[pending] += 1;
        report();
      }
      let completed = false;
      try {
        const value = await work();
        completed = true;
        return value;
      } finally {
        if (pending) current[pending] -= 1;
        // A settled dispatch send is not a turn; `turnDispatched` counts the append.
        if (completed && kind === 'write') current.contentWrites += 1;
        else if (completed && kind === 'read') current.contentReadEvents += 1;
        if (pending || (completed && kind !== 'dispatch')) report();
      }
    },
    /** One encrypted dispatch request whose frame the stream client appended. */
    turnDispatched() {
      current.turnStarts += 1;
      report();
    },
    ownerOpened() {
      current.liveOwners += 1;
      report();
    },
    /** Only a fully successful close releases the owner; a failed one stays live. */
    ownerClosed(ok: boolean) {
      if (ok) current.liveOwners = Math.max(0, current.liveOwners - 1);
      report();
    },
    streamAttached() {
      current.activeContentStreams += 1;
      report();
    },
    /** A removal that rejected keeps its stream counted as active. */
    streamRemoved(ok: boolean) {
      if (ok) current.activeContentStreams = Math.max(0, current.activeContentStreams - 1);
      report();
    },
  };
}
export type ClientLossEffects = NonNullable<ReturnType<typeof clientLossEffects>>;
