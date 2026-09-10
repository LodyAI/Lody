/** Run with bun; synthetic library benchmark, not renderer or device acceptance. */
import { LoroDoc } from 'loro-crdt';
import {
  createConversationSession,
  createConversationDerivation,
} from '../src/lib/conversation-view';
import {
  buildFixtureHistory,
  buildSessionDoc,
  createManualIdle,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';
const rounds = Number(process.env.CV_ROUNDS ?? 3000);
const fixture = buildSessionDoc(buildFixtureHistory(rounds));
const snapshot = fixture.export({ mode: 'snapshot' });
fixture.free();
const results = [];
for (const windowed of [false, true]) {
  const doc = new LoroDoc();
  const importStart = performance.now();
  doc.import(snapshot);
  const importMs = performance.now() - importStart;
  const idle = createManualIdle();
  const start = performance.now();
  const session = createConversationSession(doc, {
    sessionId: FIXTURE_SESSION_ID,
    windowed,
    scheduleIdle: idle.scheduleIdle,
  });
  const openMs = performance.now() - start;
  const view = session.history;
  const from = Math.max(0, view.turnCount - 30);
  const windowStart = performance.now();
  await view.ensureRange(from, view.turnCount);
  const windowMs = performance.now() - windowStart;
  const target = view.index(view.turnCount - 1)!;
  const updateStart = performance.now();
  for (let i = 0; i < 100; i++) session.historyWriter.setField(target.id, 'endedAt', i);
  const updateMeanMs = (performance.now() - updateStart) / 100;
  if (session.historyWriter.read(target.id)?.endedAt !== 99) throw new Error('write mismatch');
  view.release(from, view.turnCount);
  const backgroundStart = performance.now();
  idle.runAll();
  const derivation = createConversationDerivation(view, (turn) => ({ id: turn.id }), {
    yieldToEventLoop: async () => {},
  });
  while (!derivation.complete) await Promise.resolve();
  const backgroundMs = performance.now() - backgroundStart;
  let hydrated = 0;
  for (let i = 0; i < view.turnCount; i++) if (view.isHydrated(i)) hydrated++;
  if (derivation.facts.size !== rounds * 2) throw new Error('missing facts');
  derivation.dispose();
  if (derivation.facts.size) throw new Error('disposed facts retained');
  results.push({
    windowed,
    rounds,
    entries: view.turnCount,
    snapshotBytes: snapshot.length,
    importMs,
    openMs,
    windowMs,
    updateMeanMs,
    backgroundMs,
    hydrated,
  });
  view.dispose();
  session.mirror.dispose();
  doc.free();
}
console.log(JSON.stringify(results, null, 2));
