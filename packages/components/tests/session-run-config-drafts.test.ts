import { createStore } from 'jotai';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionRoomId, type SessionHistory, type SessionId } from '@lody/shared';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import {
  captureSessionRunConfigDraftAcceptance,
  clearSessionRunConfigDraftsAtom,
  editSessionRunConfigDraftAtom,
  getSessionRunConfigDraftKey,
  readSessionRunConfigDraftEdits,
  registerSessionRunConfigDraftLeaseAtom,
  releaseSessionRunConfigDraftLeaseAtom,
  sessionRunConfigDraftsAtom,
  setSessionRunConfigDraftAccountAtom,
  type SessionRunConfigDraftLease,
  type SessionRunConfigDraftScope,
} from '../src/atoms/session-run-config-drafts';
import { buildAcpSessionConfigCandidates } from '../src/lib/acp-session-config-selection';
import { acceptSessionUserTurn } from '../src/lib/session-send-admission';
import { createPendingSessionSends } from '../src/lib/session-pending-sends';
import { writeUserTurn } from '../src/lib/session-send-delivery';
import type { SessionAttachmentDraft } from '../src/lib/session-attachment-draft';

const scope = (
  overrides: Partial<SessionRunConfigDraftScope> = {}
): SessionRunConfigDraftScope => ({
  accountId: 'synthetic-account',
  workspaceId: 'synthetic-workspace',
  sessionId: 'synthetic-session',
  targetKey: 'builtin:codex',
  ...overrides,
});

function admissionFixture() {
  const sessionId = scope().sessionId as SessionId;
  const started = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  const written = new Map<SessionId, SessionHistory[]>();
  const runtime = {
    workspaceId: scope().workspaceId,
    pendingSends: null,
    repo: {
      getDocMeta: async (roomId: string) =>
        roomId === getSessionRoomId(sessionId)
          ? { meta: { id: sessionId, machineId: 'synthetic-machine' } }
          : undefined,
    },
    writer: {
      appendSessionTurn: async (target: SessionId, entry: SessionHistory) => {
        started.resolve();
        await write.promise;
        written.set(target, [...(written.get(target) ?? []), entry]);
        return 'direct' as const;
      },
    },
  } as unknown as WorkspaceRuntime;
  const entry: SessionHistory = {
    id: 'synthetic-local-turn',
    role: 'user',
    userId: scope().accountId,
    timestamp: '2026-10-07T00:00:00.000Z',
    status: 'pending',
    items: [{ type: 'text', text: 'Synthetic message' }],
    inputConfig: { configOptionValues: { 'fast-mode': false } },
    read: false,
    fileDiff: [],
    finished: true,
  };
  const attachment: SessionAttachmentDraft = {
    id: 'synthetic-attachment',
    kind: 'file',
    source: new Blob(['synthetic']),
    name: 'synthetic.txt',
    mimeType: 'text/plain',
    lastModified: 0,
  };
  const admit = (
    onAccepted: (() => void) | undefined,
    attachments?: SessionAttachmentDraft[],
    targetRuntime = runtime
  ) =>
    acceptSessionUserTurn(
      targetRuntime,
      sessionId,
      entry,
      { kind: 'history' },
      undefined,
      undefined,
      attachments,
      onAccepted
    );
  return { runtime, sessionId, entry, attachment, started, write, written, admit };
}

describe('sparse existing-session run-config drafts', () => {
  let store: ReturnType<typeof createStore>;
  const mount = (target = scope()) => store.set(registerSessionRunConfigDraftLeaseAtom, target);
  const draft = (target = scope()) =>
    store.get(sessionRunConfigDraftsAtom).get(getSessionRunConfigDraftKey(target));
  const config = (lease: SessionRunConfigDraftLease, value: boolean, configId = 'fast-mode') =>
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'config', configId, value } });

  beforeEach(() => {
    store = createStore();
    store.set(setSessionRunConfigDraftAccountAtom, scope().accountId);
  });

  it('retains no map entries after 1,000 read-only session visits', () => {
    const initial = store.get(sessionRunConfigDraftsAtom);
    for (let index = 0; index < 1_000; index += 1) {
      const target = scope({ sessionId: `read-only-${index}` });
      const lease = mount(target);
      expect(readSessionRunConfigDraftEdits(draft(target))).toEqual({ configOptions: {} });
      expect(captureSessionRunConfigDraftAcceptance(store, lease, {})).toBeUndefined();
      store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    }
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(initial);
  });

  it('retains no draft or turn bookkeeping through 1,000 changing turn configurations', () => {
    const lease = mount();
    const initial = store.get(sessionRunConfigDraftsAtom);
    for (let index = 0; index < 1_000; index += 1) {
      const preferences = {
        modelId: `synthetic-model-${index}`,
        configOptionValues: { 'fast-mode': index % 2 === 0 },
      };
      expect(
        buildAcpSessionConfigCandidates({
          edits: readSessionRunConfigDraftEdits(draft()),
          preferences,
        })
      ).toEqual({ modeId: null, ...preferences });
      expect(captureSessionRunConfigDraftAcceptance(store, lease, preferences)).toBeUndefined();
    }
    store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(initial);
  });

  it('stores explicit false and makes every same-valued edit a new field generation', () => {
    const lease = mount();
    config(lease, false);
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'mode', value: 'agent' } });
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'model', value: 'gpt-6' } });
    const first = draft()!;
    expect(readSessionRunConfigDraftEdits(first)).toEqual({
      mode: { value: 'agent' },
      model: { value: 'gpt-6' },
      configOptions: { 'fast-mode': false },
    });

    config(lease, false);
    const second = draft()!;
    expect(second.configOptions['fast-mode']).not.toBe(first.configOptions['fast-mode']);
    expect(second.mode).toBe(first.mode);
    expect(second.model).toBe(first.model);
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'mode', value: 'agent' } });
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'model', value: 'gpt-6' } });
    expect(draft()!.mode).not.toBe(first.mode);
    expect(draft()!.model).not.toBe(first.model);
    expect(draft()).toEqual(first);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(1);
  });

  it('keeps captured drafts until local acceptance, then deletes the last field and map entry', () => {
    const lease = mount();
    config(lease, false);
    const before = store.get(sessionRunConfigDraftsAtom);
    const accept = captureSessionRunConfigDraftAcceptance(store, lease, {
      configOptionValues: { 'fast-mode': false },
    });
    expect(accept).toBeTypeOf('function');
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(before);

    accept!();
    expect(store.get(sessionRunConfigDraftsAtom).has(getSessionRunConfigDraftKey(scope()))).toBe(
      false
    );
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    const empty = store.get(sessionRunConfigDraftsAtom);
    accept!();
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(empty);
  });

  it('acknowledges only captured fields and leaves changed and newly added fields outstanding', () => {
    const lease = mount();
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'mode', value: 'agent' } });
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'model', value: 'gpt-6' } });
    config(lease, false);
    const accept = captureSessionRunConfigDraftAcceptance(store, lease, {
      modeId: 'agent',
      modelId: 'gpt-6',
      configOptionValues: { 'fast-mode': false },
    });
    store.set(editSessionRunConfigDraftAtom, {
      lease,
      edit: { type: 'model', value: 'next-model' },
    });
    config(lease, true, 'plan_mode');
    accept!();

    expect(draft()).toEqual({
      scope: scope(),
      model: { value: 'next-model' },
      configOptions: { plan_mode: { value: true } },
    });
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(1);
  });

  it('preserves newer same-valued mode, model and boolean edits after an older send is accepted', () => {
    const lease = mount();
    const write = () => {
      store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'mode', value: 'agent' } });
      store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'model', value: 'gpt-6' } });
      config(lease, false);
    };
    const inputConfig = {
      modeId: 'agent',
      modelId: 'gpt-6',
      configOptionValues: { 'fast-mode': false },
    };
    write();
    const acceptOld = captureSessionRunConfigDraftAcceptance(store, lease, inputConfig);
    write();
    const next = store.get(sessionRunConfigDraftsAtom);
    acceptOld!();
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(next);
    expect(readSessionRunConfigDraftEdits(draft())).toEqual({
      mode: { value: 'agent' },
      model: { value: 'gpt-6' },
      configOptions: { 'fast-mode': false },
    });

    captureSessionRunConfigDraftAcceptance(store, lease, inputConfig)!();
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
  });

  it('filters divergent dispatch overrides and omitted capability fields out of acceptance', () => {
    const lease = mount();
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'mode', value: 'read-only' } });
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'model', value: 'gpt-6' } });
    config(lease, false);
    config(lease, true, 'plan_mode');
    const accept = captureSessionRunConfigDraftAcceptance(store, lease, {
      modeId: 'agent',
      modelId: 'gpt-6',
      configOptionValues: { plan_mode: false },
    });
    accept!();
    expect(draft()).toEqual({
      scope: scope(),
      mode: { value: 'read-only' },
      configOptions: { 'fast-mode': { value: false }, plan_mode: { value: true } },
    });
  });

  it('never consumes a newer draft when a stale send callback freezes the wrong value', () => {
    const lease = mount();
    config(lease, false);
    const frozenInput = { configOptionValues: { 'fast-mode': false } };
    config(lease, true);
    const outstanding = store.get(sessionRunConfigDraftsAtom);

    // The callback was rendered before the edit, but captures the live draft at send time.
    const accept = captureSessionRunConfigDraftAcceptance(store, lease, frozenInput);
    expect(accept).toBeUndefined();
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
    expect(draft()!.configOptions['fast-mode']).toEqual({ value: true });
  });

  it('keeps local edits when remote turns change or match their values', () => {
    const lease = mount();
    config(lease, false);
    const outstanding = store.get(sessionRunConfigDraftsAtom);
    for (const value of [true, false, true, false]) {
      expect(
        buildAcpSessionConfigCandidates({
          edits: readSessionRunConfigDraftEdits(draft()),
          preferences: { configOptionValues: { 'fast-mode': value } },
          runtimePreferences: { configOptionValues: { 'fast-mode': value } },
        }).configOptionValues
      ).toEqual({ 'fast-mode': false });
    }
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
  });

  it('replaces config generations without replacing mode or model, and removes empty entries', () => {
    const lease = mount();
    config(lease, false);
    config(lease, true, 'plan_mode');
    store.set(editSessionRunConfigDraftAtom, { lease, edit: { type: 'model', value: 'gpt-6' } });
    const first = draft()!;
    const accept = captureSessionRunConfigDraftAcceptance(store, lease, {
      configOptionValues: { 'fast-mode': false, plan_mode: true },
    });
    store.set(editSessionRunConfigDraftAtom, {
      lease,
      edit: { type: 'replace-config', values: { 'fast-mode': false } },
    });
    const next = store.get(sessionRunConfigDraftsAtom);
    expect(draft()!.configOptions).toEqual({ 'fast-mode': { value: false } });
    expect(draft()!.configOptions['fast-mode']).not.toBe(first.configOptions['fast-mode']);
    expect(draft()!.model).toBe(first.model);
    accept!();
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(next);

    captureSessionRunConfigDraftAcceptance(store, lease, { modelId: 'gpt-6' })!();
    store.set(editSessionRunConfigDraftAtom, {
      lease,
      edit: { type: 'replace-config', values: {} },
    });
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    store.set(editSessionRunConfigDraftAtom, {
      lease,
      edit: { type: 'replace-config', values: {} },
    });
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
  });

  it('preserves drafts across workspace navigation and scopes matching session ids by target', () => {
    const targets = [
      scope(),
      scope({ workspaceId: 'other-workspace' }),
      scope({ targetKey: 'builtin:claude' }),
    ];
    for (const [index, target] of targets.entries()) {
      const lease = mount(target);
      config(lease, index % 2 === 0);
      store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    }
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(3);
    for (const [index, target] of targets.entries()) {
      const lease = mount(target);
      expect(readSessionRunConfigDraftEdits(draft(target)).configOptions).toEqual({
        'fast-mode': index % 2 === 0,
      });
      store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    }
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(3);
  });

  it('allows accepted sends after unmount but prevents unmounted edit callbacks from writing', () => {
    const lease = mount();
    config(lease, false);
    const accept = captureSessionRunConfigDraftAcceptance(store, lease, {
      configOptionValues: { 'fast-mode': false },
    });
    store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    config(lease, true);
    expect(draft()!.configOptions).toEqual({ 'fast-mode': { value: false } });
    accept!();
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    config(lease, true);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
  });

  it('clears only deleted sessions and invalidates all of their mounted edit callbacks', () => {
    const targets = [
      scope(),
      scope({ targetKey: 'builtin:claude' }),
      scope({ sessionId: 'keep-session' }),
      scope({ workspaceId: 'keep-workspace' }),
    ];
    const leases = targets.map((target) => mount(target));
    for (const lease of leases) config(lease, false);
    const beforeEmptyClear = store.get(sessionRunConfigDraftsAtom);
    store.set(clearSessionRunConfigDraftsAtom, {
      workspaceId: scope().workspaceId,
      sessionIds: [],
    });
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(beforeEmptyClear);
    expect(leases.every((lease) => lease.active)).toBe(true);
    const acceptDeleted = captureSessionRunConfigDraftAcceptance(store, leases[0], {
      configOptionValues: { 'fast-mode': false },
    });
    store.set(clearSessionRunConfigDraftsAtom, {
      workspaceId: scope().workspaceId,
      sessionIds: [scope().sessionId],
    });
    expect([...store.get(sessionRunConfigDraftsAtom).keys()].sort()).toEqual(
      targets.slice(2).map(getSessionRunConfigDraftKey).sort()
    );
    for (const lease of leases) config(lease, true);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(2);
    expect(draft(targets[0])).toBeUndefined();
    expect(draft(targets[1])).toBeUndefined();
    expect(draft(targets[2])!.configOptions['fast-mode']).toEqual({ value: true });
    expect(draft(targets[3])!.configOptions['fast-mode']).toEqual({ value: true });

    const replacement = mount();
    config(replacement, false);
    const outstanding = store.get(sessionRunConfigDraftsAtom);
    acceptDeleted!();
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
  });

  it('invalidates read-only leases on deletion without retaining a tombstone', () => {
    const lease = mount();
    store.set(clearSessionRunConfigDraftsAtom, {
      workspaceId: scope().workspaceId,
      sessionIds: [scope().sessionId],
    });
    config(lease, false);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    const replacement = mount();
    config(replacement, false);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(1);
  });

  it('clears an explicitly removed workspace without clearing another workspace', () => {
    const removed = mount();
    const keepTarget = scope({ workspaceId: 'keep-workspace' });
    const keep = mount(keepTarget);
    config(removed, false);
    config(keep, true);
    store.set(clearSessionRunConfigDraftsAtom, { workspaceId: scope().workspaceId });
    config(removed, true);
    expect([...store.get(sessionRunConfigDraftsAtom).keys()]).toEqual([
      getSessionRunConfigDraftKey(keepTarget),
    ]);
    expect(draft(keepTarget)!.configOptions['fast-mode']).toEqual({ value: true });
  });

  it('blocks late edits and acceptance across account reset including an account A/B/A cycle', () => {
    const original = mount();
    config(original, false);
    const acceptOld = captureSessionRunConfigDraftAcceptance(store, original, {
      configOptionValues: { 'fast-mode': false },
    });
    store.set(setSessionRunConfigDraftAccountAtom, 'other-account');
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    config(original, true);
    const wrongOwner = mount();
    config(wrongOwner, true);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);

    const other = mount(scope({ accountId: 'other-account' }));
    config(other, true);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(1);
    store.set(setSessionRunConfigDraftAccountAtom, scope().accountId);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    const current = mount();
    config(current, false);
    const outstanding = store.get(sessionRunConfigDraftsAtom);
    config(original, true);
    config(other, false);
    acceptOld!();
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
    expect(draft()!.configOptions['fast-mode']).toEqual({ value: false });
    store.set(setSessionRunConfigDraftAccountAtom, scope().accountId);
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);

    store.set(setSessionRunConfigDraftAccountAtom, null);
    config(current, true);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
  });

  it('ignores deletion completions from a previous account lifetime', () => {
    const original = mount();
    const staleOwner = {
      accountId: original.scope.accountId,
      workspaceId: original.scope.workspaceId,
      lifetime: original.lifetime,
    };
    store.set(setSessionRunConfigDraftAccountAtom, null);
    store.set(setSessionRunConfigDraftAccountAtom, scope().accountId);
    const current = mount();
    config(current, false);
    const outstanding = store.get(sessionRunConfigDraftsAtom);
    store.set(clearSessionRunConfigDraftsAtom, {
      ...staleOwner,
      sessionIds: [scope().sessionId],
    });
    store.set(clearSessionRunConfigDraftsAtom, staleOwner);
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
    config(current, true);
    expect(draft()!.configOptions['fast-mode']).toEqual({ value: true });

    store.set(clearSessionRunConfigDraftsAtom, {
      accountId: current.scope.accountId,
      workspaceId: current.scope.workspaceId,
      lifetime: current.lifetime,
      sessionIds: [current.scope.sessionId],
    });
    config(current, false);
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
  });

  it('ignores cleanup belonging to a different account in the same workspace', () => {
    const lease = mount();
    config(lease, false);
    const outstanding = store.get(sessionRunConfigDraftsAtom);
    const otherAccount = { accountId: 'other-account', workspaceId: scope().workspaceId };
    store.set(clearSessionRunConfigDraftsAtom, {
      ...otherAccount,
      sessionIds: [scope().sessionId],
    });
    store.set(clearSessionRunConfigDraftsAtom, otherAccount);
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
    config(lease, true);
    expect(draft()!.configOptions['fast-mode']).toEqual({ value: true });
  });

  it('retains all 2,048 real drafts without LRU eviction or read-only admission', () => {
    for (let index = 0; index < 2_048; index += 1) {
      const lease = mount(scope({ sessionId: `edited-${index}` }));
      config(lease, index % 2 === 0);
      store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    }
    const outstanding = store.get(sessionRunConfigDraftsAtom);
    expect(outstanding.size).toBe(2_048);
    for (let index = 0; index < 1_000; index += 1) {
      const target = scope({ sessionId: `read-only-${index}` });
      const lease = mount(target);
      expect(draft(target)).toBeUndefined();
      store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    }
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
    for (let index = 0; index < 2_048; index += 1) {
      expect(draft(scope({ sessionId: `edited-${index}` }))!.configOptions).toEqual({
        'fast-mode': { value: index % 2 === 0 },
      });
    }
  });

  describe('real local send admission', () => {
    it('retires a captured generation only after a delayed local write, even after unmount', async () => {
      const fixture = admissionFixture();
      const lease = mount();
      config(lease, false);
      const outstanding = store.get(sessionRunConfigDraftsAtom);
      const onAccepted = captureSessionRunConfigDraftAcceptance(
        store,
        lease,
        fixture.entry.inputConfig!
      );
      const accepted = fixture.admit(onAccepted);
      await fixture.started.promise;
      expect(fixture.written.size).toBe(0);
      expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
      store.set(releaseSessionRunConfigDraftLeaseAtom, lease);

      fixture.write.resolve();
      await expect(accepted).resolves.toBe('written');
      expect(fixture.written.get(fixture.sessionId)).toEqual([fixture.entry]);
      expect(fixture.written.get(fixture.sessionId)![0]!.inputConfig).toEqual({
        configOptionValues: { 'fast-mode': false },
      });
      expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    });

    it('preserves a same-valued next edit made while the accepted local write is pending', async () => {
      const fixture = admissionFixture();
      const lease = mount();
      config(lease, false);
      const onAccepted = captureSessionRunConfigDraftAcceptance(
        store,
        lease,
        fixture.entry.inputConfig!
      );
      const accepted = fixture.admit(onAccepted);
      await fixture.started.promise;
      config(lease, false);
      const outstanding = store.get(sessionRunConfigDraftsAtom);
      fixture.write.resolve();
      await expect(accepted).resolves.toBe('written');
      expect(fixture.written.get(fixture.sessionId)![0]!.inputConfig).toEqual({
        configOptionValues: { 'fast-mode': false },
      });
      expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
      expect(draft()!.configOptions['fast-mode']).toEqual({ value: false });
    });

    it('retires admitted held-send fields at enqueue without consuming the next edit at promotion', async () => {
      const fixture = admissionFixture();
      const preparation = Promise.withResolvers<void>();
      const pending = createPendingSessionSends({
        prepare: async (send) => {
          await preparation.promise;
          return { entry: send.entry, queue: send.queue, attachments: [] };
        },
        write: (send, signal) => writeUserTurn(fixture.runtime, send, signal),
        deliver: async () => {},
      });
      const runtime = { ...fixture.runtime, pendingSends: pending };
      try {
        const lease = mount();
        config(lease, false);
        const onAccepted = captureSessionRunConfigDraftAcceptance(
          store,
          lease,
          fixture.entry.inputConfig!
        );
        await expect(fixture.admit(onAccepted, [fixture.attachment], runtime)).resolves.toBe(
          'pending'
        );
        expect(pending.getSnapshot()).toHaveLength(1);
        expect(pending.getSnapshot()[0]!.entry.inputConfig).toEqual({
          configOptionValues: { 'fast-mode': false },
        });
        expect(fixture.written.size).toBe(0);
        expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);

        config(lease, false);
        const nextDraft = store.get(sessionRunConfigDraftsAtom);
        const drained = new Promise<void>((resolve) => {
          const unsubscribe = pending.subscribe(() => {
            if (pending.hasSession(fixture.sessionId)) return;
            unsubscribe();
            resolve();
          });
        });
        preparation.resolve();
        await fixture.started.promise;
        expect(store.get(sessionRunConfigDraftsAtom)).toBe(nextDraft);
        fixture.write.resolve();
        await drained;
        expect(pending.getSnapshot()).toEqual([]);
        expect(fixture.written.get(fixture.sessionId)).toEqual([fixture.entry]);
        expect(store.get(sessionRunConfigDraftsAtom)).toBe(nextDraft);
      } finally {
        preparation.resolve();
        fixture.write.resolve();
        pending.dispose();
      }
    });

    it('keeps the draft when unsupported attachments reject before admission', async () => {
      const fixture = admissionFixture();
      const lease = mount();
      config(lease, false);
      const outstanding = store.get(sessionRunConfigDraftsAtom);
      const onAccepted = captureSessionRunConfigDraftAcceptance(
        store,
        lease,
        fixture.entry.inputConfig!
      );
      await expect(fixture.admit(onAccepted, [fixture.attachment])).rejects.toThrow(
        'Attachments cannot be sent in this workspace'
      );
      expect(fixture.written.size).toBe(0);
      expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
      expect(draft()!.configOptions['fast-mode']).toEqual({ value: false });
    });

    it('keeps the draft when the local writer rejects instead of accepting the turn', async () => {
      const fixture = admissionFixture();
      const lease = mount();
      config(lease, false);
      const outstanding = store.get(sessionRunConfigDraftsAtom);
      const onAccepted = captureSessionRunConfigDraftAcceptance(
        store,
        lease,
        fixture.entry.inputConfig!
      );
      const accepted = fixture.admit(onAccepted);
      await fixture.started.promise;
      fixture.write.reject(new Error('Synthetic local write rejected'));
      await expect(accepted).rejects.toThrow('Synthetic local write rejected');
      expect(fixture.written.size).toBe(0);
      expect(store.get(sessionRunConfigDraftsAtom)).toBe(outstanding);
      expect(draft()!.configOptions['fast-mode']).toEqual({ value: false });
    });
  });
});
