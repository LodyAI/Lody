import { LoroRepo } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import {
  createLocalWindowBootstrap,
  firstAvailableSnapshot,
} from '../../src/providers/local-window-bootstrap';
import {
  readEagerSyncSnapshot,
  writeEagerSyncSnapshot,
} from '../../src/providers/eager-sync-snapshot-cache';
import { createConversationSession } from '../../src/lib/conversation-view/create-conversation-session';
import {
  buildFixtureHistory,
  buildSessionDoc,
  FIXTURE_SESSION_ID,
} from '../../tests/conversation-view-fixtures';

const room = 'session:benchmark';
let owner: ReturnType<typeof createLocalWindowBootstrap> | undefined;
let sourceRepo: LoroRepo | undefined;
let sourceDoc: LoroDoc | undefined;
export async function seed(rounds: number) {
  owner?.close();
  await sourceRepo?.destroy();
  sourceRepo = await LoroRepo.create({});
  await sourceRepo.upsertDocMeta(room, { title: 'Synthetic benchmark session' });
  sourceDoc = buildSessionDoc(buildFixtureHistory(rounds));
  const snapshot = sourceDoc.export({ mode: 'snapshot' });
  await writeEagerSyncSnapshot({
    scope: 'hit',
    roomId: room,
    plane: 'local',
    lastMessageAt: rounds,
    savedAt: Date.now(),
    snapshot: new Blob([snapshot]),
  });
  owner = createLocalWindowBootstrap(sourceRepo, 'bench', new Map([[room, sourceDoc]]));
  return { entries: rounds * 2, bytes: snapshot.byteLength };
}
export async function sample(
  variant: 'before' | 'after',
  scenario: 'disk-hit' | 'peer-hit' | 'miss',
  entries: number
) {
  const repo = await LoroRepo.create({});
  const target =
    variant === 'after'
      ? createLocalWindowBootstrap(repo, scenario === 'miss' ? 'absent' : 'bench', new Map())
      : undefined;
  const doc = new LoroDoc();
  const start = performance.now();
  const disk = readEagerSyncSnapshot(scenario === 'disk-hit' ? 'hit' : 'miss', room).then(
    async (entry) => (entry ? new Uint8Array(await entry.snapshot.arrayBuffer()) : undefined)
  );
  const snapshot =
    variant === 'after'
      ? await firstAvailableSnapshot([target!.readDocument(room), disk])
      : await disk;
  const acquiredMs = performance.now() - start;
  let readableMs: number | null = null;
  if (snapshot) {
    doc.import(snapshot);
    const session = createConversationSession(doc, {
      sessionId: FIXTURE_SESSION_ID,
      tailKeep: 0,
      scheduleIdle: () => () => {},
    });
    try {
      if (session.history.turnCount !== entries)
        await new Promise<void>((resolve) => {
          const unsubscribe = session.history.subscribe((event) => {
            if (event.kind === 'structure') {
              unsubscribe();
              resolve();
            }
          });
        });
      const lease = session.history.acquireRange(Math.max(0, entries - 30), entries);
      await lease.ready;
      if (session.history.turnCount !== entries || !session.history.turn(entries - 1))
        throw new Error('Missing readable history');
      readableMs = performance.now() - start;
      lease.release();
    } finally {
      session.dispose();
    }
  }
  await disk;
  target?.close();
  await repo.destroy();
  return { acquiredMs, readableMs };
}
