import { describe, expect, it } from 'vitest';
import {
  ScheduleAgentSchema,
  type AgentConfigMeta,
  type AgentRole,
  type ScheduleProposalMeta,
  type SessionMeta,
} from '@lody/shared';
import { resolveScheduleProposalTarget } from '../src/components/schedules/schedule-proposal-target';

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
    const result = resolveScheduleProposalTarget({ meta: meta(), conversation, agents, roles: [] });
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
    // credential; a schedule stores strings and never credentials. Handing them
    // over as-is made Create throw.
    const result = resolveScheduleProposalTarget({
      meta: meta(),
      conversation: {
        session,
        runConfig: {
          modeId: 'acceptEdits',
          configOptionValues: { fast: true, effort: 'high', api_key: 'secret' },
        },
      },
      agents,
      roles: [],
    });
    if (!result.ok) throw new Error(result.problem);
    expect(result.target.agent.configOptionValues).toEqual({ fast: 'true', effort: 'high' });
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
          configOptionValues: { verbose: 'true' },
        },
        agentConfig: writer,
        source: { agent: 'role' },
      },
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
