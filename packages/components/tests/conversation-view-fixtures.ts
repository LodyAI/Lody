import { sessionDocSchema, type SessionHistory, type SessionId } from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

export const FIXTURE_SESSION_ID = 'session-conversation-view-fixture' as SessionId;

const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/**
 * Deterministic synthetic history exercising every container shape the session
 * schema produces: user turns with input config (some with an Agent Role),
 * assistant turns with thoughts, tool calls carrying permission requests and
 * nested payloads, plans, file diffs, model info, system notices, and a
 * proposed plan. Never derived from real transcripts.
 */
export function buildFixtureHistory(rounds: number): SessionHistory[] {
  const history: SessionHistory[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const n = round * 2;
    history.push({
      id: `u-${round}`,
      role: 'user',
      timestamp: ts(n),
      status: 'handled',
      read: true,
      userId: 'user-1',
      finished: true,
      fileDiff: [],
      items: [{ type: 'text', text: `Round ${round}: please inspect module-${round}.` }],
      inputConfig: {
        prompt: `Round ${round}: please inspect module-${round}.`,
        cliType: 'builtin',
        agentType: 'claude',
        modeId: round % 2 === 0 ? 'default' : 'plan',
        modelId: 'sonnet',
        inputBlocks: [{ type: 'text', text: `Round ${round}` }],
        configOptionValues: { effort: round % 3 === 0 ? 'high' : 'low' },
        ...(round % 4 === 1 ? { agentRoleId: `role-${round}`, agentRoleRevision: round } : {}),
      },
    } as unknown as SessionHistory);
    const items: unknown[] = [
      { type: 'thought', text: `Thinking about round ${round}` },
      {
        type: 'tool_call',
        toolCallId: `tc-${round}`,
        status: 'completed',
        title: `Read src/module-${round}.ts`,
        kind: 'read',
        rawInput: { path: `src/module-${round}.ts`, nested: { deep: 'value' } },
        content: [{ type: 'content', content: { type: 'text', text: `body ${round}` } }],
        locations: [{ path: `src/module-${round}.ts`, line: round }],
        ...(round % 3 === 0
          ? {
              permissionRequest: {
                requestId: `req-${round}`,
                options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
                ...(round % 6 === 0 ? { outcome: { outcome: 'selected', optionId: 'allow' } } : {}),
              },
            }
          : {}),
      },
      { type: 'text', text: `Answer for round ${round}. `.repeat(3) },
    ];
    if (round % 5 === 2) {
      items.push({ type: 'system_notice', name: 'chat_failed', meta: { reason: 'acp_provider_overloaded' } });
    }
    if (round % 7 === 3) {
      items.push({
        type: 'proposed_plan',
        turnId: `acp-${round}`,
        markdown: `# Plan ${round}\n\n- step`,
        status: 'completed',
        isLatest: true,
      });
    }
    history.push({
      id: `a-${round}`,
      role: 'assistant',
      timestamp: ts(n + 1),
      userTurnId: `u-${round}`,
      acpTurnId: `acp-${round}`,
      endedAt: Date.UTC(2026, 0, 1, 0, 0, n + 1, 500),
      finished: true,
      permissionWaitMs: round,
      fileDiff:
        round % 2 === 0
          ? [{ path: `src/module-${round}.ts`, add: round, del: 1, cc: { v: 1, fileId: `f-${round}` } }]
          : [],
      modelInfo: { name: 'sonnet', _meta: { provider: 'anthropic' } },
      items,
      ...(round % 4 === 0
        ? { plan: [{ status: 'pending', content: `plan ${round}`, priority: 'high' }] }
        : {}),
    } as unknown as SessionHistory);
  }
  return history;
}

/** Writes `history` through the production Mirror path and returns the doc. */
export function buildSessionDoc(history: readonly SessionHistory[], peerId = 1): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  const mirror = new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: FIXTURE_SESSION_ID }, history: [] },
  });
  mirror.setState((prev) => ({ ...prev, history: history as never }));
  doc.commit();
  mirror.dispose();
  return doc;
}

export function reimport(doc: LoroDoc): LoroDoc {
  const fresh = new LoroDoc();
  fresh.import(doc.export({ mode: 'snapshot' }));
  return fresh;
}

/** What today's full Mirror path materializes for the doc's history. */
export function mirrorHistoryOf(doc: LoroDoc): SessionHistory[] {
  const mirror = new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: FIXTURE_SESSION_ID }, history: [] },
  });
  const history = mirror.getState().history as unknown as SessionHistory[];
  mirror.dispose();
  return history;
}

export type ManualIdle = {
  scheduleIdle: (task: (deadline: { timeRemaining(): number }) => void) => () => void;
  runAll: () => void;
  pending: () => number;
};

export function createManualIdle(): ManualIdle {
  const tasks: Array<(deadline: { timeRemaining(): number }) => void> = [];
  return {
    scheduleIdle: (task) => {
      tasks.push(task);
      return () => {
        const at = tasks.indexOf(task);
        if (at >= 0) tasks.splice(at, 1);
      };
    },
    runAll: () => {
      let guard = 0;
      while (tasks.length > 0 && guard < 10_000) {
        guard += 1;
        tasks.shift()!({ timeRemaining: () => 50 });
      }
    },
    pending: () => tasks.length,
  };
}
