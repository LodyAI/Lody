import { describe, expect, it } from 'vitest';
import {
  getSessionRoomId,
  normalizeCoordinatorTriggersMap,
  parseCoordinatorTriggerWakePrompt,
  schedulePolicyTriggerId,
  SessionStatusFactory,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { SessionDocument, type LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';
import { CoordinatorTriggerService } from './service';

function createTriggerHarness() {
  const coordinatorId = 'coord-1' as SessionId;
  const machineId = 'machine-1' as MachineId;
  const workspaceId = 'workspace-1' as WorkspaceId;
  let now = Date.parse('2026-11-26T02:00:00.000Z');

  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    trace: noop,
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
    setLevel: noop,
    setDebug: noop,
    child: () => logger,
    close: async () => {},
  };

  const metaMap = new Map<SessionId, SessionMeta>([
    [
      coordinatorId,
      {
        id: coordinatorId,
        machineId,
        userId: 'user-owner',
        coordinator: { version: 1 },
        cliType: 'builtin',
        agentType: 'claude',
        project: {
          kind: 'github',
          repoFullName: 'LodyAI/Lody',
          branch: 'main',
        },
        status: SessionStatusFactory.idle(),
        isArchived: false,
      } as SessionMeta,
    ],
  ]);

  const docs = new Map<SessionId, SessionDocument>();
  const repo = {
    listDoc: async () =>
      [...metaMap.values()].map((meta) => ({
        docId: getSessionRoomId(meta.id),
        meta,
      })),
    getDocMeta: async (room: string) => {
      const found = [...metaMap.values()].find((meta) => getSessionRoomId(meta.id) === room);
      return found ? { meta: found } : undefined;
    },
    upsertDocMeta: async (room: string, patch: Partial<SessionMeta>) => {
      const found = [...metaMap.values()].find((meta) => getSessionRoomId(meta.id) === room);
      if (found) metaMap.set(found.id, { ...found, ...patch });
    },
    flush: async () => {},
  };

  const manager = {
    repo,
    isEncryptedWorkspace: () => false,
    signMachineInput: async () => undefined,
    getOrCreateSessionDoc: async (id: SessionId) => {
      let doc = docs.get(id);
      if (!doc) {
        doc = new SessionDocument(repo as never, id, async () => {}, logger);
        composeTestSessionDoc(doc);
        docs.set(id, doc);
      }
      return doc;
    },
  } as unknown as LoroDocumentManager;

  const responses = new Map<string, (req: Request) => Response>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const handler = responses.get(url.pathname);
    if (!handler) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return handler(req);
  };

  const service = new CoordinatorTriggerService({
    workspaceId,
    machineId,
    userId: 'user-owner',
    manager,
    logger,
    location: { kind: 'memory' },
    nowMs: () => now,
    fetchImpl,
    resolveGitHubCredential: async () => ({
      source: 'managed',
      token: 'ghs_test_token',
      expiresAt: now + 3_600_000,
    }),
    invalidateGitHubCredential: () => {},
  });

  return {
    coordinatorId,
    machineId,
    workspaceId,
    manager,
    service,
    responses,
    advanceBy(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe('CoordinatorTriggerService & GitHub connector', () => {
  it('seeds initial watermark without backlog flood, filters bots/labels, handles 304 ETag, and wakes coordinator', async () => {
    const h = createTriggerHarness();
    let etagCalls = 0;

    // Pre-existing historical issue before enablement — should be skipped by seedCursor
    h.responses.set('/repos/LodyAI/Lody/issues', (req) => {
      if (req.headers.get('If-None-Match') === '"etag-v2"') {
        etagCalls += 1;
        return new Response(null, { status: 304 });
      }
      return new Response(
        JSON.stringify([
          {
            number: 10,
            title: 'Historical issue before trigger enabled',
            created_at: '2026-11-26T01:00:00.000Z',
            updated_at: '2026-11-26T01:00:00.000Z',
            html_url: 'https://github.com/LodyAI/Lody/issues/10',
            user: { login: 'older-user', type: 'User' },
            labels: [{ name: 'bug' }],
          },
          {
            number: 42,
            title: 'Crash when opening coordinator observability on Windows',
            body: 'Steps to reproduce: click header button.',
            created_at: '2026-11-26T02:01:10.000Z',
            updated_at: '2026-11-26T02:01:10.000Z',
            html_url: 'https://github.com/LodyAI/Lody/issues/42',
            user: { login: 'alice', type: 'User' },
            labels: [{ name: 'bug' }],
          },
          {
            number: 43,
            title: 'Automated dependency bump issue',
            created_at: '2026-11-26T02:01:12.000Z',
            updated_at: '2026-11-26T02:01:12.000Z',
            html_url: 'https://github.com/LodyAI/Lody/issues/43',
            user: { login: 'dependabot[bot]', type: 'Bot' },
            labels: [{ name: 'bug' }],
          },
          {
            number: 44,
            title: 'Feature idea without bug label',
            created_at: '2026-11-26T02:01:15.000Z',
            updated_at: '2026-11-26T02:01:15.000Z',
            html_url: 'https://github.com/LodyAI/Lody/issues/44',
            user: { login: 'bob', type: 'User' },
            labels: [{ name: 'enhancement' }],
          },
        ]),
        { status: 200, headers: { ETag: '"etag-v2"' } }
      );
    });

    const upsertRes = await h.service.handleAction(h.coordinatorId, {
      kind: 'upsert',
      payload: {
        triggerId: 'trg_gh_bugs',
        title: 'GitHub Bug Monitor',
        enabled: true,
        config: {
          pluginId: 'github',
          repoFullName: 'LodyAI/Lody',
          events: ['issue.opened'],
          labels: ['bug'],
          excludeBots: true,
          pollIntervalSec: 60,
        },
        instruction: 'Summarize new bug issues for me.',
        policy: { mode: 'summarize_and_notify', maxChildrenPerRun: 2 },
      },
    });
    expect(upsertRes.ok).toBe(true);

    const coordDoc = await h.manager.getOrCreateSessionDoc(h.coordinatorId);
    const syncedTriggers = normalizeCoordinatorTriggersMap((await coordDoc.getDocState()).triggers);
    expect(syncedTriggers.trg_gh_bugs).toMatchObject({
      id: 'trg_gh_bugs',
      pluginId: 'github',
      title: 'GitHub Bug Monitor',
      enabled: true,
      policyMode: 'summarize_and_notify',
    });

    // Advance past pollIntervalSec (60s) -> polls delta & stages #42 only
    h.advanceBy(61_000);
    await h.service.runPass();
    expect((await coordDoc.getDocState()).mq).toHaveLength(0);

    // Advance past 10s coalescing window -> flushes wake message into coordinator SessionDoc.mq
    h.advanceBy(11_000);
    await h.service.runPass();

    const mq = (await coordDoc.getDocState()).mq;
    expect(mq).toHaveLength(1);
    const wakeItem = mq[0]!;
    const header = parseCoordinatorTriggerWakePrompt(wakeItem.acpSessionConfig.prompt);
    expect(header).toMatchObject({
      triggerId: 'trg_gh_bugs',
      pluginId: 'github',
      title: 'GitHub Bug Monitor',
      policyMode: 'summarize_and_notify',
      eventCount: 1,
      events: [
        {
          eventKind: 'issue.opened',
          title: '[Issue #42] Crash when opening coordinator observability on Windows',
          label: 'LodyAI/Lody#42',
        },
      ],
    });

    // Default summarize_and_notify blocks child delegation on this turn
    await expect(
      h.service.assertDelegationAllowed({
        sessionId: h.coordinatorId,
        sourceTurnId: wakeItem.userTurnId,
        requestedCount: 1,
      })
    ).rejects.toThrow(/Notify-Only/i);

    // Next poll hits If-None-Match '"etag-v2"' -> 304 Not Modified, zero new queue items
    h.advanceBy(65_000);
    await h.service.runPass();
    h.advanceBy(15_000);
    await h.service.runPass();
    expect(etagCalls).toBeGreaterThan(0);
    expect((await coordDoc.getDocState()).mq).toHaveLength(1);

    h.service.dispose();
  });

  it('enforces auto_delegate role allowlist & maxChildrenPerRun budget and defaults coordinator schedules to Notify Only', async () => {
    const h = createTriggerHarness();
    h.responses.set('/repos/LodyAI/Lody/issues', () => {
      return new Response(
        JSON.stringify([
          {
            number: 99,
            title: 'Auto-triaged production regression',
            created_at: '2026-11-26T02:02:00.000Z',
            updated_at: '2026-11-26T02:02:00.000Z',
            html_url: 'https://github.com/LodyAI/Lody/issues/99',
            user: { login: 'carol', type: 'User' },
            labels: [],
          },
        ]),
        { status: 200 }
      );
    });

    await h.service.handleAction(h.coordinatorId, {
      kind: 'upsert',
      payload: {
        triggerId: 'trg_auto',
        title: 'Auto Triage Trigger',
        enabled: true,
        config: {
          pluginId: 'github',
          repoFullName: 'LodyAI/Lody',
          events: ['issue.opened'],
          excludeBots: true,
          pollIntervalSec: 60,
        },
        instruction: 'Investigate new regressions.',
        policy: {
          mode: 'auto_delegate',
          allowedRoleIds: ['role-triage'],
          maxChildrenPerRun: 2,
        },
      },
    });

    h.advanceBy(61_000);
    await h.service.runPass();
    h.advanceBy(11_000);
    await h.service.runPass();

    const coordDoc = await h.manager.getOrCreateSessionDoc(h.coordinatorId);
    const wakeTurnId = (await coordDoc.getDocState()).mq[0]!.userTurnId;

    // Disallowed or missing Role ID is rejected
    await expect(
      h.service.assertDelegationAllowed({
        sessionId: h.coordinatorId,
        sourceTurnId: wakeTurnId,
        requestedCount: 1,
      })
    ).rejects.toThrow(/Role/i);

    await expect(
      h.service.assertDelegationAllowed({
        sessionId: h.coordinatorId,
        sourceTurnId: wakeTurnId,
        requestedCount: 1,
        requestedRoleIds: ['role-unauthorized'],
      })
    ).rejects.toThrow(/Role/i);

    // Allowed Role ID succeeds up to maxChildrenPerRun = 2, then blocks 3rd child
    await expect(
      h.service.assertDelegationAllowed({
        sessionId: h.coordinatorId,
        sourceTurnId: wakeTurnId,
        requestedCount: 2,
        requestedRoleIds: ['role-triage', 'role-triage'],
      })
    ).resolves.toBeUndefined();

    await expect(
      h.service.assertDelegationAllowed({
        sessionId: h.coordinatorId,
        sourceTurnId: wakeTurnId,
        requestedCount: 1,
        requestedRoleIds: ['role-triage'],
      })
    ).rejects.toThrow(/TRIGGER_BUDGET_EXCEEDED/i);

    // Simulate a coordinator-targeted Schedule turn in history
    await coordDoc.sessionData.commands.appendTurn({
      id: 'sched-turn-1',
      role: 'user',
      userId: 'user-owner',
      timestamp: new Date(h.now()).toISOString(),
      status: 'handled',
      finished: true,
      items: [{ type: 'text', text: 'Daily check-in' }],
      inputConfig: {
        prompt: 'Daily check-in',
      },
      scheduleRun: {
        scheduleId: 'sched-daily',
        turnId: 'sched-turn-1',
        title: 'Daily Check-in',
      },
    } as never);

    // Without explicit grant, coordinator Schedule defaults to summarize_and_notify
    await expect(
      h.service.assertDelegationAllowed({
        sessionId: h.coordinatorId,
        sourceTurnId: 'sched-turn-1',
        requestedCount: 1,
      })
    ).rejects.toThrow(/Notify-Only/i);

    // Grant auto_delegate to sched:sched-daily -> subsequent Schedule turn can delegate
    await h.service.handleAction(h.coordinatorId, {
      kind: 'set_policy',
      triggerId: schedulePolicyTriggerId('sched-daily'),
      scheduleId: 'sched-daily',
      title: 'Daily Check-in',
      policy: { mode: 'auto_delegate', maxChildrenPerRun: 2 },
    });

    await coordDoc.sessionData.commands.appendTurn({
      id: 'sched-turn-2',
      role: 'user',
      userId: 'user-owner',
      timestamp: new Date(h.now()).toISOString(),
      status: 'handled',
      finished: true,
      items: [{ type: 'text', text: 'Daily check-in 2' }],
      inputConfig: {
        prompt: 'Daily check-in 2',
      },
      scheduleRun: {
        scheduleId: 'sched-daily',
        turnId: 'sched-turn-2',
        title: 'Daily Check-in',
      },
    } as never);

    await expect(
      h.service.assertDelegationAllowed({
        sessionId: h.coordinatorId,
        sourceTurnId: 'sched-turn-2',
        requestedCount: 1,
      })
    ).resolves.toBeUndefined();

    h.service.dispose();
  });
});
