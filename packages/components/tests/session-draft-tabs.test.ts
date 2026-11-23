import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentConfigId,
  AgentConfigMeta,
  AgentRole,
  AgentRoleId,
  MachineId,
  SessionId,
} from '@lody/shared';

import {
  buildDraftSessionAgentRolePatch,
  filterPendingPromotedChildSessions,
  readPersistedDraftTabs,
  readStoredLastActiveTabState,
  writeStoredLastActiveTabState,
} from '../src/lib/session-draft-tabs';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

const installWindowStorage = () => {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
};

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }

  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('session draft tabs', () => {
  it('refuses to apply a Role through a different Agent Config binding', () => {
    const role = {
      v: 1,
      id: 'reviewer' as AgentRoleId,
      ownerUserId: 'user-1',
      visibility: 'private',
      name: 'Reviewer',
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'codex-config' as AgentConfigId,
      runConfig: {},
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } satisfies AgentRole;
    const wrongConfig = {
      id: 'claude-config' as AgentConfigId,
      machineId: role.machineId,
      name: 'Claude',
      description: undefined,
      cliType: 'builtin',
      agentType: 'claude',
      env: {},
    } satisfies AgentConfigMeta;

    expect(buildDraftSessionAgentRolePatch(role, wrongConfig)).toBeNull();
  });

  it('does not discard sibling drafts when one uses a custom provider', () => {
    installWindowStorage();
    localStorage.setItem(
      'lody:draft-tabs:session-1',
      JSON.stringify([
        {
          id: 'draft:builtin',
          sessionId: 'child-session-builtin',
          prompt: 'Builtin draft',
          cliType: 'builtin',
          agentType: 'codex',
          modeId: null,
          modelId: null,
        },
        {
          id: 'draft:custom',
          sessionId: 'child-session-custom',
          prompt: 'Custom draft',
          cliType: 'custom',
          agentType: 'custom-1234',
          modeId: null,
          modelId: null,
        },
      ])
    );

    // safeParse over the array is all-or-nothing: a stale enum that rejected the
    // custom element would wipe the builtin sibling too.
    const drafts = readPersistedDraftTabs('session-1' as SessionId);

    expect(drafts).toHaveLength(2);
  });

  it('hides a child session while the draft it replaces is still present', () => {
    expect(
      filterPendingPromotedChildSessions(
        [{ id: 'child-1' }, { id: 'child-2' }],
        [
          {
            id: 'draft:1',
            sessionId: 'draft-session-1' as SessionId,
            prompt: 'Review this diff',
            cliType: 'builtin',
            agentType: 'codex',
            modeId: null,
            modelId: null,
          },
        ],
        { 'draft:1': 'child-1' }
      )
    ).toEqual([{ id: 'child-2' }]);
  });

  it('shows a promoted child after its source draft has been removed', () => {
    expect(
      filterPendingPromotedChildSessions([{ id: 'child-1' }], [], { 'draft:1': 'child-1' })
    ).toEqual([{ id: 'child-1' }]);
  });

  it('restores a device split only while both of its tabs are open', () => {
    installWindowStorage();

    writeStoredLastActiveTabState('session-1', {
      sessionTabId: 'session-1',
      viewerTab: null,
      sidePanel: {
        open: true,
        tab: 'android-emulator',
        tabs: ['ios-simulator', 'android-emulator'],
        sideSessionId: null,
        split: ['android-emulator', 'ios-simulator'],
      },
    });
    expect(readStoredLastActiveTabState('session-1')?.sidePanel.split).toEqual([
      'android-emulator',
      'ios-simulator',
    ]);

    localStorage.setItem(
      'lody:last-active-tab:session-1',
      JSON.stringify({
        sessionTabId: 'session-1',
        viewerTab: null,
        sidePanel: {
          open: true,
          tab: 'ios-simulator',
          tabs: ['ios-simulator'],
          split: ['ios-simulator', 'android-emulator'],
        },
      })
    );
    expect(readStoredLastActiveTabState('session-1')?.sidePanel.split).toBeNull();
  });
});
