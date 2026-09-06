import { describe, expect, it } from 'vitest';
import {
  resolveAccountProfileId,
  type ACPSessionId,
  type SessionId,
  type MachineId,
  type SessionMeta,
} from '@lody/shared';
import { switchSessionAccount, type AccountHandoffDeps } from './session-account-handoff';

const sessionId = 'session-a' as SessionId;
const oldProviderId = 'provider-old' as ACPSessionId;
const newProviderId = 'provider-new' as ACPSessionId;
const accountB = '00000000-0000-4000-8000-00000000000b';
const accountC = '00000000-0000-4000-8000-00000000000c';

function harness(overrides: Partial<AccountHandoffDeps> = {}, initial: Partial<SessionMeta> = {}) {
  let meta: SessionMeta = {
    id: sessionId,
    machineId: 'machine' as MachineId,
    userId: 'user',
    createdAt: '2026-01-01',
    cliType: 'builtin',
    agentType: 'codex',
    acpSessionId: oldProviderId,
    title: 'Original transcript',
    branchName: 'original-branch',
    ...initial,
  };
  let durable = structuredClone(meta);
  const events: string[] = [];
  let locked = false;
  const deps: AccountHandoffDeps = {
    acquire: () => {
      if (locked) return null;
      locked = true;
      return () => {
        locked = false;
        events.push('release');
      };
    },
    assertIdle: async () => {},
    read: async () => structuredClone(meta),
    validate: async () => {
      events.push('validate');
    },
    checkpoint: async (patch) => {
      meta = { ...meta, ...patch };
      durable = structuredClone(meta);
      events.push('checkpoint');
    },
    stop: async () => {
      events.push('stop');
    },
    launch: async (_meta, target, resume) => {
      events.push(`launch:${target}:${resume ?? 'fresh'}`);
      return resume ?? newProviderId;
    },
    isResumeFailure: (error) => error instanceof Error && error.message === 'ACP_RESUME_FAILED',
    now: () => 42,
    ...overrides,
  };
  return { deps, events, read: () => meta, durable: () => durable, locked: () => locked };
}

describe('account handoff transaction', () => {
  it('does not replay an older completed switch after a newer switch', async () => {
    const h = harness();
    await switchSessionAccount(
      { sessionId, accountProfileId: accountB, requestId: 'op-1' },
      h.deps
    );
    await switchSessionAccount(
      { sessionId, accountProfileId: accountC, requestId: 'op-2' },
      h.deps
    );
    const beforeReplay = h.events.length;
    const replay = await switchSessionAccount(
      { sessionId, accountProfileId: accountB, requestId: 'op-1' },
      h.deps
    );
    expect(replay.accountProfileId).toBe(accountC);
    expect(h.read().accountProfileId).toBe(accountC);
    expect(h.read().accountTransitions).toHaveLength(2);
    expect(h.events.slice(beforeReplay)).toEqual(['release']);
    await expect(
      switchSessionAccount(
        { sessionId, accountProfileId: 'system-default', requestId: 'op-1' },
        h.deps
      )
    ).rejects.toThrow('different account');
  });
  it('commits native resume with legacy default binding without changing workspace metadata', async () => {
    const h = harness();
    const result = await switchSessionAccount(
      { sessionId, requestId: 'switch-1', accountProfileId: accountB },
      h.deps
    );
    expect(result).toEqual({
      sessionId,
      accountProfileId: accountB,
      acpSessionId: oldProviderId,
      continuation: false,
    });
    expect(h.events).toEqual([
      'validate',
      'checkpoint',
      'stop',
      `launch:${accountB}:${oldProviderId}`,
      'checkpoint',
      'release',
    ]);
    expect(h.read()).toMatchObject({
      title: 'Original transcript',
      branchName: 'original-branch',
      accountProfileId: accountB,
      accountHandoff: null,
    });
    expect(h.read().accountTransitions?.[0]?.fromAccountProfileId).toBe('system-default');
  });

  it('leaves legacy single-account bindings untouched when default is selected again', async () => {
    const h = harness();
    await switchSessionAccount(
      { sessionId, requestId: 'switch-1', accountProfileId: 'system-default' },
      h.deps
    );
    expect(h.events).toEqual(['checkpoint', 'release']);
    expect(h.read().accountProfileId).toBeUndefined();
  });

  it('rejects a busy session before auth validation or process teardown', async () => {
    const h = harness({
      assertIdle: async () => {
        throw new Error('busy');
      },
    });
    await expect(
      switchSessionAccount({ sessionId, requestId: 'switch-1', accountProfileId: accountB }, h.deps)
    ).rejects.toThrow('busy');
    expect(h.events).toEqual(['release']);
    expect(h.read().acpSessionId).toBe(oldProviderId);
  });

  it('preserves the existing process and binding when target authentication is invalid', async () => {
    const h = harness({
      validate: async () => {
        throw new Error('invalid auth');
      },
    });
    await expect(
      switchSessionAccount({ sessionId, requestId: 'switch-1', accountProfileId: accountB }, h.deps)
    ).rejects.toThrow('invalid auth');
    expect(h.events).toEqual(['release']);
    expect(h.read().accountHandoff).toBeUndefined();
  });

  it('uses a new provider session and durable continuation marker after classified resume failure', async () => {
    const h = harness({
      launch: async (_meta, _target, resume) => {
        if (resume) throw new Error('ACP_RESUME_FAILED');
        return newProviderId;
      },
    });
    const result = await switchSessionAccount(
      { sessionId, requestId: 'switch-1', accountProfileId: accountB },
      h.deps
    );
    expect(result.continuation).toBe(true);
    expect(h.durable()).toMatchObject({
      accountProfileId: accountB,
      acpSessionId: newProviderId,
      accountContinuation: { acpSessionId: newProviderId },
    });
    expect(h.durable().accountTransitions?.[0]).toMatchObject({
      fromAcpSessionId: oldProviderId,
      toAcpSessionId: newProviderId,
    });
  });

  it('does not treat provider authentication, usage, or model failures as resume failures', async () => {
    for (const failure of ['invalid auth', 'usage exhausted', 'model unavailable', 'CLI crash']) {
      const h = harness({
        launch: async () => {
          throw new Error(failure);
        },
      });
      await expect(
        switchSessionAccount(
          { sessionId, requestId: 'switch-1', accountProfileId: accountB },
          h.deps
        )
      ).rejects.toThrow(failure);
      expect(h.durable()).toMatchObject({
        accountProfileId: 'system-default',
        acpSessionId: oldProviderId,
        accountHandoff: null,
      });
      expect(h.read().accountTransitions).toEqual([]);
    }
  });

  it('retains committed source identity at every uncommitted restart boundary', async () => {
    const h = harness();
    const baseLaunch = h.deps.launch;
    h.deps.launch = async (...args) => {
      const recovered = h.durable();
      expect(resolveAccountProfileId(recovered.accountProfileId)).toBe('system-default');
      expect(recovered.acpSessionId).toBe(oldProviderId);
      expect(recovered.accountHandoff?.targetAccountProfileId).toBe(accountB);
      return await baseLaunch(...args);
    };
    await switchSessionAccount(
      { sessionId, requestId: 'switch-1', accountProfileId: accountB },
      h.deps
    );
    expect(h.durable().accountProfileId).toBe(accountB);
  });

  it('retries an interrupted intent from the committed source, ignoring the abandoned target', async () => {
    const h = harness(
      {},
      {
        accountHandoff: {
          sourceAccountProfileId: 'system-default',
          sourceAcpSessionId: oldProviderId,
          targetAccountProfileId: accountC,
        },
      }
    );
    await switchSessionAccount(
      { sessionId, requestId: 'switch-1', accountProfileId: accountB },
      h.deps
    );
    expect(h.events).toContain(`launch:${accountB}:${oldProviderId}`);
    expect(h.read().accountTransitions).toHaveLength(1);
  });

  it('stops the candidate and restores the pair if the final local commit fails', async () => {
    const h = harness();
    const checkpoint = h.deps.checkpoint;
    h.deps.checkpoint = async (patch) => {
      await checkpoint(patch);
      if (patch.accountProfileId === accountB) throw new Error('disk failure');
    };
    await expect(
      switchSessionAccount({ sessionId, requestId: 'switch-1', accountProfileId: accountB }, h.deps)
    ).rejects.toThrow('disk failure');
    expect(h.durable()).toMatchObject({
      accountProfileId: 'system-default',
      acpSessionId: oldProviderId,
      accountTransitions: [],
    });
    expect(h.events.filter((event) => event === 'stop')).toHaveLength(2);
    expect(h.locked()).toBe(false);
  });

  it('keeps concurrent sessions independent while rejecting a second switch on the same session', async () => {
    const h = harness();
    let releaseValidation: () => void = () => {};
    h.deps.validate = async () =>
      await new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
    const first = switchSessionAccount(
      { sessionId, requestId: 'switch-1', accountProfileId: accountB },
      h.deps
    );
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      switchSessionAccount({ sessionId, requestId: 'switch-1', accountProfileId: accountC }, h.deps)
    ).rejects.toThrow('busy');
    const other = harness();
    await switchSessionAccount(
      { sessionId, requestId: 'switch-1', accountProfileId: accountC },
      other.deps
    );
    releaseValidation();
    await first;
    expect(h.read().accountProfileId).toBe(accountB);
    expect(other.read().accountProfileId).toBe(accountC);
  });

  it('rejects malformed account IDs before touching the session', async () => {
    const h = harness();
    await expect(
      switchSessionAccount(
        { sessionId, requestId: 'switch-1', accountProfileId: '../../native-auth' },
        h.deps
      )
    ).rejects.toThrow();
    expect(h.events).toEqual([]);
  });
});
