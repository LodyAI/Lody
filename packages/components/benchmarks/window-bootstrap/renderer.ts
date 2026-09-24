import { waitForTargetContentPainted } from '../../../../apps/electron/src/renderer/src/warm-window-reveal';
import { LoroRepo } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import {
  createLocalWindowBootstrap,
  readSessionBootstrapSnapshot,
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
  variant: 'before' | 'fixed',
  scenario: 'disk-hit' | 'peer-hit' | 'miss',
  entries: number,
  paint = false
) {
  const repo = await LoroRepo.create({});
  const target =
    variant !== 'before'
      ? createLocalWindowBootstrap(repo, scenario === 'miss' ? 'absent' : 'bench', new Map())
      : undefined;
  const doc = new LoroDoc();
  const start = performance.now();
  const disk = readEagerSyncSnapshot(scenario === 'disk-hit' ? 'hit' : 'miss', room).then(
    async (entry) => (entry ? new Uint8Array(await entry.snapshot.arrayBuffer()) : undefined)
  );
  const snapshot =
    variant === 'fixed'
      ? await readSessionBootstrapSnapshot(
          () => disk,
          () => target!.readDocument(room)
        )
      : await disk;
  const acquiredMs = performance.now() - start;
  if (snapshot) doc.import(snapshot);
  const activeSession = createConversationSession(doc, {
    sessionId: FIXTURE_SESSION_ID,
    tailKeep: 0,
    scheduleIdle: () => () => {},
  });
  const syncReadyMs = performance.now() - start;
  let readableMs: number | null = null;
  if (snapshot) {
    try {
      if (activeSession.history.turnCount !== entries)
        await new Promise<void>((resolve) => {
          const unsubscribe = activeSession.history.subscribe((event) => {
            if (event.kind === 'structure' && activeSession.history.turnCount === entries) {
              unsubscribe();
              resolve();
            }
          });
        });
      const lease = activeSession.history.acquireRange(Math.max(0, entries - 30), entries);
      await lease.ready;
      if (activeSession.history.turnCount !== entries || !activeSession.history.turn(entries - 1))
        throw new Error('Missing readable history');
      if (paint) {
        const main = document.createElement('main');
        const title = document.createElement('h1');
        title.textContent = 'Synthetic conversation — ready before show';
        main.append(title);
        for (let index = Math.max(0, entries - 30); index < entries; index++) {
          const row = document.createElement('p');
          const turn = activeSession.history.turn(index);
          row.textContent = JSON.stringify(turn);
          main.append(row);
        }
        document.body.replaceChildren(main);
        document.body.style.cssText =
          'background:#16181d;color:#e4e8ef;font:14px sans-serif;padding:24px';
      }
      readableMs = performance.now() - start;
      lease.release();
    } finally {
      activeSession.dispose();
    }
  }
  if (!snapshot) activeSession.dispose();
  await disk;
  target?.close();
  await repo.destroy();
  return { acquiredMs, readableMs, syncReadyMs: syncReadyMs ?? acquiredMs };
}

export function installNativeRevealProbe() {
  const { ipcRenderer } = require('electron');
  ipcRenderer.on(
    'app.windowTarget',
    async (_event: unknown, target: { workspace: string; sessionId: string }) => {
      await sample('fixed', 'peer-hit', 3000, true);
      const marker = document.createElement('span');
      marker.hidden = true;
      marker.setAttribute('data-window-session-ready', target.sessionId);
      document.body.append(marker);
      waitForTargetContentPainted(document.body, target, () =>
        ipcRenderer.send('app.windowContentReady', target)
      );
    }
  );
}
