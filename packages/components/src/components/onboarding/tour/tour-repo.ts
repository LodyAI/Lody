import type { WorkspaceRuntime } from '@/atoms/runtime';

/**
 * The tour's read-only stand-in for `runtime.repo`.
 *
 * The tour mounts the REAL product components, and the real composer reads the
 * workspace catalog (Agent Roles, MCP servers) and each machine's Flock rows
 * through `repo.openFlockDoc`. Those hooks have no demo mode and should not
 * grow one: a tour-only copy of the composer would drift away from the product
 * it exists to show.
 *
 * So the tour supplies the repo-plane half of the boundary `TourCloudBoundary`
 * already draws for the cloud plane. Every document opens, reads empty, reports
 * its first sync as already done, and refuses writes. An empty catalog that is
 * authoritative renders exactly what the tour renders today, without the
 * `Failed to sync workspace catalog` error that a missing `repo` produced.
 */

type TourFlockRow = { readonly key: readonly unknown[]; readonly value?: unknown };
type TourFlockScanOptions = { readonly prefix?: readonly unknown[] };

const NO_ROWS: readonly TourFlockRow[] = Object.freeze([]);

/**
 * A silently accepted write would let a scripted surface believe it had
 * persisted something — the same reason `withSessionStore` rejects.
 */
const rejectTourWrite = (): never => {
  throw new Error('The onboarding tour does not persist changes');
};

// The tour is offline by construction, so it reports one local transport:
// `readinessBinding` selects it, and the Machine Flock sync check reads it as a
// reached remote instead of an unconfirmed zero-transport report.
const TOUR_TRANSPORT_ID = 'local';
const alreadySynced = Promise.resolve();

const TOUR_ROOM_SUBSCRIPTION = {
  unsubscribe: () => {},
  firstSyncedWithRemote: alreadySynced,
  transportIds: () => [TOUR_TRANSPORT_ID],
  subscription: () => ({ firstSyncedWithRemote: alreadySynced }),
};

const TOUR_SYNC_REPORT = {
  ok: true,
  transports: [{ transportId: TOUR_TRANSPORT_ID, ok: true }],
};

const matchesPrefix = (key: readonly unknown[], prefix: readonly unknown[]): boolean =>
  prefix.length <= key.length && prefix.every((segment, index) => key[index] === segment);

function createTourFlockDoc(rows: readonly TourFlockRow[]) {
  const flock = {
    scan: (options?: TourFlockScanOptions): readonly TourFlockRow[] => {
      const prefix = options?.prefix;
      return prefix ? rows.filter((row) => matchesPrefix(row.key, prefix)) : rows;
    },
    // A tour document is a frozen fixture, so a subscriber can never fire.
    subscribe: () => () => {},
    set: rejectTourWrite,
    delete: rejectTourWrite,
    commit: rejectTourWrite,
    // Deliberately no `version()`: `readFlockVersionToken` answers null for a
    // flock without one, which reads as "nothing materialized yet" — true here.
    // A fabricated token would claim a materialization that never happened.
  };
  return {
    flock,
    joinRoom: async () => TOUR_ROOM_SUBSCRIPTION,
    syncOnce: async () => TOUR_SYNC_REPORT,
  };
}

export function createTourRepo(): WorkspaceRuntime['repo'] {
  const docsById = new Map<string, ReturnType<typeof createTourFlockDoc>>();
  // Every id resolves, including the machine Flock documents the composer opens
  // for its model and mode options. Rejecting an open would only move the
  // failure; the tour's answer is "this document exists and is empty".
  const openFlockDoc = async (docId: string) => {
    let doc = docsById.get(docId);
    if (!doc) {
      doc = createTourFlockDoc(NO_ROWS);
      docsById.set(docId, doc);
    }
    return doc;
  };
  // The renderer's repo is loro-repo's class. The tour implements exactly the
  // read surface the mounted components reach for, and nothing else.
  return { openFlockDoc } as unknown as WorkspaceRuntime['repo'];
}
