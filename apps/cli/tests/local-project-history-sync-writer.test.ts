import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { LoroDoc, LoroList, LoroMap } from 'loro-crdt';
import { Mirror, schema } from 'loro-mirror';
import {
  getSessionRoomId,
  sessionDocSchema,
  parseSessionNotification,
  type AcpSessionNotification,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type SessionHistoryInput,
  type WorkspaceId,
} from '@lody/shared';

import { LocalProjectHistorySyncService } from '../src/lib/local-project-history-sync-service';
import { SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import type { Logger } from '../src/utils/logger';

const providerMocks = vi.hoisted(() => ({
  list: vi.fn(),
  replay: vi.fn(),
}));

vi.mock('../src/lib/history-session-catalog-client', () => ({
  listHistorySessionsForLocalProject: providerMocks.list,
  loadHistorySessionReplay: providerMocks.replay,
  MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS: 100,
}));

vi.mock('../src/lib/local-project-meta', () => ({
  readMachineLocalProjects: async () => ({}),
  upsertMachineLocalProject: async () => {},
}));

const localProjectId = 'history-writer-project' as LocalProjectId;
const machineId = 'history-writer-machine' as MachineId;
const workspaceId = 'history-writer-workspace' as WorkspaceId;
const acpSessionId = 'history-writer-source';
const rootPath = '/synthetic/history-provider';
const provider = { cliType: 'builtin', agentType: 'codex' } as const;
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.clearAllMocks();
});

function notifications(turns: number): AcpSessionNotification[] {
  const result: AcpSessionNotification[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    for (const update of [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `User ${turn}` } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: `call-${turn}`,
        title: 'Read synthetic file',
        kind: 'read',
        status: 'completed',
        // Legal ACP extension: new writes must retain it, not just compensate in the hash.
        locations: [{ path: `src/file-${turn}.ts`, line: 1, endColumn: 12 }],
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Answer ${turn}` },
      },
    ]) {
      result.push(parseSessionNotification({ sessionId: acpSessionId, update }));
    }
  }
  return result;
}

async function createHarness() {
  const repo = await LoroRepo.create({});
  disposers.push(() => repo.destroy());
  const docs = new Map<SessionId, SessionDocument>();
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    debug: () => {},
    setLevel: () => {},
    child: () => logger,
    close: async () => {},
  };
  const manager = {
    repo,
    async getOrCreateSessionDoc(sessionId: SessionId) {
      let doc = docs.get(sessionId);
      if (!doc) {
        doc = new SessionDocument(repo, sessionId, undefined, logger);
        await doc.initOffline({ history: [] });
        vi.spyOn(doc, 'waitUntilSynced').mockResolvedValue(true);
        docs.set(sessionId, doc);
      }
      return doc;
    },
    cleanSessionDoc: async () => {},
  };
  const service = new LocalProjectHistorySyncService(
    manager as unknown as LoroDocumentManager,
    logger,
    { workspaceId, machineId, userId: 'synthetic-user' },
    provider
  );

  let revision = 0;
  async function importTurns(turns: number) {
    revision += 1;
    providerMocks.list.mockResolvedValue({
      sessions: [
        {
          sessionId: acpSessionId,
          title: 'Synthetic writer history',
          updatedAt: new Date(Date.UTC(2026, 8, 7, 0, revision)).toISOString(),
        },
      ],
    });
    providerMocks.replay.mockResolvedValue(notifications(turns));
    return service.importLocalProjectSessions({
      localProjectId,
      rootPath,
      acpSessionIds: [acpSessionId],
    });
  }

  function getOnlyDoc() {
    expect(docs.size).toBe(1);
    const entry = docs.entries().next().value;
    if (!entry) throw new Error('Import did not create a SessionDocument');
    return { sessionId: entry[0], doc: entry[1] };
  }

  async function getMeta(sessionId: SessionId) {
    const record = await repo.getDocMeta(getSessionRoomId(sessionId));
    if (!record?.meta) throw new Error('Import did not publish session metadata');
    return record.meta as SessionMeta;
  }

  async function rawDoc() {
    const { sessionId } = getOnlyDoc();
    return (await repo.openPersistedDoc(getSessionRoomId(sessionId))).doc;
  }
  async function makeLegacy() {
    const { doc } = getOnlyDoc();
    const loro = await rawDoc();
    location(loro).set('endColumn', 12);
    loro.commit();
    const cursor = await doc.getExternalHistoryCursor();
    await doc.setExternalHistoryCursor({ importedTurnHashes: cursor?.importedTurnHashes });
    return loro;
  }
  return { repo, service, importTurns, getOnlyDoc, getMeta, rawDoc, makeLegacy };
}

function location(doc: LoroDoc): LoroMap {
  const turn = doc.getList('history').get(1) as LoroMap;
  const tool = (turn.get('items') as LoroList).get(0) as LoroMap;
  return (tool.get('locations') as LoroList).get(0) as LoroMap;
}

describe('history import through the real SessionDocument writer', () => {
  it.each([false, true])(
    'recognizes a projected suffix arriving before the cursor (legacy=%s)',
    async (legacy) => {
      const h = await createHarness();
      await h.importTurns(1);
      if (legacy) await h.makeLegacy();
      const { doc } = h.getOnlyDoc();
      const cursor = await doc.getExternalHistoryCursor();
      if (!cursor) throw new Error('Missing source cursor');
      expect((await h.importTurns(2)).summary.refreshed).toBe(1);
      // Model a peer receiving the history commit before the separate cursor commit.
      await doc.setExternalHistoryCursor(cursor);
      const loro = await h.rawDoc();
      const before = loro.getList('history').toJSON();
      expect((await h.importTurns(2)).summary).toMatchObject({ skipped: 1, conflicted: 0 });
      expect(loro.getList('history').toJSON()).toEqual(before);
      expect((await doc.getExternalHistoryCursor())?.importedTurnHashes).toHaveLength(4);
    }
  );

  it('does not advance the cursor when the new history command fails validation', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const { doc } = h.getOnlyDoc();
    const loro = await h.rawDoc();
    const before = loro.toJSON();
    const version = loro.version().toJSON();
    await expect(
      doc.updateHistoryAndCursor(
        (history) => [
          ...history,
          {
            id: 'invalid',
            role: 'assistant',
            timestamp: 'synthetic',
            items: [{ type: 'text', text: 3 }],
          } as unknown as SessionHistoryInput,
        ],
        () => ({ importedTurnHashes: ['must-not-be-saved'] })
      )
    ).rejects.toThrow('Invalid history write');
    expect(loro.toJSON()).toEqual(before);
    expect(loro.version().toJSON()).toEqual(version);
  });

  it('keeps the new baseline opaque to an old cursor reader and survives reopening', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const { doc } = h.getOnlyDoc();
    const loro = await h.rawDoc();
    const peer = new LoroDoc();
    peer.import(loro.export({ mode: 'snapshot' }));
    // Exact pre-baseline cursor shape; all other schema fields are unchanged.
    const oldReader = new Mirror({
      doc: peer,
      schema: schema({
        ...sessionDocSchema.definition,
        externalHistoryCursor: schema.LoroMap(
          {
            importedTurnHashes: schema.LoroList(schema.String(), undefined, { required: false }),
          },
          { required: false }
        ),
      }),
      ignoreUnknownProperties: true,
    });
    const before = peer.toJSON();
    expect(oldReader.getState().history).toHaveLength(2);
    expect(peer.toJSON()).toEqual(before);
    const reopened = new SessionDocument(h.repo, h.getOnlyDoc().sessionId, undefined, undefined);
    await reopened.initOffline({ history: [] });
    expect(await reopened.getExternalHistoryCursor()).toEqual(await doc.getExternalHistoryCursor());
    // Reopening is not a migration or a new author of the old history.
    expect(loro.toJSON()).toEqual(before);
    oldReader.setState((state) => {
      state.externalHistoryCursor.importedTurnHashes = ['old-writer-source'];
    });
    expect(peer.toJSON().externalHistoryCursor.storedHistoryBaseline).toEqual(
      before.externalHistoryCursor.storedHistoryBaseline
    );
    loro.import(peer.export({ mode: 'update', from: loro.version() }));
    expect((await h.importTurns(1)).summary.conflicted).toBe(1);
    oldReader.dispose();
  });

  it('resolves a marked conflict through the real writer and repeated resolve stays idempotent', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const { sessionId } = h.getOnlyDoc();
    const loro = await h.rawDoc();
    location(loro).set('line', 99);
    loro.commit();
    expect((await h.importTurns(2)).summary.conflicted).toBe(1);
    const args = { localProjectId, rootPath, sessionId, acpSessionId };
    expect((await h.service.resolveHistoryConflict(args)).status).toBe('resolved');
    expect(loro.getList('history').length).toBe(4);
    expect(location(loro).get('line')).toBe(1);
    const version = loro.version().toJSON();
    expect((await h.service.resolveHistoryConflict(args)).status).toBe('resolved');
    expect(loro.version().toJSON()).toEqual(version);
    expect((await h.importTurns(3)).summary).toMatchObject({ refreshed: 1, conflicted: 0 });
  });

  it('preserves legacy storage/CIDs while appending projected new turns', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const loro = await h.makeLegacy();
    const before = loro.getList('history').toJSON();
    const cid = location(loro).id;
    expect((await h.importTurns(2)).summary).toMatchObject({ refreshed: 1, conflicted: 0 });
    expect(loro.getList('history').toJSON().slice(0, 2)).toEqual(before);
    expect(location(loro).id).toBe(cid);
    expect((await h.importTurns(3)).summary).toMatchObject({ refreshed: 1, conflicted: 0 });
  });

  it('detects deletion of a legacy provider field', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const loro = await h.makeLegacy();
    location(loro).delete('endColumn');
    loro.commit();
    const before = loro.toJSON();
    expect((await h.importTurns(2)).summary).toMatchObject({ conflicted: 1, refreshed: 0 });
    expect(loro.toJSON()).toEqual(before);
  });

  it.each(['field', 'delete', 'append'] as const)(
    'detects local %s changes with an unchanged source digest',
    async (change) => {
      const h = await createHarness();
      await h.importTurns(1);
      const loro = await h.rawDoc();
      if (change === 'field') location(loro).set('endColumn', 99);
      else if (change === 'delete') loro.getList('history').delete(1, 1);
      else loro.getList('history').push({ id: 'local', role: 'assistant', items: [] });
      loro.commit();
      const before = loro.toJSON();
      expect((await h.importTurns(1)).summary).toMatchObject({ conflicted: 1, refreshed: 0 });
      expect(loro.toJSON()).toEqual(before);
    }
  );

  it('does not reuse a baseline after an old client advances only source hashes', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const { doc } = h.getOnlyDoc();
    const cursor = await doc.getExternalHistoryCursor();
    await doc.setExternalHistoryCursor({ ...cursor, importedTurnHashes: ['old-client-source'] });
    const before = await doc.getExternalHistoryCursor();
    expect((await h.importTurns(1)).summary).toMatchObject({ conflicted: 1, refreshed: 0 });
    expect(await doc.getExternalHistoryCursor()).toEqual(before);
  });

  it('checks a peer edit arriving at the write boundary instead of blessing it in the baseline', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const { doc } = h.getOnlyDoc();
    const loro = await h.rawDoc();
    const peer = new LoroDoc();
    peer.import(loro.export({ mode: 'snapshot' }));
    location(peer).set('endColumn', 99);
    peer.commit();
    const original = doc.updateHistoryAndCursor.bind(doc);
    vi.spyOn(doc, 'updateHistoryAndCursor').mockImplementationOnce((...args) => {
      loro.import(peer.export({ mode: 'update', from: loro.version() }));
      return original(...args);
    });
    expect((await h.importTurns(2)).summary).toMatchObject({ conflicted: 1, refreshed: 0 });
    peer.import(loro.export({ mode: 'update', from: peer.version() }));
    expect(peer.getList('history').toJSON()).toEqual(loro.getList('history').toJSON());
    expect(location(loro).get('endColumn')).toBe(99);
  });

  it('uses the document baseline when conflict metadata already carries the next source digest', async () => {
    const h = await createHarness();
    await h.importTurns(1);
    const { doc } = h.getOnlyDoc();
    const loro = await h.rawDoc();
    location(loro).set('endColumn', 99);
    loro.commit();
    expect((await h.importTurns(2)).summary.conflicted).toBe(1);
    location(loro).set('endColumn', 12);
    loro.commit();
    const cursor = await doc.getExternalHistoryCursor();
    expect((await h.importTurns(2)).summary).toMatchObject({ refreshed: 1, conflicted: 0 });
    expect((await doc.getExternalHistoryCursor())?.importedTurnHashes?.slice(0, 2)).toEqual(
      cursor?.importedTurnHashes
    );
  });

  it('retains ACP extensions and appends the next source replay', async () => {
    const harness = await createHarness();
    expect((await harness.importTurns(1)).summary).toMatchObject({ imported: 1, failed: 0 });
    const { doc, sessionId } = harness.getOnlyDoc();
    const initialHistory = await doc.getHistory();
    expect(initialHistory).toHaveLength(2);
    expect(JSON.stringify(initialHistory)).toContain('"endColumn":12');
    const initialCursor = await doc.getExternalHistoryCursor();
    const initialIds = initialHistory.map((entry) => entry.id);

    expect((await harness.importTurns(2)).summary).toMatchObject({
      refreshed: 1,
      conflicted: 0,
      failed: 0,
    });
    const history = await doc.getHistory();
    expect(history).toHaveLength(4);
    expect(history.slice(0, 2)).toEqual(initialHistory);
    expect(history.slice(0, 2).map((entry) => entry.id)).toEqual(initialIds);
    expect((await doc.getExternalHistoryCursor())?.importedTurnHashes?.slice(0, 2)).toEqual(
      initialCursor?.importedTurnHashes
    );
    expect((await harness.getMeta(sessionId)).externalHistory?.status).toBe('synced');
  });
});
