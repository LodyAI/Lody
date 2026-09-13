import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { v4 as uuidv4 } from 'uuid';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';

import {
  appendACPNotificationsToAssistantEntry,
  ensurePermissionRequestOnToolCall,
} from '../src/lib/acp/history';
import { SessionDocument } from '../src/lib/loro/doc';

/**
 * The renderer decides where to split a plan turn purely from the persisted
 * `tool_call.kind === 'switch_mode'` (see
 * `packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts`).
 * If that kind is dropped anywhere between the adapter and the Loro document,
 * the split silently never happens and an approved plan goes back to being
 * invisible — with nothing failing anywhere.
 *
 * Both bundled adapters emit this kind for plan approval and NOTHING else:
 * Claude's `ExitPlanMode` (`tools.ts`, title "Ready to code?") and Codex's
 * plan review (`CodexAcpServer.ts`, title "Implement this plan?"). So these
 * cover the orderings that actually occur in production.
 */
const PLAN_EXIT_TOOL_CALL_ID = 'plan-exit-1';

const assistantEntry = (): SessionHistoryInput => ({
  id: 'assistant-1',
  role: 'assistant',
  items: [] as unknown as SessionHistoryInput['items'],
  timestamp: new Date().toISOString(),
  read: undefined,
  userId: undefined,
  fileDiff: [],
});

const planExitToolCallNotification = (sessionId: SessionId): AcpSessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: PLAN_EXIT_TOOL_CALL_ID,
    title: 'Ready to code?',
    kind: 'switch_mode',
    status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: '# Plan\n1. Do the thing' } }],
  } as unknown as AcpSessionNotification['update'],
});

/** Follow-up updates routinely omit `kind`; it must not erase the stored one. */
const planExitCompletion = (sessionId: SessionId): AcpSessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: PLAN_EXIT_TOOL_CALL_ID,
    status: 'completed',
  } as unknown as AcpSessionNotification['update'],
});

const planExitPermission = (sessionId: SessionId): RequestPermissionRequest =>
  ({
    sessionId,
    options: [
      { optionId: 'proceed', name: 'Yes, implement this plan', kind: 'allow_always' },
      { optionId: 'keep-planning', name: 'No, keep planning', kind: 'reject_once' },
    ],
    toolCall: {
      toolCallId: PLAN_EXIT_TOOL_CALL_ID,
      title: 'Ready to code?',
      kind: 'switch_mode',
      status: 'pending',
    },
  }) as unknown as RequestPermissionRequest;

const readStoredPlanExit = async (
  doc: SessionDocument
): Promise<Extract<MessageContent, { type: 'tool_call' }> | undefined> => {
  const history = await doc.getHistory();
  for (const entry of history) {
    for (const item of (entry.items ?? []) as unknown as MessageContent[]) {
      if (item?.type === 'tool_call' && item.toolCallId === PLAN_EXIT_TOOL_CALL_ID) {
        return item;
      }
    }
  }
  return undefined;
};

const withDoc = async (run: (doc: SessionDocument, sessionId: SessionId) => Promise<void>) => {
  const sessionId = uuidv4() as SessionId;
  const repo = await LoroRepo.create({});
  const doc = new SessionDocument(repo, sessionId);
  await doc.initOffline();
  await doc.updateHistory(() => [assistantEntry()]);
  try {
    await run(doc, sessionId);
  } finally {
    await repo.destroy();
  }
};

describe('plan-exit tool kind survives into the session document', () => {
  it('persists switch_mode from the tool_call notification', async () => {
    await withDoc(async (doc, sessionId) => {
      await appendACPNotificationsToAssistantEntry(
        doc,
        [planExitToolCallNotification(sessionId)],
        'assistant-1'
      );

      expect((await readStoredPlanExit(doc))?.kind).toBe('switch_mode');
    });
  });

  it('keeps switch_mode when a later tool_call_update omits the kind', async () => {
    await withDoc(async (doc, sessionId) => {
      await appendACPNotificationsToAssistantEntry(
        doc,
        [planExitToolCallNotification(sessionId), planExitCompletion(sessionId)],
        'assistant-1'
      );

      const stored = await readStoredPlanExit(doc);
      expect(stored?.kind).toBe('switch_mode');
      expect(stored?.status).toBe('completed');
    });
  });

  it('keeps switch_mode when the permission request merges onto an existing tool call', async () => {
    await withDoc(async (doc, sessionId) => {
      await appendACPNotificationsToAssistantEntry(
        doc,
        [planExitToolCallNotification(sessionId)],
        'assistant-1'
      );
      await ensurePermissionRequestOnToolCall(doc, 'req-1', planExitPermission(sessionId));

      const stored = await readStoredPlanExit(doc);
      expect(stored?.kind).toBe('switch_mode');
      expect(stored?.permissionRequest?.requestId).toBe('req-1');
    });
  });

  it('persists switch_mode when the permission request arrives with no prior tool call', async () => {
    await withDoc(async (doc, sessionId) => {
      const persisted = await ensurePermissionRequestOnToolCall(
        doc,
        'req-1',
        planExitPermission(sessionId)
      );

      expect(persisted).toBe(true);
      expect((await readStoredPlanExit(doc))?.kind).toBe('switch_mode');
    });
  });

  it('keeps switch_mode across the whole approval sequence', async () => {
    await withDoc(async (doc, sessionId) => {
      await appendACPNotificationsToAssistantEntry(
        doc,
        [planExitToolCallNotification(sessionId)],
        'assistant-1'
      );
      await ensurePermissionRequestOnToolCall(doc, 'req-1', planExitPermission(sessionId));
      await appendACPNotificationsToAssistantEntry(
        doc,
        [planExitCompletion(sessionId)],
        'assistant-1'
      );

      const stored = await readStoredPlanExit(doc);
      expect(stored?.kind).toBe('switch_mode');
      expect(stored?.status).toBe('completed');
      // The plan itself rides in the tool call's content for Claude, so losing
      // it would empty the region the split exists to reveal.
      expect(JSON.stringify(stored?.content ?? [])).toContain('Do the thing');
    });
  });

  it('falls back to permission request content when tool call has empty content', async () => {
    // Regression test for issue #258: Claude's ExitPlanMode emits tool_call with
    // content: [] during streaming. The plan text arrives later in the permission
    // request. Without sanitizing empty arrays, [] (truthy) wins the ?? fallback
    // and the plan is silently dropped.
    await withDoc(async (doc, sessionId) => {
      // Simulate the streaming phase: tool_call arrives with empty content.
      const emptyContentNotification: AcpSessionNotification = {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: PLAN_EXIT_TOOL_CALL_ID,
          title: 'Ready to code?',
          kind: 'switch_mode',
          status: 'pending',
          content: [],
        } as unknown as AcpSessionNotification['update'],
      };
      await appendACPNotificationsToAssistantEntry(
        doc,
        [emptyContentNotification],
        'assistant-1'
      );

      // Permission request arrives with the plan text in its content.
      const permissionWithPlan = {
        ...planExitPermission(sessionId),
        toolCall: {
          ...planExitPermission(sessionId).toolCall,
          content: [{ type: 'text', text: '# Plan\n1. Do the thing' }],
        },
      } as unknown as RequestPermissionRequest;
      await ensurePermissionRequestOnToolCall(doc, 'req-1', permissionWithPlan);

      const stored = await readStoredPlanExit(doc);
      expect(stored?.kind).toBe('switch_mode');
      // The plan text from the permission request must be retained.
      expect(JSON.stringify(stored?.content ?? [])).toContain('Do the thing');
    });
  });

  it('falls back to permission request content when tool call has undefined content', async () => {
    // Same regression path but content is absent entirely (undefined vs []).
    await withDoc(async (doc, sessionId) => {
      const noContentNotification: AcpSessionNotification = {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: PLAN_EXIT_TOOL_CALL_ID,
          title: 'Ready to code?',
          kind: 'switch_mode',
          status: 'pending',
          // content is intentionally omitted (undefined)
        } as unknown as AcpSessionNotification['update'],
      };
      await appendACPNotificationsToAssistantEntry(
        doc,
        [noContentNotification],
        'assistant-1'
      );

      const permissionWithPlan = {
        ...planExitPermission(sessionId),
        toolCall: {
          ...planExitPermission(sessionId).toolCall,
          content: [{ type: 'text', text: '# Plan\n1. Do the thing' }],
        },
      } as unknown as RequestPermissionRequest;
      await ensurePermissionRequestOnToolCall(doc, 'req-1', permissionWithPlan);

      const stored = await readStoredPlanExit(doc);
      expect(stored?.kind).toBe('switch_mode');
      expect(JSON.stringify(stored?.content ?? [])).toContain('Do the thing');
    });
  });
});
