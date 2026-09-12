import { updateTestHistory } from '../../../tests/history-port-fixture';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { type SessionControlPlaneMirror, type SessionId } from '@lody/shared';
import { LoroDoc, LoroList, LoroMap } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/utils/logger';
import { SessionDocument } from '../loro/doc';
import { ensurePermissionRequestOnToolCall, findPermissionOutcomeInHistory } from './history';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';

const mirrors: SessionControlPlaneMirror[] = [];
afterEach(() => {
  for (const mirror of mirrors.splice(0)) mirror.dispose();
});

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createStoredTool = (payload: 'unknown' | 'malformed') => {
  // Synthetic old-client storage: it intentionally cannot be authored by the
  // current new-message parser. Import it into an independent current client.
  const oldClient = new LoroDoc();
  const sessionId = 'permission-writer-test' as SessionId;
  const turn = oldClient.getList('history').pushContainer(new LoroMap());
  turn.set('id', 'assistant-turn');
  turn.set('role', 'assistant');
  turn.set('timestamp', '2026-09-08T00:00:00.000Z');
  const items = turn.setContainer('items', new LoroList());
  const tool = items.pushContainer(new LoroMap());
  tool.set('type', 'tool_call');
  tool.set('toolCallId', 'call');
  tool.set('status', 'pending');
  const content = tool.setContainer('content', new LoroList());
  const storedPayload = content.pushContainer(new LoroMap());
  if (payload === 'unknown') {
    storedPayload.set('type', 'future_tool_content');
    storedPayload.setContainer('payload', new LoroMap()).set('version', 1);
  } else {
    storedPayload.set('type', 'terminal_output');
    storedPayload.set('output', 42);
  }
  oldClient.commit();
  // The old client is a composed session document too, so its doc carries the
  // same control-plane roots as the current client and the convergence export
  // below compares identical root sets.
  const oldClientDoc = new SessionDocument(
    {} as LoroRepo,
    sessionId,
    async () => {},
    createLogger()
  );
  composeTestSessionDoc(oldClientDoc, { doc: oldClient });
  if (oldClientDoc.mirror) mirrors.push(oldClientDoc.mirror);

  const currentClient = new LoroDoc();
  currentClient.import(oldClient.export({ mode: 'snapshot' }));
  const doc = new SessionDocument({} as LoroRepo, sessionId, async () => {}, createLogger());
  // Compose the production storage entry (control-plane Mirror + shared writer
  // + session-data seam) over the imported current client.
  composeTestSessionDoc(doc, { doc: currentClient });
  if (doc.mirror) mirrors.push(doc.mirror);

  const readStored = () => {
    const storedTurn = currentClient.getList('history').get(0) as LoroMap;
    const storedItems = storedTurn.get('items') as LoroList;
    const storedTool = storedItems.get(0) as LoroMap;
    const storedContent = storedTool.get('content') as LoroList;
    const item = storedContent.get(0) as LoroMap;
    return {
      tool: storedTool.toJSON(),
      content: storedContent.toJSON(),
      ids: [storedTurn.id, storedItems.id, storedTool.id, storedContent.id, item.id],
      payloadId: payload === 'unknown' ? (item.get('payload') as LoroMap).id : undefined,
    };
  };
  return { doc, currentClient, oldClient, readStored };
};

const permissionRequest = (): RequestPermissionRequest => ({
  sessionId: 'synthetic-acp-session',
  toolCall: {
    toolCallId: 'call',
    kind: 'execute',
    title: 'Run synthetic tool',
    locations: [{ path: '/synthetic/task.ts', line: 7 }],
  },
  options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
});

it("finalizes only the owning turn's unanswered requests through durable history", async () => {
  const { doc, readStored } = createStoredTool('unknown');
  const request = permissionRequest();
  await ensurePermissionRequestOnToolCall(doc, 'request', request);
  const before = readStored();
  await updateTestHistory(doc, (history) => {
    history[0]?.items.push({ type: 'tool_call', toolCallId: 'late-call', status: 'pending' });
    history[0]?.items.push({
      type: 'tool_call',
      toolCallId: 'answered',
      status: 'completed',
      permissionRequest: {
        requestId: 'answered-request',
        options: request.options,
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    });
    history.push({
      id: 'next-turn',
      role: 'assistant',
      timestamp: '2026-09-12T00:00:00.000Z',
      items: [
        {
          type: 'tool_call',
          toolCallId: 'next-call',
          status: 'pending',
          permissionRequest: { requestId: 'next-request', options: request.options },
        },
      ],
      fileDiff: [],
    });
    return history;
  });
  // The permission waiter uses this same history subscription to release the ACP request.
  const observed: unknown[] = [];
  const unsubscribe = doc.subscribeAll(() => {
    void doc.sessionData.history
      .readAll()
      .then((history) => observed.push(findPermissionOutcomeInHistory(history, 'request')));
  });
  try {
    await doc.sessionData.commands.applyHistoryAction({
      kind: 'finish-assistant',
      turnId: 'assistant-turn',
      endedAt: 1000,
    });
    const history = await doc.sessionData.history.readAll();
    expect(findPermissionOutcomeInHistory(history, 'request')).toEqual({ outcome: 'cancelled' });
    expect(observed).toContainEqual({ outcome: 'cancelled' });
    expect(findPermissionOutcomeInHistory(history, 'answered-request')).toEqual({
      outcome: 'selected',
      optionId: 'allow',
    });
    expect(findPermissionOutcomeInHistory(history, 'next-request')).toBeUndefined();
    expect(history[1]?.finished).toBeUndefined();
    expect(readStored().content).toEqual(before.content);
    expect(readStored().ids).toEqual(before.ids);
    // Stop may win while a request is still loading its document. It must not
    // attach to the finished tool or fall back to the newer active turn.
    await expect(
      ensurePermissionRequestOnToolCall(doc, 'late-request', {
        ...request,
        toolCall: { ...request.toolCall, toolCallId: 'late-call' },
      })
    ).resolves.toBe(false);
    expect(await doc.sessionData.history.readAll()).toEqual(history);
  } finally {
    unsubscribe?.();
  }
});

describe.each(['unknown', 'malformed'] as const)(
  'permission enrichment over %s content',
  (payload) => {
    it('persists metadata and the request through SessionDocument without rewriting old payloads', async () => {
      const { doc, currentClient, oldClient, readStored } = createStoredTool(payload);
      const before = readStored();
      const request = permissionRequest();

      await expect(ensurePermissionRequestOnToolCall(doc, 'request', request)).resolves.toBe(true);

      const after = readStored();
      expect(after.ids).toEqual(before.ids);
      expect(after.payloadId).toEqual(before.payloadId);
      expect(after.content).toEqual(before.content);
      expect(after.tool).toMatchObject({
        title: request.toolCall.title,
        kind: request.toolCall.kind,
        locations: request.toolCall.locations,
        permissionRequest: { requestId: 'request', options: request.options },
      });
      // Exercise the production read boundary, not a raw-mirror getHistory stub.
      expect((await doc.sessionData.history.readAll())[0]?.items[0]).toMatchObject({
        type: 'tool_call',
        content: before.content,
        permissionRequest: { requestId: 'request' },
      });
      oldClient.import(currentClient.export({ mode: 'update', from: oldClient.version() }));
      expect(oldClient.toJSON()).toEqual(currentClient.toJSON());
    });

    it.each(['kind', 'locations'] as const)(
      'rejects a newly malformed %s atomically and permits a later valid request',
      async (field) => {
        const { doc, currentClient, readStored } = createStoredTool(payload);
        const before = readStored();
        const version = currentClient.version().toJSON();
        const json = currentClient.toJSON();
        const request = permissionRequest();
        const invalidRequest = {
          ...request,
          toolCall: {
            ...request.toolCall,
            [field]: field === 'kind' ? 'invalid_tool_kind' : [{ path: 42, line: 'seven' }],
          },
        } as unknown as RequestPermissionRequest;

        await expect(
          ensurePermissionRequestOnToolCall(doc, 'invalid', invalidRequest)
        ).rejects.toThrow('Session write rejected: invalid_input');
        expect(currentClient.version().toJSON()).toEqual(version);
        expect(currentClient.toJSON()).toEqual(json);
        expect(readStored()).toEqual(before);

        await expect(ensurePermissionRequestOnToolCall(doc, 'valid', request)).resolves.toBe(true);
        expect(readStored().tool).toMatchObject({ permissionRequest: { requestId: 'valid' } });
        expect(readStored().content).toEqual(before.content);
        expect(readStored().ids).toEqual(before.ids);
      }
    );

    it('does not treat changed content as permission-only enrichment', async () => {
      const { doc, currentClient } = createStoredTool(payload);
      const version = currentClient.version().toJSON();
      const json = currentClient.toJSON();

      await expect(
        updateTestHistory(doc, (history) => {
          const tool = history[0]?.items[0];
          if (tool?.type !== 'tool_call') throw new Error('Missing synthetic tool');
          tool.title = 'A valid metadata update';
          tool.content = [
            ...(tool.content ?? []),
            { type: 'terminal_output', output: 99 },
          ] as unknown as typeof tool.content;
          return history;
        })
      ).rejects.toThrow('Invalid history write');
      expect(currentClient.version().toJSON()).toEqual(version);
      expect(currentClient.toJSON()).toEqual(json);
    });
  }
);
