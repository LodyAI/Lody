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
  appendTabOrderId,
  buildDraftSessionAgentRolePatch,
  createDraftSessionTab,
  filterPendingPromotedChildSessions,
  getDraftTabLabel,
  isDraftSessionTabId,
  mergeTabOrderGroup,
  readPersistedDraftTabs,
  readStoredLastActiveTabState,
  removeTabOrderId,
  replaceTabOrderId,
  writePersistedDraftTabs,
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
  it('creates draft ids with the expected prefix', () => {
    const draft = createDraftSessionTab({
      cliType: 'builtin',
      agentType: 'codex',
      modeId: null,
      modelId: null,
    });

    expect(isDraftSessionTabId(draft.id)).toBe(true);
    expect(draft.sessionId).not.toContain(':');
    expect(draft.sessionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(draft.prompt).toBe('');
  });

  it('applies a Role as a complete new-child-Session Agent selection', () => {
    const role = {
      v: 1,
      id: 'reviewer' as AgentRoleId,
      ownerUserId: 'user-1',
      visibility: 'private',
      name: 'Reviewer',
      machineId: 'machine-1' as MachineId,
      agentConfigId: 'claude-config' as AgentConfigId,
      runConfig: {
        modeId: 'plan',
        modelId: 'claude-opus',
        configOptionValues: { thought_level: 'high' },
      },
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
    } satisfies AgentRole;
    const agentConfig = {
      id: role.agentConfigId,
      machineId: role.machineId,
      name: 'Claude',
      description: undefined,
      cliType: 'builtin',
      agentType: 'claude',
      env: {},
    } satisfies AgentConfigMeta;

    expect(buildDraftSessionAgentRolePatch(role, agentConfig)).toEqual({
      agentRoleId: role.id,
      agentConfigId: role.agentConfigId,
      cliType: 'builtin',
      agentType: 'claude',
      modeId: 'plan',
      modelId: 'claude-opus',
      configOptionValues: { thought_level: 'high' },
    });
  });

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

  it('hydrates legacy persisted draft tabs with an upload-safe session id', () => {
    installWindowStorage();
    localStorage.setItem(
      'lody:draft-tabs:session-1',
      JSON.stringify([
        {
          id: 'draft:legacy',
          prompt: 'Review this branch',
          cliType: 'builtin',
          agentType: 'codex',
          modeId: null,
          modelId: null,
        },
      ])
    );

    const drafts = readPersistedDraftTabs('session-1' as SessionId);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.sessionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('preserves a persisted draft session id when it is upload-safe', () => {
    installWindowStorage();
    const validSessionId = 'child-session-abc123';
    localStorage.setItem(
      'lody:draft-tabs:session-1',
      JSON.stringify([
        {
          id: 'draft:keep-id',
          sessionId: validSessionId,
          prompt: 'Review this branch',
          cliType: 'builtin',
          agentType: 'codex',
          modeId: null,
          modelId: null,
        },
      ])
    );

    const drafts = readPersistedDraftTabs('session-1' as SessionId);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.sessionId).toBe(validSessionId);
  });

  it('persists the selected Role identity with a non-empty child-tab draft', () => {
    installWindowStorage();
    const draft = createDraftSessionTab({
      cliType: 'builtin',
      agentType: 'codex',
      modeId: null,
      modelId: null,
    });
    draft.prompt = 'Review this branch';
    draft.agentRoleId = 'reviewer' as AgentRoleId;

    writePersistedDraftTabs('session-1' as SessionId, [draft]);

    expect(readPersistedDraftTabs('session-1' as SessionId)[0]?.agentRoleId).toBe('reviewer');
  });

  it('replaces a persisted draft session id that is not upload-safe', () => {
    installWindowStorage();
    localStorage.setItem(
      'lody:draft-tabs:session-1',
      JSON.stringify([
        {
          id: 'draft:bad-id',
          sessionId: 'draft:not-a-valid-path-segment',
          prompt: 'Review this branch',
          cliType: 'builtin',
          agentType: 'codex',
          modeId: null,
          modelId: null,
        },
      ])
    );

    const drafts = readPersistedDraftTabs('session-1' as SessionId);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.sessionId).not.toBe('draft:not-a-valid-path-segment');
    expect(drafts[0]?.sessionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('restores a persisted custom-provider draft tab', () => {
    installWindowStorage();
    localStorage.setItem(
      'lody:draft-tabs:session-1',
      JSON.stringify([
        {
          id: 'draft:custom',
          sessionId: 'child-session-custom',
          prompt: 'Run with my own ACP agent',
          cliType: 'custom',
          agentType: 'custom-1234',
          modeId: null,
          modelId: null,
        },
      ])
    );

    const drafts = readPersistedDraftTabs('session-1' as SessionId);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.cliType).toBe('custom');
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

  it('uses the first non-empty line as the draft tab label', () => {
    expect(getDraftTabLabel({ prompt: '\n  Review this diff\nAnd add tests' })).toBe(
      'Review this diff'
    );
    expect(getDraftTabLabel({ prompt: '   ' }, 'Fallback')).toBe('Fallback');
  });

  it('replaces a draft tab id with a session id while preserving order', () => {
    expect(replaceTabOrderId(['a', 'draft:1', 'c'], 'draft:1', 'session-2')).toEqual([
      'a',
      'session-2',
      'c',
    ]);
  });

  it('seeds a missing order with displayed tabs before appending a new tab', () => {
    const initialOrder = appendTabOrderId([], ['child-1', 'child-2'], 'draft:3');

    expect(initialOrder).toEqual(['child-1', 'child-2', 'draft:3']);
    expect(replaceTabOrderId(initialOrder, 'draft:3', 'child-3')).toEqual([
      'child-1',
      'child-2',
      'child-3',
    ]);
  });

  it('removes a tab id from stored order', () => {
    expect(removeTabOrderId(['a', 'draft:1', 'c'], 'draft:1')).toEqual(['a', 'c']);
  });

  it('reorders one tab group without dropping the others', () => {
    expect(
      mergeTabOrderGroup(
        ['session-2', 'diff:1', 'draft:1', 'file:src/app.ts'],
        ['draft:1', 'session-2'],
        ['session-2', 'draft:1']
      )
    ).toEqual(['draft:1', 'session-2', 'diff:1', 'file:src/app.ts']);
  });

  it('keeps omitted group ids after the reordered subset', () => {
    expect(
      mergeTabOrderGroup(
        ['diff:1', 'file:src/app.ts', 'diff:2', 'session-2'],
        ['file:src/app.ts'],
        ['diff:1', 'file:src/app.ts', 'diff:2']
      )
    ).toEqual(['file:src/app.ts', 'diff:1', 'diff:2', 'session-2']);
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

  it('persists and restores the last active session tab without a viewer', () => {
    installWindowStorage();

    writeStoredLastActiveTabState('session-1', {
      sessionTabId: 'child-session-2',
      viewerTab: null,
      sidePanel: {
        open: true,
        tab: 'files',
        tabs: ['files'],
        sideSessionId: 'side-session-1',
      },
    });

    expect(readStoredLastActiveTabState('session-1')).toEqual({
      sessionTabId: 'child-session-2',
      viewerTab: null,
      sidePanel: {
        open: true,
        tab: 'files',
        tabs: ['files'],
        sideSessionId: 'side-session-1',
      },
    });
  });

  it('persists the browser side panel under the browser key', () => {
    installWindowStorage();

    writeStoredLastActiveTabState('session-1', {
      sessionTabId: 'session-1',
      viewerTab: null,
      sidePanel: {
        open: true,
        tab: 'browser',
        tabs: ['files', 'browser'],
        sideSessionId: null,
      },
    });

    expect(readStoredLastActiveTabState('session-1')?.sidePanel).toEqual({
      open: true,
      tab: 'browser',
      tabs: ['files', 'browser'],
      sideSessionId: null,
    });
  });

  it('migrates the old always-visible side panel tabs to the new empty state', () => {
    installWindowStorage();
    localStorage.setItem(
      'lody:last-active-tab:session-1',
      JSON.stringify({
        sessionTabId: 'session-1',
        viewerTab: null,
        sidePanel: { open: true, tab: 'changes' },
      })
    );

    expect(readStoredLastActiveTabState('session-1')?.sidePanel).toEqual({
      open: true,
      tab: null,
      tabs: [],
      sideSessionId: null,
    });
  });

  it('rejects the removed preview side panel key instead of migrating it', () => {
    installWindowStorage();
    localStorage.setItem(
      'lody:last-active-tab:session-1',
      JSON.stringify({
        sessionTabId: 'session-1',
        viewerTab: null,
        sidePanel: { open: true, tab: 'preview' },
      })
    );

    expect(readStoredLastActiveTabState('session-1')).toBeNull();
  });

  it('persists and restores the last active diff viewer tab', () => {
    installWindowStorage();

    writeStoredLastActiveTabState('session-1', {
      sessionTabId: 'child-session-2',
      viewerTab: {
        id: 'diff:turn-1:src/app.ts',
        type: 'diff',
        turnId: 'turn-1',
        filePaths: ['src/app.ts'],
        focusFilePath: 'src/app.ts',
        focusComment: {
          source: 'lody',
          path: 'src/app.ts',
          lineNumber: 42,
          side: 'additions',
          threadId: 'thread-1',
        },
        focusRequestSeq: 4,
        mode: 'conversation',
        label: 'app.ts',
      },
    });

    expect(readStoredLastActiveTabState('session-1')).toEqual({
      sessionTabId: 'child-session-2',
      viewerTab: {
        id: 'diff:turn-1:src/app.ts',
        type: 'diff',
        turnId: 'turn-1',
        filePaths: ['src/app.ts'],
        focusFilePath: 'src/app.ts',
        focusComment: {
          source: 'lody',
          path: 'src/app.ts',
          lineNumber: 42,
          side: 'additions',
          threadId: 'thread-1',
        },
        focusRequestSeq: 4,
        mode: 'conversation',
        label: 'app.ts',
      },
    });
  });

  it('persists and restores provider file viewer identity by file id', () => {
    installWindowStorage();

    writeStoredLastActiveTabState('session-1', {
      sessionTabId: 'child-session-2',
      viewerTab: {
        id: 'file:t:old-file',
        type: 'file',
        filePath: 'src/renamed.ts',
        fileId: 't:old-file',
        label: 'renamed.ts',
        startLine: 7,
        endLine: 9,
        focusRequestSeq: 3,
      },
    });

    expect(readStoredLastActiveTabState('session-1')).toEqual({
      sessionTabId: 'child-session-2',
      viewerTab: {
        id: 'file:t:old-file',
        type: 'file',
        filePath: 'src/renamed.ts',
        fileId: 't:old-file',
        label: 'renamed.ts',
        startLine: 7,
        endLine: 9,
        focusRequestSeq: 3,
      },
    });
  });
});
