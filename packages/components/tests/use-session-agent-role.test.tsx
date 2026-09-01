// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  AgentConfigMeta,
  AgentRole,
  AgentRoleId,
  MachineId,
  SessionId,
} from '@lody/shared';

const catalog = vi.hoisted(() => ({
  roles: [] as AgentRole[],
  agentConfigs: [] as AgentConfigMeta[],
  synced: true,
}));

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAtomValue: () => catalog.agentConfigs,
}));

vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: catalog.roles, synced: catalog.synced }),
  useAgentRoleAvailability: () => ({ resolve: () => ({ kind: 'available' }) }),
}));

import {
  useSessionAgentRole,
  type SessionAgentRoleControl,
} from '../src/hooks/use-session-agent-role';
import {
  sessionAgentRoleDurableSnapshotAtomFamily,
  sessionAgentRoleSelectionAtomFamily,
} from '../src/atoms/session-agent-roles';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const role = (id: string, modelId: string): AgentRole => ({
  v: 1,
  id: id as AgentRoleId,
  revision: 1,
  name: id,
  visibility: 'private',
  ownerUserId: 'user-1',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'agent-1' as AgentConfigId,
  runConfig: { modelId },
  createdAt: Date.UTC(2026, 7, 25),
  updatedAt: Date.UTC(2026, 7, 25),
});

const agentConfig = {
  id: 'agent-1',
  name: 'Codex',
  machineId: 'machine-1',
  cliType: 'builtin',
  agentType: 'codex',
} as AgentConfigMeta;

describe('useSessionAgentRole', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let control: SessionAgentRoleControl | null = null;
  let hookProps: {
    sessionId: string;
    provenanceRoleId?: AgentRoleId;
    durableRoleId?: AgentRoleId | null;
    durableRoleRevision?: number;
    durableSourceTurnKey?: string;
    durableKnownSourceTurnKeys?: readonly string[];
    durableRoleReady?: boolean;
    runConfigHasUserEdits?: boolean;
    selectedModelId: string;
  };

  function Harness() {
    control = useSessionAgentRole({
      sessionId: hookProps.sessionId as SessionId,
      provenanceRoleId: hookProps.provenanceRoleId,
      durableRoleId: hookProps.durableRoleId,
      durableRoleRevision: hookProps.durableRoleRevision,
      durableSourceTurnKey: hookProps.durableSourceTurnKey,
      durableKnownSourceTurnKeys: hookProps.durableKnownSourceTurnKeys,
      durableRoleReady: hookProps.durableRoleReady,
      runConfigHasUserEdits: hookProps.runConfigHasUserEdits,
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'agent-1' as AgentConfigId,
      modelOptions: [{ value: 'model-1', label: 'Model 1' }],
      selectedModelId: hookProps.selectedModelId,
      modeOptions: [],
      selectedModeId: null,
      configOptionSelectors: [],
      configOptionValues: {},
    });
    return null;
  }

  const render = async ({
    sessionId = 'session-1',
    provenanceRoleId,
    durableRoleId,
    durableRoleRevision,
    durableSourceTurnKey,
    durableKnownSourceTurnKeys,
    durableRoleReady,
    runConfigHasUserEdits,
    selectedModelId = 'model-1',
  }: {
    sessionId?: string;
    provenanceRoleId?: AgentRoleId;
    durableRoleId?: AgentRoleId | null;
    durableRoleRevision?: number;
    durableSourceTurnKey?: string;
    durableKnownSourceTurnKeys?: readonly string[];
    durableRoleReady?: boolean;
    runConfigHasUserEdits?: boolean;
    selectedModelId?: string;
  }) => {
    hookProps = {
      sessionId,
      provenanceRoleId,
      durableRoleId,
      durableRoleRevision,
      durableSourceTurnKey,
      durableKnownSourceTurnKeys,
      durableRoleReady,
      runConfigHasUserEdits,
      selectedModelId,
    };
    await act(async () => root?.render(createElement(Harness)));
  };

  beforeEach(() => {
    sessionAgentRoleSelectionAtomFamily.remove('session-1' as SessionId);
    sessionAgentRoleSelectionAtomFamily.remove('session-2' as SessionId);
    sessionAgentRoleDurableSnapshotAtomFamily.remove('session-1' as SessionId);
    sessionAgentRoleDurableSnapshotAtomFamily.remove('session-2' as SessionId);
    catalog.roles = [];
    catalog.agentConfigs = [agentConfig];
    catalog.synced = true;
    control = null;
    hookProps = { sessionId: 'session-1', selectedModelId: 'model-1' };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it('shows the creating Role after the workspace catalog loads', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    await render({ provenanceRoleId });
    expect(control?.selectedRoleId).toBeNull();

    catalog.roles = [role('role-1', 'model-1')];
    await render({ provenanceRoleId });

    expect(control?.selectedRoleId).toBe(provenanceRoleId);
  });

  it('keeps an explicit None selection and scopes it to the current session', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    catalog.roles = [role('role-1', 'model-1')];
    await render({ provenanceRoleId });
    expect(control?.selectedRoleId).toBe(provenanceRoleId);

    await act(async () => control?.onSelect(null));
    expect(control?.selectedRoleId).toBeNull();

    await render({ provenanceRoleId });
    expect(control?.selectedRoleId).toBeNull();

    await render({ sessionId: 'session-2', provenanceRoleId });
    expect(control?.selectedRoleId).toBe(provenanceRoleId);
  });

  it('keeps explicit Role choices independently while switching Sessions', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({ sessionId: 'session-1' });
    await act(async () => control?.onSelect('role-1' as AgentRoleId));
    expect(control?.selectedRoleId).toBe('role-1');

    await render({ sessionId: 'session-2' });
    await act(async () => control?.onSelect('role-2' as AgentRoleId));
    expect(control?.selectedRoleId).toBe('role-2');

    await render({ sessionId: 'session-1' });
    expect(control?.selectedRoleId).toBe('role-1');
  });

  it('restores from the latest durable Turn and lets a newer Turn supersede a local draft', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
    });
    expect(control?.selectedRoleId).toBe('role-1');

    await act(async () => control?.onSelect('role-2' as AgentRoleId));
    expect(control?.selectedRoleId).toBe('role-2');

    await render({ durableRoleId: null, durableSourceTurnKey: 'turn:turn-2' });
    expect(control?.selectedRoleId).toBeNull();

    // Consuming the superseded draft is permanent: if a queue item disappears
    // and the resolver returns to the old history source, role-2 cannot revive.
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
    });
    expect(control?.selectedRoleId).toBe('role-1');
  });

  it('keeps a history-based draft visible while the Session doc remount hydrates', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
    });
    await act(async () => control?.onSelect('role-2' as AgentRoleId));

    await act(async () => root?.unmount());
    root = createRoot(container!);
    await render({ durableRoleReady: false });
    expect(control?.selectedRoleId).toBe('role-2');

    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
      durableRoleReady: true,
    });
    expect(control?.selectedRoleId).toBe('role-2');
  });

  it('does not mistake transient hydration defaults for manual Role drift', async () => {
    catalog.roles = [role('role-special', 'model-special')];
    await render({
      durableRoleId: 'role-special' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
      selectedModelId: 'model-special',
    });

    await act(async () => root?.unmount());
    root = createRoot(container!);
    await render({ durableRoleReady: false, selectedModelId: 'provider-default' });

    expect(control?.selectedRoleId).toBe('role-special');
    expect(control?.turnSelection).toEqual({
      agentRoleId: 'role-special',
      agentRoleRevision: 1,
    });
  });

  it('keeps an unsent Role through queue lifecycle and older backfill', async () => {
    catalog.roles = [role('role-1', 'model-1'), role('role-2', 'model-1')];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-2',
      durableKnownSourceTurnKeys: ['turn:turn-2', 'turn:turn-1'],
    });
    await act(async () => control?.onSelect('role-2' as AgentRoleId));

    // Older backfill extends the lineage without changing its current Turn.
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-2',
      durableKnownSourceTurnKeys: ['turn:turn-2', 'turn:turn-1', 'turn:turn-0'],
    });
    expect(control?.selectedRoleId).toBe('role-2');

    // Falling back to an older Turn that was already known is not a new Turn.
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 1,
      durableSourceTurnKey: 'turn:turn-1',
      durableKnownSourceTurnKeys: ['turn:turn-1'],
    });
    expect(control?.selectedRoleId).toBe('role-2');
  });

  it('preserves durable Role metadata while its catalog row is still syncing', async () => {
    catalog.synced = false;
    catalog.roles = [];
    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 5,
      durableSourceTurnKey: 'turn:turn-1',
    });
    expect(control?.selectedRoleId).toBeNull();
    expect(control?.turnSelection).toEqual({
      agentRoleId: 'role-1',
      agentRoleRevision: 5,
    });

    await render({
      durableRoleId: 'role-1' as AgentRoleId,
      durableRoleRevision: 5,
      durableSourceTurnKey: 'turn:turn-1',
      runConfigHasUserEdits: true,
      selectedModelId: 'model-2',
    });
    expect(control?.turnSelection).toBeUndefined();
  });

  it('does not name the provenance Role after its run config changes', async () => {
    const provenanceRoleId = 'role-1' as AgentRoleId;
    catalog.roles = [role('role-1', 'model-1')];

    await render({ provenanceRoleId, selectedModelId: 'model-2' });

    expect(control?.selectedRoleId).toBeNull();
  });
});
