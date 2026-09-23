import { Loro } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { describe, expect, it } from 'vitest';

import type { AgentRoleId, McpServerId, SessionId } from '../src/ids';
import { resolveSessionConversationConfig } from '../src/session-input';
import { sessionDocSchema, type SessionDoc, type SessionHistoryInput } from '../src/schema';

const userTurn = (
  turnId: string,
  mcpServerIds: McpServerId[] | undefined
): SessionHistoryInput => ({
  id: turnId,
  role: 'user',
  items: [{ type: 'text', text: turnId }],
  timestamp: '2026-08-12T00:00:00.000Z',
  status: 'pending',
  read: false,
  userId: 'user-1',
  fileDiff: [],
  finished: true,
  inputConfig: {
    prompt: turnId,
    cliType: 'builtin',
    agentType: 'codex',
    ...(mcpServerIds === undefined ? {} : { mcpServerIds }),
  },
});

const roundTrip = (history: SessionHistoryInput[], mq: SessionDoc['mq'] = []) => {
  const sourceDoc = new Loro();
  const source = new Mirror({
    doc: sourceDoc,
    schema: sessionDocSchema,
    initialState: {
      session: { id: 'session-1' as SessionId },
      history: [],
      mq: [],
    } satisfies Partial<SessionDoc>,
    throwOnValidationError: true,
  });
  source.setState((previous) => ({ ...previous, history, mq }));

  const targetDoc = new Loro();
  targetDoc.import(sourceDoc.export({ mode: 'snapshot' }));
  const target = new Mirror({
    doc: targetDoc,
    schema: sessionDocSchema,
    throwOnValidationError: true,
  });
  const state = target.getState();
  source.dispose();
  target.dispose();
  return state;
};

describe('session MCP selection CRDT round-trip', () => {
  it('reads a persisted history-turn selection after a real Loro round-trip', () => {
    const state = roundTrip([userTurn('turn-1', ['server-a', 'server-b'] as McpServerId[])]);
    expect(resolveSessionConversationConfig(state.history, state.mq)).toMatchObject({
      mcpServerIds: ['server-a', 'server-b'],
    });
  });

  it('keeps an explicit empty selection distinct from an absent selection', () => {
    const explicitEmpty = roundTrip([userTurn('turn-empty', [])]);
    const absent = roundTrip([userTurn('turn-absent', undefined)]);
    expect(resolveSessionConversationConfig(explicitEmpty.history, explicitEmpty.mq)).toMatchObject(
      {
        mcpServerIds: [],
      }
    );
    expect(
      resolveSessionConversationConfig(absent.history, absent.mq).mcpServerIds
    ).toBeUndefined();
  });

  it('prefers the latest queued selection over history', () => {
    const state = roundTrip(
      [userTurn('turn-history', ['history-server'] as McpServerId[])],
      [
        {
          $cid: 'queue-1',
          text: 'queued',
          timestamp: '2026-08-12T00:00:01.000Z',
          acpSessionConfig: {
            prompt: 'queued',
            cliType: 'builtin',
            agentType: 'codex',
            mcpServerIds: ['queued-server'] as McpServerId[],
          },
        },
      ]
    );
    const resolved = resolveSessionConversationConfig(state.history, state.mq);
    expect(resolved.mcpServerIds).toEqual(['queued-server']);
    expect(resolved.sourceConfigKey).toMatch(/^queue:/);
  });

  it('round-trips Agent Role identity and explicit None through Loro', () => {
    const historyTurn = userTurn('turn-role', undefined);
    historyTurn.inputConfig = {
      ...historyTurn.inputConfig,
      agentRoleId: 'role-reviewer' as AgentRoleId,
      agentRoleRevision: 6,
    };
    const withRole = roundTrip([historyTurn]);
    expect(resolveSessionConversationConfig(withRole.history, withRole.mq)).toMatchObject({
      agentRoleId: 'role-reviewer',
      agentRoleRevision: 6,
    });

    const withNone = roundTrip(
      [historyTurn],
      [
        {
          $cid: 'queue-none',
          text: 'queued',
          timestamp: '2026-08-12T00:00:01.000Z',
          acpSessionConfig: {
            prompt: 'queued',
            cliType: 'builtin',
            agentType: 'codex',
            agentRoleId: null,
          },
        },
      ]
    );
    expect(resolveSessionConversationConfig(withNone.history, withNone.mq).agentRoleId).toBeNull();
  });
});
