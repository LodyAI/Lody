// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRoleProposalNotice } from '../src/components/ai-gui/agent-role-proposal-notice';
import { initI18n } from '../src/i18n';
import type { AgentRole, AgentRoleProposalMeta, SessionId } from '@lody/shared';

const state = vi.hoisted(() => ({
  runtime: {} as unknown,
  rows: new Map<string, unknown>(),
  meta: {} as AgentRoleProposalMeta,
  failSave: false,
}));
vi.mock('@/atoms', async () => ({ userAtom: (await import('jotai')).atom({ id: 'user' }) }));
vi.mock('@/atoms/agents', async () => ({
  getAllAgentConfigAtom: (await import('jotai')).atom([
    { id: 'agent', machineId: 'machine', name: 'Code Agent' },
  ]),
}));
vi.mock('@/atoms/runtime', async () => ({
  activeWorkspaceRuntimeAtom: (await import('jotai')).atom(() => state.runtime),
}));
vi.mock('@/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigsForMachineIds: () => undefined,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const render = async () => {
  await act(async () =>
    root.render(
      <AgentRoleProposalNotice
        meta={state.meta}
        sessionId={'session' as SessionId}
        entryId="proposal"
        itemIndex={0}
      />
    )
  );
};
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
};

beforeEach(async () => {
  await initI18n('en');
  state.rows.clear();
  state.failSave = false;
  state.meta = {
    roleId: 'role',
    requesterUserId: 'user',
    command: {
      action: 'create',
      requestId: 'request',
      name: 'Reviewer',
      machineId: 'machine',
      agentConfigId: 'agent',
      promptPrefix: 'Review carefully',
    },
  };
  state.runtime = {
    workspaceId: 'workspace',
    repo: {
      openFlockDoc: async () => ({
        syncOnce: async () => {},
        flock: {
          scan: () => [...state.rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
        },
      }),
    },
    writer: {
      flockRowPut: async (_doc: string, key: unknown, value: unknown) => {
        if (state.failSave) throw new Error('Storage unavailable');
        state.rows.set(JSON.stringify(key), value);
      },
    },
    withSessionStore: async (_sessionId: string, run: (store: unknown) => Promise<void>) =>
      run({
        sessionData: {
          history: {
            readTurn: () => ({
              state: 'ready',
              turn: {
                id: 'proposal',
                role: 'system',
                items: [{ type: 'system_notice', name: 'agent_role_proposal', meta: state.meta }],
              },
            }),
          },
          commands: {
            replaceTurn: async (
              _id: string,
              turn: { items: { meta: AgentRoleProposalMeta }[] }
            ) => {
              state.meta = turn.items[0]!.meta;
            },
          },
        },
      }),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Role proposal confirmation', () => {
  it('leaves the catalog untouched until Save and persists a receipt', async () => {
    await render();
    expect(state.rows.size).toBe(0);
    await click('Save');
    expect([...state.rows.values()]).toEqual([
      expect.objectContaining({
        id: 'role',
        name: 'Reviewer',
        promptPrefix: 'Review carefully',
        visibility: 'private',
      }),
    ]);
    expect(state.meta.outcome).toBe('saved');
    expect(container.textContent).toContain('Agent Role saved');
    expect([...container.querySelectorAll('button')]).toHaveLength(0);
  });
  it('dismisses without changing the catalog', async () => {
    await render();
    await click('Dismiss');
    expect(state.rows.size).toBe(0);
    expect(state.meta.outcome).toBe('dismissed');
  });
  it('keeps a failed save actionable and reports the error', async () => {
    state.failSave = true;
    await render();
    await click('Save');
    expect(state.rows.size).toBe(0);
    expect(state.meta.outcome).toBeUndefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable');
    state.failSave = false;
    await click('Save');
    expect(state.meta.outcome).toBe('saved');
  });
  it('applies only the patch to the latest row, even when it changed after the proposal', async () => {
    const current = {
      v: 1,
      id: 'role',
      ownerUserId: 'user',
      visibility: 'private',
      name: 'Latest name',
      description: 'Keep',
      promptPrefix: 'Old',
      machineId: 'machine',
      agentConfigId: 'agent',
      runConfig: { modelId: 'model' },
      revision: 7,
      createdAt: 0,
      updatedAt: 1,
    };
    state.rows.set(JSON.stringify(['agentRole', 'role']), current);
    state.meta = {
      roleId: 'role',
      requesterUserId: 'user',
      before: { name: 'Earlier name', promptPrefix: 'Old' },
      command: {
        action: 'update',
        requestId: 'request',
        roleId: 'role',
        patch: { promptPrefix: 'New instruction' },
      },
    };
    await render();
    await click('Save');
    const saved = [...state.rows.values()][0] as AgentRole;
    expect(saved).toMatchObject({
      ...current,
      promptPrefix: 'New instruction',
      revision: 8,
      updatedAt: expect.any(Number),
    });
    expect(state.meta.outcome).toBe('saved');
  });
});
