import { describe, expect, it } from 'vitest';
import type { AgentConfigMeta, MachineMeta, ProjectRef, SessionId } from '@lody/shared';

import { prepareSessionInput, resolveTurnDispatchConfig } from '@/commands/session';
import type { AuthContext } from '../command-runtime';
import type { LoroDocumentManager } from '../loro/doc';
import type { WorkspaceSummary } from '../workspace';
import {
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
} from './schedule-run-preparation';

/**
 * The PRODUCTION `prepareSessionInput`, not a stand-in for it.
 *
 * Only the pieces a scheduled run genuinely does not reach are absent: the
 * workspace-meta prewrite is already satisfied by the engine, and the quota
 * check short-circuits without a billing entitlement. Everything that decides
 * where a run happens — the target, the create options, and the `SessionMeta`
 * they produce — is the real code path.
 */
const auth = { userId: 'owner', machineId: 'machine' } as unknown as AuthContext;
const workspace = { id: 'workspace' } as unknown as WorkspaceSummary;
const targetMachine = {
  id: 'machine',
  ownerUserId: 'owner',
  protocolCapabilities: {},
} as unknown as MachineMeta;
const agentConfig = {
  id: 'agent',
  machineId: 'machine',
  cliType: 'claude',
  agentType: 'claude',
} as unknown as AgentConfigMeta;

/** No billing entitlement, so the quota check returns before any scan. */
const manager = {
  repo: {
    getDocMeta: async () => undefined,
    getWorkspaceMeta: async () => undefined,
  },
  syncMetaOrThrow: async () => {},
} as unknown as LoroDocumentManager;

const prepare = (
  project?: ProjectRef,
  { prompt = 'Say good morning.', title = 'Morning check-in' } = {}
) =>
  prepareSessionInput(
    auth,
    workspace,
    manager,
    prompt,
    buildScheduleSessionCreateOptions({
      sessionId: 'session-1' as SessionId,
      userTurnId: 'turn-1',
      agentConfigId: 'agent',
      title,
      project,
    }),
    {
      ...resolveTurnDispatchConfig({}),
      inheritSessionDefaults: false,
    },
    buildScheduleRunTarget({ targetMachine, agentConfig, project })
  );

describe('Session preparation for a scheduled run', () => {
  it('produces no project, repository or branch for a chat-only schedule', async () => {
    const prepared = await prepare();
    for (const field of ['project', 'repoFullName', 'baseBranch'] as const)
      expect(prepared.meta).not.toHaveProperty(field);
    expect(prepared.meta.machineId).toBe('machine');
    expect(prepared.meta.agentConfigId).toBe('agent');
  });

  it('carries the identifiers the engine froze, so a retry reuses one Session', async () => {
    const prepared = await prepare();
    expect(prepared.sessionId).toBe('session-1');
    expect(prepared.meta.id).toBe('session-1');
    expect(prepared.userTurn.id).toBe('turn-1');
    // Host-owned automation always uses the inert prepared protocol.
    expect(prepared.userTurn.status).toBe('prepared');
  });

  it('keeps an explicit title as final, so no generated title replaces it', async () => {
    const prepared = await prepare();
    expect(prepared.meta.title).toBe('Morning check-in');
    expect(prepared.meta.titleSource).toBe('user');
  });

  it('names an untitled Session with a draft from the first prompt line', async () => {
    // Agent-created Sessions carry no title; ACP-owned titles land only after
    // the first turn, so the Session would stay unnamed while it runs.
    const prepared = await prepare(undefined, {
      prompt: `\n  ${'Investigate the flaky presence heartbeat '.repeat(2)}\nDetails`,
      title: '',
    });
    expect(prepared.meta.title).toBe('Investigate the flaky presence heartbeat Investiga');
    expect(prepared.meta.titleSource).toBe('draft');
  });

  it('still resolves a GitHub project onto the Session', async () => {
    const prepared = await prepare({
      kind: 'github',
      repoFullName: 'loro-dev/lody',
      branch: 'main',
    });
    expect(prepared.meta.project).toMatchObject({ kind: 'github', repoFullName: 'loro-dev/lody' });
    expect(prepared.meta.repoFullName).toBe('loro-dev/lody');
    expect(prepared.meta.baseBranch).toBe('main');
  });

  it('still resolves a local project, and gives it no base branch', async () => {
    const prepared = await prepare({
      kind: 'local',
      localProjectId: 'p1' as never,
      useWorktree: true,
    });
    expect(prepared.meta.project).toMatchObject({ kind: 'local', localProjectId: 'p1' });
    expect(prepared.meta).not.toHaveProperty('baseBranch');
  });
});
