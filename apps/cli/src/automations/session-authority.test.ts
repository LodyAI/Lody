import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { evaluateAutomationProgram, loadAutomationPrograms } from './programs/quickjs';
import { readAutomationContext } from './context/reads-legacy';
import { observePullRequests } from './sources/pull-requests';
import { observeWorkflows } from './sources/workflows';
import {
  getSessionRoomId,
  SessionStatusFactory,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { SessionDocument, type LoroDocumentManager } from '@/lib/loro/doc';
import { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { SessionExecutionService } from '@/session/session-execution-service';
import type { Logger } from '@/utils/logger';
import { composeTestSessionDoc } from '../../tests/session-doc-fixture';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import { createSessionBackend } from '@/session/session-backend';
import { AutomationLedger } from './storage/ledger';
import { AutomationSessionActionsLegacy } from './actions/session-actions-legacy';

function groupFixture() {
  const rootId = 'root' as SessionId;
  const childId = 'child' as SessionId;
  const meta = new Map<SessionId, SessionMeta>(
    [rootId, childId].map((id) => [
      id,
      {
        id,
        machineId: 'machine',
        userId: 'user',
        cliType: 'builtin',
        agentType: 'synthetic',
        status: SessionStatusFactory.idle(),
        isArchived: false,
        ...(id === childId ? { parentSessionId: rootId } : {}),
      } as SessionMeta,
    ])
  );
  const barriers = new Set<SessionId>();
  const writes: string[] = [];
  let failRootWrite = false;
  const repo = {
    listDoc: async () =>
      [...meta.values()].map((value) => ({ docId: getSessionRoomId(value.id), meta: value })),
    getDocMeta: async (room: string) => {
      const value = [...meta.values()].find((row) => getSessionRoomId(row.id) === room);
      return value ? { meta: value } : undefined;
    },
    upsertDocMeta: async (room: string, patch: Partial<SessionMeta>) => {
      const value = [...meta.values()].find((row) => getSessionRoomId(row.id) === room);
      if (!value) throw new Error('missing fixture session');
      if (failRootWrite && value.id === rootId) throw new Error('root persistence failed');
      meta.set(value.id, { ...value, ...patch });
      writes.push(value.id);
    },
    flush: async () => {},
  };
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
  const docs = new Map<SessionId, SessionDocument>();
  const manager = {
    repo,
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
  const authority = new SessionAutomationAuthority({
    manager,
    machineId: 'machine',
    execution: {
      acceptAutomationInput: async () => true,
      automationInputDisposition: () => 'unsubmitted',
      hasBlockedAutomationExecution: () => false,
      getExecutionSnapshot: (id: SessionId) => ({ hasRewriteBarrier: barriers.has(id) }),
      guardAutomationAction: async (
        _ids: SessionId[],
        _user: string,
        body: () => Promise<unknown>
      ) => body(),
      tryAcquireSessionRewriteBarrier: (id: SessionId) => {
        if (barriers.has(id)) return undefined;
        barriers.add(id);
        return () => {
          barriers.delete(id);
        };
      },
    } as unknown as SessionExecutionService,
    hasOtherWork: () => false,
    hasGoal: async () => false,
    nativeActivity: () => 'idle',
    author: () => 'user',
  });
  return {
    rootId,
    childId,
    authority,
    manager,
    meta,
    writes,
    barriers,
    failRoot: (value: boolean) => {
      failRootWrite = value;
    },
  };
}
const allowed = async () => ({ value: 'yes' as const, reason: 'current' });

describe('Automation Session authority', () => {
  it('delivers a JS-selected CI failure through the existing Session queue with Host-owned evidence', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const f = groupFixture();
    const ledger = new AutomationLedger({ kind: 'memory' }, 'workspace', 'machine');
    const head = 'a'.repeat(40);
    const prUrl = 'https://github.com/owner/repo/pull/1';
    const previous = f.meta.get(f.rootId);
    if (!previous) throw new Error('missing fixture');
    const meta = { ...previous, pullRequests: [{ url: prUrl, status: 'open' as const }] };
    f.meta.set(f.rootId, meta);
    try {
      const program = `async ({ctx}) => {
        const {value} = await ctx.read('github.workflowRuns');
        if (value.status !== 'observed') return false;
        const failed = value.pullRequests.flatMap(pr => pr.runs).filter(run => run.conclusion === 'failure');
        return failed.length ? {resumeText:'Fix this CI failure',payload:failed} : false;
      }`;
      const wait = ledger.registerWait({ program, intervalMs: 1000 }, f.rootId, 'user', 1000);
      ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 1000);
      const module = await Effect.runPromise(loadAutomationPrograms);
      const read = (input: import('@lody/shared/automations').AutomationReadRequest) =>
        readAutomationContext({
          ledger,
          manager: f.manager,
          authority: f.authority,
          wait,
          input,
          now: 1000,
        });
      expect(
        await evaluateAutomationProgram(
          module,
          program,
          { sessionId: f.rootId, workspaceId: 'workspace', now: 1000 },
          read
        )
      ).toBe(false);
      observePullRequests(
        ledger,
        meta,
        'owner/repo',
        [
          {
            number: 1,
            url: prUrl,
            status: 'open',
            headRefName: 'feature',
            headSha: head,
            headRepository: 'owner/repo',
            updatedAt: new Date(1000).toISOString(),
            ciState: 'f',
            mergeState: null,
          },
        ],
        1000
      );
      observeWorkflows(
        ledger,
        meta,
        'owner/repo',
        head,
        [
          {
            runId: 7,
            attempt: 2,
            workflowId: 3,
            headSha: head,
            branch: 'feature',
            status: 'completed',
            conclusion: 'failure',
            updatedAt: 1000,
            url: 'https://github.com/owner/repo/actions/runs/7',
            repository: 'owner/repo',
            headRepository: 'owner/repo',
            prNumbers: [1],
          },
        ],
        false,
        1000
      );
      const result = await evaluateAutomationProgram(
        module,
        program,
        { sessionId: f.rootId, workspaceId: 'workspace', now: 1000 },
        read
      );
      const matched = ledger.finishWait(wait, result, 1000);
      const receipt = matched?.invocationId ? ledger.receipt(matched.invocationId) : undefined;
      if (!receipt) throw new Error('missing receipt');
      const adapter = new AutomationSessionActionsLegacy({
        lody: {
          documentManager: f.manager,
          getAutomationSessionAuthority: () => f.authority,
          hasAutomationSessionWork: () => false,
        } as unknown as Lody,
        auth: { userId: 'user', machineId: 'machine' } as AuthContext,
        workspace: { id: 'workspace' } as WorkspaceSummary,
        ledger,
        condition: allowed,
        capacity: allowed,
      });
      expect(await adapter.authorize(receipt)).toMatchObject({ value: 'yes' });
      const prepared = ledger.update(
        receipt.id,
        receipt.state,
        await adapter.prepare(receipt),
        1000
      );
      if (!prepared) throw new Error('missing preparation');
      const claimed = ledger.update(prepared.id, prepared.state, { state: 'submitting' }, 1000);
      if (!claimed) throw new Error('missing claim');
      expect(await adapter.submit(claimed)).toEqual({ state: 'queued' });
      expect(await adapter.reconcile(claimed)).toEqual({ state: 'queued' });
      const queue = await (
        await createSessionBackend(await f.manager.getOrCreateSessionDoc(f.rootId))
      ).getMessageQueue();
      expect(queue).toMatchObject([
        {
          userTurnId: receipt.turnId,
          operationId: receipt.id,
          acpSessionConfig: {
            _lodyAutomation: {
              invocationId: receipt.id,
              expectedHeads: [{ repository: 'owner/repo', headSha: head }],
            },
          },
        },
      ]);
      expect(queue[0]?.task).toContain('Fix this CI failure');
      expect(JSON.parse(queue[0]?.task.split('\n').at(-1) ?? 'null')).toMatchObject([
        { runId: 7, attempt: 2 },
      ]);
      observeWorkflows(
        ledger,
        meta,
        'owner/repo',
        head,
        [
          {
            runId: 7,
            attempt: 3,
            workflowId: 3,
            headSha: head,
            branch: 'feature',
            status: 'in_progress',
            conclusion: null,
            updatedAt: 1001,
            url: 'https://github.com/owner/repo/actions/runs/7',
            repository: 'owner/repo',
            headRepository: 'owner/repo',
            prNumbers: [1],
          },
        ],
        false,
        1001
      );
      expect(await adapter.authorize(claimed)).toMatchObject({
        value: 'no',
        terminalState: 'superseded',
      });
    } finally {
      now.mockRestore();
      ledger.close();
    }
  });

  it('reconciles a lost queue acknowledgement without duplicating the accepted external-event turn', async () => {
    const f = groupFixture();
    const ledger = new AutomationLedger({ kind: 'memory' }, 'workspace', 'machine');
    try {
      const invocation = {
        target: {
          kind: 'existing' as const,
          sessionId: f.rootId,
          onUnavailable: 'blocked' as const,
        },
        input: { kind: 'external_event' as const, ref: 'event' },
        ifBusy: 'enqueue' as const,
      };
      ledger.upsert(
        {
          id: 'rule',
          name: 'response',
          scope: { workspaceId: 'workspace', sessionId: f.rootId },
          selector: { types: ['timer.due'] },
          enabled: true,
          handler: { kind: 'agent', invocation },
          grants: {
            actions: ['agent.invoke'],
            sessionIds: [f.rootId],
            agentRoleIds: [],
            bindingIds: [],
            allowLinkedSession: false,
            allowCapacityAttempt: false,
          },
          budget: { maxActionsPerEvent: 2, maxInvocationsPerCorrelation: 2, maxDepth: 2 },
        },
        'user',
        1
      );
      ledger.publish({
        id: 'event',
        source: 'timer',
        type: 'timer.due',
        version: 1,
        subject: 'due',
        observedAt: 2,
        scope: { workspaceId: 'workspace', sessionId: f.rootId },
        data: { text: 'Untrusted event content' },
        provenance: 'timer',
        completeness: 'observed',
        depth: 0,
      });
      const delivery = ledger.deliveries()[0];
      if (!delivery) throw new Error('Missing delivery');
      const accepted = ledger.accept(
        delivery,
        { key: 'invoke', action: { kind: 'agent.invoke', parameters: invocation } },
        3
      );
      const adapter = new AutomationSessionActionsLegacy({
        lody: {
          documentManager: f.manager,
          getAutomationSessionAuthority: () => f.authority,
          hasAutomationSessionWork: () => false,
        } as unknown as Lody,
        auth: { userId: 'user', machineId: 'machine' } as AuthContext,
        workspace: { id: 'workspace' } as WorkspaceSummary,
        ledger,
        condition: allowed,
        capacity: allowed,
      });
      const prepared = ledger.update(
        accepted.id,
        accepted.state,
        await adapter.prepare(accepted),
        4
      );
      if (!prepared) throw new Error('Missing prepared invocation');
      const submitting = ledger.update(prepared.id, prepared.state, { state: 'submitting' }, 5);
      if (!submitting) throw new Error('Missing submission fence');
      expect(await adapter.submit(submitting)).toEqual({ state: 'queued' });
      // Leave the receipt at submitting: the queue commit happened but its acknowledgement was lost.
      const backend = await createSessionBackend(await f.manager.getOrCreateSessionDoc(f.rootId));
      expect(await adapter.reconcile(submitting)).toEqual({ state: 'queued' });
      expect(await adapter.submit(submitting)).toEqual({ state: 'queued' });
      const queue = await backend.getMessageQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({
        operationId: submitting.id,
        userTurnId: submitting.turnId,
        acpSessionConfig: {
          _lodyAutomation: { invocationId: submitting.id, authorizationUserId: 'user' },
        },
      });
      expect(queue[0]?.task).toContain('untrusted reference data');
      expect((await backend.readHistory()).filter((turn) => turn.id === submitting.turnId)).toEqual(
        []
      );
    } finally {
      ledger.close();
    }
  });
  it('rechecks queued input after acquiring the group barriers', async () => {
    const f = groupFixture();
    expect(
      await f.authority.archive(f.rootId, 'user', async () => {
        const doc = await f.manager.getOrCreateSessionDoc(f.childId);
        await doc.pushMessageQueue({
          userTurnId: 'new-user',
          userId: 'user',
          task: 'new work',
          timestamp: '2026-10-26T00:00:00Z',
          isEditing: false,
          editingStartedAt: undefined,
          acpSessionConfig: { prompt: 'new work', cliType: 'builtin', agentType: 'synthetic' },
        });
        return allowed();
      })
    ).toMatchObject({ value: 'no', reason: 'queue_pending' });
    expect([...f.meta.values()].every((meta) => !meta.isArchived)).toBe(true);
    expect(f.barriers.size).toBe(0);
  });
  it('does not report a partially persisted group as archived and can finish it idempotently', async () => {
    const f = groupFixture();
    f.failRoot(true);
    await expect(f.authority.archive(f.rootId, 'user', allowed)).rejects.toThrow(
      'root persistence failed'
    );
    expect(f.meta.get(f.childId)?.isArchived).toBe(true);
    expect(f.meta.get(f.rootId)?.isArchived).toBe(false);
    expect(await f.authority.archived(f.rootId)).toBe(false);
    expect(f.barriers.size).toBe(0);
    f.failRoot(false);
    expect(await f.authority.archive(f.rootId, 'user', allowed)).toMatchObject({ value: 'yes' });
    expect(await f.authority.archived(f.rootId)).toBe(true);
    expect(f.writes.at(-1)).toBe(f.rootId);
  });
  it('treats retained recovery work as busy without making a maintenance invocation wait for itself', async () => {
    const f = groupFixture();
    f.authority.setPendingWork((id, excluding) => id === f.rootId && excluding !== 'compact');
    expect(await f.authority.settled(f.rootId, 'user')).toMatchObject({
      value: 'no',
      reason: 'automation_work_pending',
    });
    expect(await f.authority.settled(f.rootId, 'user', 'compact')).toMatchObject({ value: 'yes' });
  });
});
