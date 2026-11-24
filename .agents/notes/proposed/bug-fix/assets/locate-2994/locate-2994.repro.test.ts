import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineId, SessionId, SessionHistoryInput, SessionMeta, WorkspaceId } from '@lody/shared';
import { LodyOperationStore } from '../src/orchestration/operation-store';
import type { InboxInput } from '../src/orchestration/inbox/model';
import { findNextDispatchableUserTurn } from '../src/session/session-dispatch-logic';

/**
 * Issue #2994 locator repro: after a process interrupt, InboxSqlite.activate()
 * marks the interrupted active_input finished=1 — but the dispatcher selection
 * (findNextDispatchableUserTurn Path 3, session-dispatch-logic.ts:366) keeps
 * selecting that turn because meta.processingUserMsgId survives, and the
 * watcher's maybeRepairAlreadyHandledTurn refuses to repair a turn that still
 * holds the claim (session-dispatch-watcher.ts:3481).
 *
 * Every dispatch cycle then runs: select turn → openExecution → begin()
 * rejects the finished input (execution-owner.ts:31) → the settle path in
 * session-execution-service.ts:5150-5183 must clear the claim, or the next
 * cycle selects it again. This file proves the selection half deterministically:
 * a finished input whose processingUserMsgId claim survives IS re-selected —
 * i.e. selection has no finished/inputEnded guard.
 */

const roots: string[] = [];
const stores: LodyOperationStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

const MACHINE = 'machine-1' as MachineId;

const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'A',
    machineId: MACHINE,
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    cliType: 'builtin',
    agentType: 'codex',
    status: { type: 'idle' },
    ...over,
  }) as SessionMeta;

const userTurn = (id: string, status?: string): SessionHistoryInput =>
  ({
    id,
    role: 'user',
    items: [{ type: 'text', text: 'request' }],
    timestamp: '2026-10-12T00:00:00Z',
    status,
    read: status ? status !== 'handled' : false,
    userId: 'user-1',
    inputConfig: { prompt: 'request', chainDepth: 0 },
  }) as SessionHistoryInput;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lody-locate-2994-'));
  roots.push(root);
  const filename = path.join(root, 'operations.sqlite3');
  const store = new LodyOperationStore(filename, () => Date.parse('2026-10-12T00:00:00Z'));
  stores.push(store);
  const input: InboxInput = {
    workspaceId: 'workspace' as WorkspaceId,
    sessionId: 'A' as SessionId,
    userId: 'human',
    inputId: 'user-1',
    kind: 'human',
    config: { prompt: 'request', chainDepth: 0 },
  };
  return { root, filename, store, input };
}

describe('locate #2994: dispatcher re-selects a finished Inbox input after interrupt', () => {
  it('activate() retires the input (finished=1) yet Path 3 selection still returns it while the claim survives', () => {
    const { filename, store, input } = fixture();
    store.inbox.activate('workspace', 'owner-1');
    expect(store.inbox.accept(input)).toBe(true);
    expect(store.inbox.begin(input, 'execution-1')).toBe(true);
    // --- process interrupt: the owner exits without a release receipt ---
    const reopened = new LodyOperationStore(filename, () => Date.parse('2026-10-12T00:00:01Z'));
    stores.push(reopened);
    reopened.inbox.activate('workspace', 'owner-2');
    // Inbox side: the interrupted input is finished, never admissible again.
    expect(reopened.inbox.inputEnded('workspace', 'A', input.inputId)).toBe(true);
    expect(reopened.inbox.begin(input, 'execution-2', 'owner-2')).toBe(false);
    // Dispatcher side: the crash left meta.processingUserMsgId='user-1' and the
    // history entry still 'processing'/'pending'. Path 3 has no finished guard.
    const history = [userTurn('user-1', 'processing')];
    const m = meta({ processingUserMsgId: 'user-1', latestUserMsgId: 'user-1' });
    const selected = findNextDispatchableUserTurn(history, m);
    // BUG: the finished input is selected for dispatch again.
    expect(selected?.id).toBe('user-1');
  });

  it('each selection ends in InboxExecutionRejected — a retry, not a repair, when the claim clear does not land', () => {
    const { filename, store, input } = fixture();
    store.inbox.activate('workspace', 'owner-1');
    expect(store.inbox.accept(input)).toBe(true);
    expect(store.inbox.begin(input, 'execution-1')).toBe(true);
    const reopened = new LodyOperationStore(filename, () => Date.parse('2026-10-12T00:00:01Z'));
    stores.push(reopened);
    reopened.inbox.activate('workspace', 'owner-2');
    const history = [userTurn('user-1', 'processing')];
    // Simulate N dispatch cycles where the execution-side settle
    // (continueInterruptedTurn → markDispatchCancelled, or
    // retireEndedInboxInputTurn → markTurnFailed) did not persist the cleared
    // processingUserMsgId — e.g. upsertSessionMeta no-ops when
    // workspaceDocument.repo.upsertDocMeta is absent or the write races a sync.
    let dispatches = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      const selected = findNextDispatchableUserTurn(history, meta({
        processingUserMsgId: 'user-1',
        latestUserMsgId: 'user-1',
      }));
      if (!selected) break;
      dispatches++;
      // openExecution → begin() → false (finished) → InboxExecutionRejected.
      expect(reopened.inbox.begin({ ...input, inputId: selected.id }, 'exec-' + cycle, 'owner-2'))
        .toBe(false);
    }
    // Every cycle re-dispatches the same finished input: the retry loop.
    expect(dispatches).toBe(5);
  });

  it('clearing the claim is the only thing that ends the loop — selection trusts meta, not inbox_inputs.finished', () => {
    const { filename, store, input } = fixture();
    store.inbox.activate('workspace', 'owner-1');
    expect(store.inbox.accept(input)).toBe(true);
    expect(store.inbox.begin(input, 'execution-1')).toBe(true);
    const reopened = new LodyOperationStore(filename, () => Date.parse('2026-10-12T00:00:01Z'));
    stores.push(reopened);
    reopened.inbox.activate('workspace', 'owner-2');
    const history = [userTurn('user-1', 'failed')];
    // After markTurnFailed: status 'failed' + claim cleared + handled pointer set.
    expect(
      findNextDispatchableUserTurn(history, meta({
        lastHandledUserMsgId: 'user-1',
        latestUserMsgId: 'user-1',
      }))
    ).toBeNull();
    // But a stale meta read (claim still present) still re-selects it even with
    // a terminal status write, because Path 3 ignores entry.status only when
    // status is a non-string... actually status 'failed' IS a string, so Path 1
    // skips it. The loop requires BOTH: status non-terminal AND claim present —
    // exactly what a failed/raced settle write leaves behind.
    expect(
      findNextDispatchableUserTurn([userTurn('user-1', 'pending')], meta({
        processingUserMsgId: 'user-1',
        latestUserMsgId: 'user-1',
      }))?.id
    ).toBe('user-1');
  });
});
