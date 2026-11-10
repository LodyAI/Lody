// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  applyTextRewrites,
  resolveAgentRoleAvailability,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
  type WorkspaceId,
} from '@lody/shared';
import { buildAgentRoleCandidates } from '../src/components/mentions/mention-registry';
import {
  AGENT_ROLE_UNAVAILABLE_REASON_KEYS,
  createAgentRoleCapabilityResolver,
} from '../src/lib/composer-agent-roles';
import {
  buildAgentRoleMentionItems,
  buildAgentRoleMentionPrompt,
  buildAgentRoleMentionRewrites,
  hydrateAgentRoleMentionsFromText,
  selectAgentRoleMentionCandidates,
  type AgentRoleMentionItem,
} from '../src/components/mentions/mention-agent-role-source';
import {
  useMentionPromptExpansion,
  type MentionPromptExpansion,
} from '../src/components/mentions/mention-expansion';

// The composer-facing hooks read the authenticated machine index and the
// workspace catalog. Stub those inputs, keep the real availability rule.
const reach = vi.hoisted(() => ({
  roles: [] as AgentRole[],
  authorized: new Set<string>(),
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: new Map([...reach.authorized].map((id) => [id, { id, name: id }])),
  }),
}));
vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: reach.roles, synced: true }),
  useAgentRoleAvailability: () => ({
    resolve: (entry: AgentRole) =>
      resolveAgentRoleAvailability(entry, {
        authorizedMachineIds: reach.authorized as Set<MachineId>,
        onlineMachineIds: reach.authorized as Set<MachineId>,
        agentConfigMachineIds: new Map(
          reach.roles.map((candidate) => [candidate.agentConfigId, candidate.machineId])
        ),
        loadedAgentConfigMachineIds: reach.authorized as Set<MachineId>,
      }),
  }),
}));
vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));
vi.mock('../src/components/mentions/mention-skill-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSkillMentionRewrites: () => () => [],
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;

const role = (overrides: Partial<AgentRole> = {}): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6', configOptionValues: { thought_level: 'high' } },
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const agentConfig = { cliType: 'builtin', agentType: 'codex', env: {}, name: 'Codex' } as const;

const items = (...roles: AgentRole[]): AgentRoleMentionItem[] =>
  buildAgentRoleMentionItems(roles, {
    availability: () => ({ kind: 'available' }),
    machine: () => ({ name: 'Studio' }),
    agentConfig: () => agentConfig,
  });

describe('agent role reach from a local project composer', () => {
  it('dispatches a role bound to another authorized machine, never an unreachable one', async () => {
    const remote = role({
      id: 'remote' as AgentRoleId,
      name: 'Remote Reviewer',
      machineId: 'machine-2' as MachineId,
      agentConfigId: 'config-2' as AgentConfigId,
    });
    const unreachable = role({
      id: 'unreachable' as AgentRoleId,
      name: 'Unreachable Reviewer',
      machineId: 'machine-3' as MachineId,
      agentConfigId: 'config-3' as AgentConfigId,
    });
    reach.roles = [remote, unreachable];
    reach.authorized = new Set([machineId, 'machine-2']);

    let expansion: MentionPromptExpansion | undefined;
    function LocalProjectComposer() {
      expansion = useMentionPromptExpansion({
        source: {
          kind: 'local',
          machineId,
          workspaceId: 'w' as WorkspaceId,
          localProjectId: 'p' as LocalProjectId,
        },
        skillAgent: undefined,
        promptValue: '',
      });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(LocalProjectComposer)));

    const text = '@Remote-Reviewer and @Unreachable-Reviewer';
    const expanded = expansion!.expand({
      text,
      mentions: [
        { start: 0, end: 16, kind: 'agent_role', value: 'remote' },
        { start: 21, end: 42, kind: 'agent_role', value: 'unreachable' },
      ],
    });
    expect(expanded.text).toBe(
      `${buildAgentRoleMentionPrompt({ id: 'remote', name: 'Remote Reviewer' })} and @Unreachable-Reviewer`
    );
    await act(async () => root.unmount());
  });
});

describe('agent role availability in mentions', () => {
  it('puts available matches first even when a disabled match has a higher score', () => {
    const available = items(role({ id: 'ready' as AgentRoleId, name: 'Deep Reviewer' }))[0]!;
    const offline = {
      ...items(role({ name: 'Reviewer' }))[0]!,
      availability: { kind: 'unavailable', reason: 'machine_offline' } as const,
    };
    const loading = {
      ...available,
      role: role({ id: 'loading' as AgentRoleId }),
      availability: { kind: 'unknown' } as const,
    };
    const list = [offline, loading, available];
    expect(selectAgentRoleMentionCandidates(list, '').map((item) => item.role.id)).toEqual([
      'ready',
      'role-1',
      'loading',
    ]);
    expect(selectAgentRoleMentionCandidates(list, 'rev', 1)).toEqual([available]);
    expect(selectAgentRoleMentionCandidates([offline, loading], 'rev')).toHaveLength(2);
  });
});

describe('agent role menu rows', () => {
  it('explains and blocks a Role whose agent retired its pinned model', () => {
    const stale = role({ runConfig: { modelId: 'model-old' } });
    const machine = {
      name: 'MacBook',
      acpCapabilities: {
        'config-1': {
          agentType: 'codex',
          cliType: 'builtin',
          provenance: 'runtime',
          models: [{ modelId: 'model-new', name: 'New' }],
          modes: [],
          fetchedAt: 1,
        },
      },
    } as unknown as MachineViewMeta;
    const config = {
      id: 'config-1',
      name: 'Codex',
      agentType: 'codex',
      cliType: 'builtin',
      machineId,
    } as AgentConfigMeta;
    const list = buildAgentRoleMentionItems([stale], {
      availability: (entry) =>
        resolveAgentRoleAvailability(entry, {
          authorizedMachineIds: new Set([machineId]),
          onlineMachineIds: new Set([machineId]),
          agentConfigMachineIds: new Map([[config.id, machineId]]),
          loadedAgentConfigMachineIds: new Set([machineId]),
          runConfigCapability: createAgentRoleCapabilityResolver(
            [config],
            new Map([[machineId, machine]])
          ),
        }),
      machine: () => machine,
      agentConfig: () => config,
    });
    const [candidate] = buildAgentRoleCandidates(list, '', undefined, ({ availability }) =>
      availability.kind === 'unavailable'
        ? AGENT_ROLE_UNAVAILABLE_REASON_KEYS[availability.reason]
        : undefined
    );
    expect(candidate).toMatchObject({
      disabled: true,
      subtitle: 'settings.agentRoles.unavailable.modelUnavailable',
      subtitleTone: 'warning',
    });
    expect(
      buildAgentRoleMentionRewrites(
        '@Code-Reviewer',
        [{ start: 0, end: 14, kind: 'agent_role', value: 'role-1' }],
        list
      )
    ).toEqual([]);
  });

  it.each([{ kind: 'unknown' }, { kind: 'unavailable', reason: 'machine_offline' }] as const)(
    'disables unavailable/loading rows and carries the reason below the title',
    (availability) => {
      const list = [{ ...items(role())[0]!, availability }];
      const [candidate] = buildAgentRoleCandidates(list, '', undefined, () => 'Machine offline');
      expect(candidate).toMatchObject({
        disabled: true,
        subtitle: 'Machine offline',
        title: 'Code Reviewer',
      });
      expect(
        buildAgentRoleMentionRewrites(
          '@Code-Reviewer',
          [{ start: 0, end: 14, kind: 'agent_role', value: 'role-1' }],
          list
        )
      ).toEqual([]);
      expect(hydrateAgentRoleMentionsFromText('@Code-Reviewer', list).mentions).toEqual([]);
    }
  );
});

describe('agent role before-send expansion', () => {
  const text = 'please @Code-Reviewer this diff';
  const mention = { start: 7, end: 21, kind: 'agent_role', value: 'role-1' };

  it('rewrites the range into an id-bearing instruction and keeps the chip label', () => {
    const expanded = applyTextRewrites(
      text,
      buildAgentRoleMentionRewrites(text, [mention], items(role()))
    );
    expect(expanded.text).toBe(
      `please ${buildAgentRoleMentionPrompt({ id: 'role-1', name: 'Code Reviewer' })} this diff`
    );
    expect(expanded.spans).toEqual([
      {
        start: 7,
        end: 7 + buildAgentRoleMentionPrompt({ id: 'role-1', name: 'Code Reviewer' }).length,
        kind: 'agent_role',
        label: 'Code-Reviewer',
        target: 'role-1',
        // Frozen with the span so the bubble paints without the catalog.
        mark: '🔍',
      },
    ]);
  });

  it('leaves a role that is no longer offered as plain text', () => {
    expect(buildAgentRoleMentionRewrites(text, [mention], [])).toEqual([]);
  });
});

describe('agent role draft hydration', () => {
  it('leaves a token the file source already knows to the file hydrator', () => {
    expect(
      hydrateAgentRoleMentionsFromText(
        'open @Code-Reviewer',
        items(role()),
        new Set(['Code-Reviewer'])
      ).mentions
    ).toEqual([]);
  });
});

describe('a role on several machines', () => {
  const multi = role({
    alias: undefined,
    additionalTargets: [
      {
        machineId: 'machine-2' as MachineId,
        agentConfigId: 'config-2' as AgentConfigId,
        runConfig: { modelId: 'gpt-5.6-luna' },
        alias: 'Reviewer-Linux',
      },
    ],
  });
  const names: Record<string, string> = { 'machine-1': 'Studio', 'machine-2': 'Linux box' };
  const targetItems = (preferred?: MachineId) =>
    buildAgentRoleMentionItems(
      [multi],
      {
        availability: () => ({ kind: 'available' }),
        machine: (id) => ({ name: names[id] ?? id }),
        agentConfig: () => agentConfig,
      },
      preferred
    );

  it('offers one row per machine, labelled by alias or name and machine', () => {
    const rows = targetItems();
    expect(rows.map((item) => [item.label, item.slug, item.value])).toEqual([
      ['Code Reviewer · Studio', 'Code-Reviewer-Studio', 'role-1@machine-1'],
      ['Reviewer-Linux', 'Reviewer-Linux', 'role-1@machine-2'],
    ]);
    // Each row is that machine's binding, which the detail pane and dispatch read.
    expect(rows[1]?.role).toMatchObject({ machineId: 'machine-2', agentConfigId: 'config-2' });
  });

  it("puts the composer's own machine first", () => {
    expect(targetItems('machine-2' as MachineId).map((item) => item.value)).toEqual([
      'role-1@machine-2',
      'role-1@machine-1',
    ]);
  });

  it('names the picked machine in the instruction and on the frozen span', () => {
    const text = 'ask @Reviewer-Linux';
    const rewrites = buildAgentRoleMentionRewrites(
      text,
      [{ start: 4, end: 19, kind: 'agent_role', value: 'role-1@machine-2' }],
      targetItems()
    );
    expect(rewrites[0]?.replacement).toBe(
      'use lody mcp to create a session with agent role[id: role-1, agentRoleMachineId: machine-2, name: Code Reviewer]'
    );
    expect(rewrites[0]?.span?.target).toBe('role-1@machine-2');
    // A bare id from an older draft names no machine: it stays plain text.
    expect(
      buildAgentRoleMentionRewrites(
        text,
        [{ start: 4, end: 19, kind: 'agent_role', value: 'role-1' }],
        targetItems()
      )
    ).toEqual([]);
  });

  it('hydrates each machine token to its own target', () => {
    expect(
      hydrateAgentRoleMentionsFromText('@Reviewer-Linux and @Code-Reviewer-Studio', targetItems())
        .values
    ).toEqual(['role-1@machine-2', 'role-1@machine-1']);
  });
});
