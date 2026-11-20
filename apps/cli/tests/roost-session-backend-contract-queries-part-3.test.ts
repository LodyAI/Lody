import {
  buildReplayPromptFromHistory,
  createReplayPromptBuilder,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getMachineRoomId,
  resolveActiveAssistantTurnId,
  SessionHistoryReadQuerySchema,
  type SessionHistoryReadQuery,
  type SessionId,
} from '@lody/shared';
import { readSessionHistoryMetadata } from '@lody/shared/session-data';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import { expect, it, vi } from 'vitest';
import {
  readSessionTranscript,
  selectSessionTranscriptEntries,
  toSessionTranscriptEntries,
} from '../src/commands/session';
import { createCommandSessionHistoryFactory, type AuthContext } from '../src/lib/command-runtime';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import { createSessionBackend, type SessionBackendFactory } from '../src/session/session-backend';
import {
  coldHistoryHandlerFixture,
  nativeFixture,
  nativeUser,
  registerRoostNativeBackendSuite,
} from './roost-session-backend-test-helpers';

registerRoostNativeBackendSuite();

it('keeps rooted directory cursors, metadata selection and bounded replay equivalent to complete history', async () => {
  const fixture = await nativeFixture();
  for (let index = 0; index < 48; index++)
    await fixture.backend.appendHistoryTurn({
      ...nativeUser(`rooted-${index}`),
      userId: index === 2 ? 'earlier-author' : 'author',
      items: [{ type: 'text', text: index === 0 ? 'prefix'.repeat(50000) : `question ${index}` }],
      ...(index === 3
        ? {
            scheduleRun: {
              scheduleId: 'schedule',
              turnId: 'scheduled-turn',
              title: 'Synthetic run',
            },
          }
        : {}),
    });
  await fixture.backend.applyHistoryAction({ kind: 'remove-turn', turnId: 'rooted-17' });
  const expected = await fixture.backend.readHistory();
  const full = vi
    .spyOn(NodeLodyHistory.prototype, 'readActiveBranch')
    .mockRejectedValue(new Error('whole history forbidden'));
  const all = vi
    .spyOn(fixture.backend.history, 'readAll')
    .mockRejectedValue(new Error('whole history forbidden'));
  try {
    const ids: string[] = [];
    let page = await fixture.backend.history.readLatestDirectoryPage!(7);
    for (;;) {
      ids.unshift(...page.rows.map((row) => row.turnId!));
      if (!page.hasMoreOlder || !page.cursor) break;
      page = await fixture.backend.history.readOlderDirectoryPage!(page.cursor, 7);
    }
    expect(ids).toEqual(expected.map((row) => row.id));
    const body = NodeLodyHistory.prototype.readActiveBranchMessages;
    const selected = vi
      .spyOn(NodeLodyHistory.prototype, 'readActiveBranchMessages')
      .mockImplementation(function (viewId, requested) {
        if (requested.some((id) => !['rooted-45', 'rooted-46', 'rooted-47'].includes(id)))
          throw new Error('unrelated body forbidden');
        return body.call(this, viewId, requested);
      });
    try {
      const transcript = toSessionTranscriptEntries(expected);
      expect(await readSessionTranscript(fixture.backend, { limit: 3 })).toEqual({
        hasMore: transcript.length > 3,
        entries: selectSessionTranscriptEntries(transcript, { limit: 3 }),
      });
      const query = await fixture.backend.readHistoryQuery();
      expect(query.map((row) => row.id)).toEqual(ids);
    } finally {
      selected.mockRestore();
    }
    const builder = await fixture.backend.foldHistory(
      () => createReplayPromptBuilder({ maxChars: 511 }),
      (state, entry) => state.add(entry)
    );
    expect(builder.finish()).toEqual(
      buildReplayPromptFromHistory({ history: expected, maxChars: 511 })
    );
  } finally {
    all.mockRestore();
    full.mockRestore();
  }
});

it.each([undefined, 1, 2])(
  'keeps CLI metadata, transcript and replay usable while streaming (inspection v%s)',
  async (version) => {
    const fixture = await coldHistoryHandlerFixture(1);
    const sessionId = [...fixture.docs.keys()][0]!;
    let client: Awaited<ReturnType<SessionBackendFactory>> | undefined;
    try {
      await fixture.ready(sessionId);
      await fixture.rpc.writeSessionHistoryForRpc(sessionId, 'append', {
        entry: {
          ...nativeUser('rpc-prefix'),
          inputConfig: { modelId: 'synthetic-model', modeId: 'ask' },
          items: [{ type: 'text', text: 'prefix'.repeat(50000) }],
        },
      });
      const doc = fixture.docs.get(sessionId)!;
      const owner = await createSessionBackend(doc);
      for (let index = 0; index < 50; index++)
        await owner.appendHistoryTurn({
          ...nativeUser(`rpc-row-${index}`),
          status: 'handled',
          read: true,
        });
      await owner.openAssistantTurn({
        turnId: 'rpc-live',
        userTurnId: 'rpc-row-49',
        timestamp: '2026-10-31T00:00:00Z',
      });
      const capabilities: Record<string, number> = { ...CURRENT_MACHINE_PROTOCOL_CAPABILITIES };
      if (version === undefined) delete capabilities.sessionHistoryInspection;
      else capabilities.sessionHistoryInspection = version;
      await fixture.repo.upsertDocMeta(getMachineRoomId('test-machine'), {
        id: 'test-machine',
        protocolCapabilities: capabilities,
      });
      let update = 0;
      const factory = createCommandSessionHistoryFactory(
        () => ({ repo: fixture.repo }) as LoroDocumentManager,
        { userId: 'test-user', machineId: 'test-machine', token: 'synthetic-token' } as AuthContext,
        'test-workspace',
        async (_target, run) =>
          run({
            requestSessionHistoryRead: async (request: {
              sessionId: SessionId;
              query: SessionHistoryReadQuery;
            }) => {
              const query = SessionHistoryReadQuerySchema.parse(request.query);
              if (version === 2 ? query.kind === 'readAll' : query.kind !== 'readAll')
                throw new Error('History read used the wrong negotiated protocol');
              await owner.applyHistoryAction({
                kind: 'assistant-items',
                turnId: 'rpc-live',
                mode: 'replace',
                items: Array.from({ length: (++update % 2) + 1 }, (_, index) => ({
                  type: 'text' as const,
                  text: `stream-${update}-${index}`,
                })),
              });
              return fixture.rpc.readSessionHistoryForRpc(request.sessionId, query);
            },
          } as never)
      );
      client = await factory(doc, await doc.getMetaState());
      const metadata = await readSessionHistoryMetadata(client.history);
      expect(resolveActiveAssistantTurnId(metadata)).toBe('rpc-live');
      expect(metadata[0]).toMatchObject({
        id: 'rpc-prefix',
        inputConfig: { modeId: 'ask', modelId: 'synthetic-model' },
      });
      const query = await client.readHistoryQuery();
      expect(query.at(-1)).toMatchObject({ id: 'rpc-live', role: 'assistant' });
      expect(await client.readLatestGoal()).toBeNull();
      expect(await client.readHistoryEntry?.('rpc-row-7')).toMatchObject({
        id: 'rpc-row-7',
        status: 'handled',
      });
      for (const options of [
        { all: false, limit: 50 },
        { reverse: true, limit: 3 },
      ]) {
        const transcript = await readSessionTranscript(client, options);
        const afterTranscript = toSessionTranscriptEntries(await owner.readHistory());
        expect(transcript).toEqual({
          hasMore: afterTranscript.length > options.limit,
          entries: selectSessionTranscriptEntries(afterTranscript, options),
        });
      }
      const replay = await client.readHistoryReplay?.('rpc-prefix');
      expect(replay).toEqual(
        buildReplayPromptFromHistory({
          history: await owner.readHistory(),
          excludeTurnId: 'rpc-prefix',
        })
      );
    } finally {
      await client?.dispose();
      await fixture.close();
    }
  }
);
