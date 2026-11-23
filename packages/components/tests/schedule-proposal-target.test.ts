import { describe, expect, it, beforeAll, vi } from 'vitest';
import {
  ScheduleAgentSchema,
  type AgentConfigMeta,
  type AgentRole,
  type ScheduleProposalMeta,
  type SessionMeta,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
} from '@lody/shared';
import { resolveScheduleProposalTarget } from '../src/components/schedules/schedule-proposal-target';
import i18next, { type TFunction } from 'i18next';
import en from '../../../locales/en.json';
import {
  collectScheduleSaveBlockers,
  type ScheduleSaveContext,
} from '../src/components/schedules/schedule-save-blockers';
import { createManagedStoreCache } from '../src/providers/store-ref-tracker';
import { waitForScheduleWriteSync, withScheduleWrite } from '../src/providers/schedule-write-sync';

describe('schedule-proposal-target', () => {
  const reviewer = {
    id: 'reviewer',
    machineId: 'macbook',
    name: 'Code reviewer',
    cliType: 'builtin',
    agentType: 'claude',
  } as unknown as AgentConfigMeta;
  const writer = {
    id: 'writer',
    machineId: 'studio',
    name: 'Writer',
    cliType: 'builtin',
    agentType: 'claude',
  } as unknown as AgentConfigMeta;
  const agents = [reviewer, writer];

  const role = {
    id: 'role-1',
    name: 'Release manager',
    emoji: '🚀',
    machineId: 'studio',
    agentConfigId: 'writer',
    runConfig: { modeId: 'plan', modelId: 'sonnet', configOptionValues: { verbose: true } },
  } as unknown as AgentRole;

  const session = {
    id: 's1',
    agentConfigId: 'reviewer',
    machineId: 'macbook',
    project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
  } as unknown as SessionMeta;
  const conversation = { session, runConfig: { modeId: 'acceptEdits', modelId: 'opus' } };

  const meta = (
    target?: ScheduleProposalMeta['target'],
    destination?: ScheduleProposalMeta['destination']
  ): ScheduleProposalMeta => ({
    proposalId: 'p1',
    title: 'Nightly review',
    prompt: 'Review today’s commits.',
    rule: { kind: 'daily', hour: 21, minute: 0 },
    ...(target ? { target } : {}),
    ...(destination ? { destination } : {}),
  });

  describe('where a proposed schedule runs', () => {
    it('defaults everything to the conversation it was proposed in', () => {
      const result = resolveScheduleProposalTarget({
        meta: meta(),
        conversation,
        agents,
        roles: [],
      });
      expect(result).toMatchObject({
        ok: true,
        target: {
          agent: { agentConfigId: 'reviewer', modeId: 'acceptEdits', modelId: 'opus' },
          agentConfig: reviewer,
          project: { kind: 'github', repoFullName: 'loro-dev/lody' },
          destination: { kind: 'new_session' },
          source: { agent: 'conversation', project: 'conversation' },
        },
      });
    });

    it('carries the conversation’s options in the shape a schedule can store', () => {
      // Conversation options are ACP values (booleans too) and may include a
      // credential; the shared value types survive while credentials are removed.
      const result = resolveScheduleProposalTarget({
        meta: meta(),
        conversation: {
          session,
          runConfig: {
            modeId: 'acceptEdits',
            configOptionValues: {
              fast: true,
              plan_mode: false,
              select_flag: 'false',
              effort: 'high',
              api_key: 'secret',
            },
          },
        },
        agents,
        roles: [],
      });
      if (!result.ok) throw new Error(result.problem);
      expect(result.target.agent.configOptionValues).toEqual({
        fast: true,
        plan_mode: false,
        select_flag: 'false',
        effort: 'high',
      });
      expect(ScheduleAgentSchema.safeParse(result.target.agent).success).toBe(true);
    });

    it('lets a named Role replace the Agent, machine and run config together', () => {
      const result = resolveScheduleProposalTarget({
        meta: meta({ agentRoleId: 'role-1' }),
        conversation,
        agents,
        roles: [role],
      });
      expect(result).toMatchObject({
        ok: true,
        target: {
          agent: {
            agentConfigId: 'writer',
            modeId: 'plan',
            modelId: 'sonnet',
            configOptionValues: { verbose: true },
          },
          agentConfig: writer,
          source: { agent: 'role' },
        },
      });
    });

    it('runs a multi-machine Role on the named machine, else the conversation’s, never a guess', () => {
      const everywhere = {
        ...role,
        additionalTargets: [
          { machineId: 'macbook', agentConfigId: 'reviewer', runConfig: { modelId: 'haiku' } },
        ],
      } as unknown as AgentRole;
      const resolve = (target: ScheduleProposalMeta['target'], from = conversation) =>
        resolveScheduleProposalTarget({
          meta: meta(target),
          conversation: from,
          agents,
          roles: [everywhere],
        });

      expect(resolve({ agentRoleId: 'role-1', machineId: 'studio' })).toMatchObject({
        ok: true,
        target: { agent: { agentConfigId: 'writer', modelId: 'sonnet' } },
      });
      // The conversation runs on the MacBook, where the Role also runs.
      expect(resolve({ agentRoleId: 'role-1' })).toMatchObject({
        ok: true,
        target: { agent: { agentConfigId: 'reviewer', modelId: 'haiku' } },
      });
      const elsewhere = {
        ...conversation,
        session: { ...session, machineId: 'ci' } as SessionMeta,
      };
      expect(resolve({ agentRoleId: 'role-1' }, elsewhere)).toEqual({
        ok: false,
        problem: 'role_machine_required',
      });
      expect(resolve({ agentRoleId: 'role-1', machineId: 'ci' })).toEqual({
        ok: false,
        problem: 'machine_mismatch',
      });
    });

    it('gives a named Agent the builtin default mode, never the conversation’s', () => {
      // The conversation's mode belongs to the conversation's Agent; carrying it
      // onto a different Agent could hand that Agent an elevated mode nobody chose.
      const result = resolveScheduleProposalTarget({
        meta: meta({ agentConfigId: 'writer' }),
        conversation,
        agents,
        roles: [],
      });
      expect(result.ok && result.target.agent.agentConfigId).toBe('writer');
      expect(result.ok && result.target.agent.modeId).not.toBe('acceptEdits');
      expect(result.ok && result.target.source.agent).toBe('named');
    });

    it('treats a named machine as a constraint the Agent must satisfy', () => {
      expect(
        resolveScheduleProposalTarget({
          meta: meta({ agentConfigId: 'writer', machineId: 'macbook' }),
          conversation,
          agents,
          roles: [],
        })
      ).toEqual({ ok: false, problem: 'machine_mismatch' });
      expect(
        resolveScheduleProposalTarget({
          meta: meta({ machineId: 'macbook' }),
          conversation,
          agents,
          roles: [],
        }).ok
      ).toBe(true);
    });

    it('drops the project when runs go into a chat, and takes a named one for a fresh chat', () => {
      expect(
        resolveScheduleProposalTarget({
          meta: meta(undefined, { kind: 'own_session' }),
          conversation,
          agents,
          roles: [],
        })
      ).toMatchObject({
        ok: true,
        target: { project: null, destination: { kind: 'own_session', epoch: 0 } },
      });
      expect(
        resolveScheduleProposalTarget({
          meta: meta({ project: { kind: 'local', localProjectId: 'p9' as never } }),
          conversation,
          agents,
          roles: [],
        })
      ).toMatchObject({
        ok: true,
        target: { project: { kind: 'local', localProjectId: 'p9' }, source: { project: 'named' } },
      });
    });

    it('names what is missing instead of guessing', () => {
      expect(
        resolveScheduleProposalTarget({
          meta: meta({ agentRoleId: 'gone' }),
          conversation,
          agents,
          roles: [],
        })
      ).toEqual({ ok: false, problem: 'role_not_found' });
      expect(
        resolveScheduleProposalTarget({
          meta: meta({ agentConfigId: 'ghost' }),
          conversation,
          agents,
          roles: [],
        })
      ).toEqual({ ok: false, problem: 'agent_not_found' });
      expect(
        resolveScheduleProposalTarget({ meta: meta(), conversation: null, agents, roles: [] })
      ).toEqual({ ok: false, problem: 'no_agent' });
    });
  });
});

describe('schedule-save-blockers', () => {
  let t: TFunction;
  beforeAll(async () => {
    t = await i18next.createInstance({ lng: 'en', resources: { en: { translation: en } } }).init();
  });

  const agentConfig = {
    id: 'agent',
    machineId: 'machine',
    name: 'Code reviewer',
    cliType: 'claude',
    agentType: 'claude',
  } as unknown as ScheduleSaveContext['agentConfig'];

  const machine = {
    id: 'machine',
    ownerUserId: 'owner',
    protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    acpCapabilities: {
      agent: {
        modes: [{ id: 'safe', name: 'Ask each time' }],
        configOptions: [],
      },
    },
  } as unknown as ScheduleSaveContext['machine'];

  const ready = (overrides: Partial<ScheduleSaveContext> = {}): ScheduleSaveContext => ({
    workspaceReady: true,
    userId: 'owner',
    agent: { agentConfigId: 'agent' as never, modeId: 'safe' },
    agentConfig,
    machine,
    project: null,
    machineLocalProjectIds: new Set(),
    destination: { kind: 'new_session' },
    ...overrides,
  });

  describe('what stops a schedule from being saved', () => {
    it('requires a typed-config daemon before authoring schedules', () => {
      const context = ready({ machine: { ...machine, protocolCapabilities: { schedules: 1 } } });
      expect(collectScheduleSaveBlockers(context, t)).toContain(en['schedules.upgrade']);
      expect(collectScheduleSaveBlockers(ready(), t)).toEqual([]);
    });

    it('requires an Agent but not an explicit permission pin or capability cache', () => {
      expect(collectScheduleSaveBlockers(ready({ agent: null, agentConfig: null }), t)).toContain(
        en['schedules.requireAgent']
      );
      const agent = { agentConfigId: 'agent' as never };
      expect(collectScheduleSaveBlockers(ready({ agent }), t)).toEqual([]);
      expect(
        collectScheduleSaveBlockers(
          ready({ agent, machine: { ...machine!, acpCapabilities: {} } }),
          t
        )
      ).toEqual([]);
    });

    it('still requires an owned machine that supports schedules', () => {
      expect(collectScheduleSaveBlockers(ready({ machine: undefined }), t)).toContain(
        en['schedules.machineMissing']
      );
      expect(
        collectScheduleSaveBlockers(
          ready({ machine: { ...machine!, ownerUserId: 'somebody-else' } }),
          t
        )
      ).toContain(en['schedules.requireOwnedMachine']);
      expect(
        collectScheduleSaveBlockers(
          ready({ machine: { ...machine!, protocolCapabilities: {} } }),
          t
        )
      ).toContain(en['schedules.upgrade']);
    });

    it('requires a chosen local project to exist on the target machine', () => {
      const project = { kind: 'local', localProjectId: 'p1' } as ScheduleSaveContext['project'];
      expect(collectScheduleSaveBlockers(ready({ project }), t)).toContain(
        en['schedules.projectMachine']
      );
      expect(
        collectScheduleSaveBlockers(ready({ project, machineLocalProjectIds: new Set(['p1']) }), t)
      ).toEqual([]);
    });

    it('accepts a GitHub project without a machine-local check', () => {
      expect(
        collectScheduleSaveBlockers(
          ready({ project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' } }),
          t
        )
      ).toEqual([]);
    });

    it('leads with the read-only reason and waits for the workspace', () => {
      expect(collectScheduleSaveBlockers(ready({ disabledReason: 'read only' }), t)[0]).toBe(
        'read only'
      );
      expect(collectScheduleSaveBlockers(ready({ workspaceReady: false }), t)).toContain(
        en['schedules.workspaceNotReady']
      );
    });
  });

  describe('sending runs into a chat', () => {
    it('locks the Agent and machine to the chat once one exists', () => {
      const own = ready({
        destination: { kind: 'own_session', epoch: 0 },
        destinationSession: { agentConfigId: 'writer', machineId: 'machine' },
      });
      expect(collectScheduleSaveBlockers(own, t)).toContain(
        en['schedules.destination.agentMismatch']
      );
      expect(
        collectScheduleSaveBlockers(
          ready({
            destination: { kind: 'own_session', epoch: 0 },
            destinationSession: { agentConfigId: 'agent', machineId: 'laptop' },
          }),
          t
        )
      ).toContain(en['schedules.destination.machineMismatch']);
      // Before the first run there is no chat yet, so nothing is locked.
      expect(
        collectScheduleSaveBlockers(ready({ destination: { kind: 'own_session', epoch: 0 } }), t)
      ).toEqual([]);
    });
  });
});

describe('schedule-write-sync', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  describe('Schedule authored write synchronization', () => {
    it('opens an unopened document before writing and retains it through offline idle cleanup until acknowledgement', async () => {
      const ack = deferred();
      const dispose = vi.fn();
      const create = vi.fn(async () => ({
        dispose,
        waitUntilSynced: () => ack.promise,
        getState: () => ({}),
        firstSynced: Promise.resolve(),
      }));
      const cache = createManagedStoreCache({ create, releaseDelayMs: 60_000 });
      const write = vi.fn(() => {
        expect(create).toHaveBeenCalledWith('schedule');
        return 'saved locally';
      });
      expect(await withScheduleWrite(cache, 'schedule', write)).toBe('saved locally');
      await cache.releaseIdle();
      expect(dispose).not.toHaveBeenCalled();
      ack.resolve();
      await ack.promise;
      await cache.releaseIdle();
      expect(dispose).toHaveBeenCalledOnce();
      await cache.disposeAll();
    });

    it('does not accept an acknowledgement from an old connection generation', async () => {
      let status = 'joined';
      let notify = () => {};
      const old = deferred();
      const current = deferred();
      const waitUntilSynced = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const off = vi.fn();
      const binding = {
        get status() {
          return status;
        },
        waitUntilSynced,
        onStatusChange: (listener: () => void) => {
          notify = listener;
          return off;
        },
      };
      const abort = new AbortController();
      const done = vi.fn();
      const result = waitForScheduleWriteSync(binding as never, abort.signal).then(done);
      status = 'detached';
      notify();
      status = 'joined';
      notify();
      old.resolve();
      await old.promise;
      expect(done).not.toHaveBeenCalled();
      expect(waitUntilSynced).toHaveBeenCalledTimes(2);
      current.resolve();
      await result;
      expect(done).toHaveBeenCalledOnce();
      expect(off).toHaveBeenCalledOnce();
    });
  });

  it('waits for a missing definition to hydrate before mutating a Registry-only schedule', async () => {
    const hydrate = deferred();
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => null,
        firstSynced: hydrate.promise,
        waitUntilSynced: async () => {},
      }),
    });
    const write = vi.fn(() => 'paused');
    const pending = withScheduleWrite(cache, 'unopened', write);
    await cache.get('unopened');
    expect(write).not.toHaveBeenCalled();
    hydrate.resolve();
    expect(await pending).toBe('paused');
    await cache.disposeAll();
  });
  it('creates a new definition offline without waiting for remote hydration', async () => {
    const cache = createManagedStoreCache({
      releaseDelayMs: 60_000,
      create: async () => ({
        dispose() {},
        getState: () => null,
        firstSynced: new Promise<void>(() => {}),
        waitUntilSynced: async () => {},
      }),
    });
    expect(await withScheduleWrite(cache, 'new', () => 'created', { create: true })).toBe(
      'created'
    );
    await cache.disposeAll();
  });
});
