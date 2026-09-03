/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findPermissionNotAppliedRetryTarget,
  useOneShotAction,
} from '../src/lib/permission-not-applied-retry';

const stoppedTurn = (overrides?: Record<string, unknown>) => ({
  id: 'user-1',
  role: 'user',
  inputConfig: {
    inputBlocks: [{ type: 'text', text: 'ship it' }],
    modeId: 'plan',
    modelId: 'model-b',
    configOptionValues: { reasoning_effort: 'high' },
    agentRoleId: 'role-1',
    agentRoleRevision: 3,
    ...overrides,
  },
});

const failureNotice = (permission?: { requestedModeId: string; effectiveModeId: string }) => ({
  id: 'notice-1',
  role: 'system',
  items: [
    {
      type: 'system_notice',
      name: 'chat_failed',
      meta: {
        reason: 'permission_not_applied',
        ...(permission ? { permission } : {}),
      },
    },
  ],
});

describe('findPermissionNotAppliedRetryTarget', () => {
  it('replays the stopped turn, not the composer', () => {
    const target = findPermissionNotAppliedRetryTarget([
      {
        id: 'user-0',
        role: 'user',
        inputConfig: { inputBlocks: [{ type: 'text', text: 'older' }] },
      },
      { id: 'assistant-0', role: 'assistant' },
      stoppedTurn(),
      failureNotice({ requestedModeId: 'plan', effectiveModeId: 'auto' }),
    ]);

    expect(target).toEqual({
      noticeId: 'notice-1',
      requestedModeId: 'plan',
      effectiveModeId: 'auto',
      userTurnId: 'user-1',
      inputBlocks: [{ type: 'text', text: 'ship it' }],
      modeId: 'plan',
      modelId: 'model-b',
      configOptionValues: { reasoning_effort: 'high' },
      agentRoleId: 'role-1',
      agentRoleRevision: 3,
    });
  });

  it("keeps the stopped turn's tool reach, including an explicit empty selection", () => {
    // The composer may hold a different MCP selection by now; replaying with it
    // would pair the old prompt with tool permissions that turn never had.
    const target = findPermissionNotAppliedRetryTarget([
      stoppedTurn({ mcpServerIds: [], taskToolsEnabled: false, issuePRMentions: [{ number: 7 }] }),
      failureNotice({ requestedModeId: 'plan', effectiveModeId: 'auto' }),
    ]);

    expect(target?.mcpServerIds).toEqual([]);
    expect(target?.taskToolsEnabled).toBe(false);
    expect(target?.issuePRMentions).toEqual([{ number: 7 }]);
  });

  it('stands down once the user has sent something newer', () => {
    // Replaying now would inject the old turn behind whatever they just sent.
    expect(
      findPermissionNotAppliedRetryTarget([
        stoppedTurn(),
        failureNotice({ requestedModeId: 'plan', effectiveModeId: 'auto' }),
        {
          id: 'user-2',
          role: 'user',
          inputConfig: { inputBlocks: [{ type: 'text', text: 'next' }] },
        },
      ])
    ).toBeNull();
  });

  it('ignores failures that are not this one, and notices without both modes', () => {
    expect(
      findPermissionNotAppliedRetryTarget([
        stoppedTurn(),
        {
          id: 'notice-other',
          role: 'system',
          items: [
            { type: 'system_notice', name: 'chat_failed', meta: { reason: 'agent_disconnected' } },
          ],
        },
      ])
    ).toBeNull();

    // A notice from a machine that predates the structured meta cannot name the
    // permissions, so it gets no action rather than a vague one.
    expect(findPermissionNotAppliedRetryTarget([stoppedTurn(), failureNotice()])).toBeNull();
  });

  it('declines when the stopped turn kept no frozen blocks to replay', () => {
    expect(
      findPermissionNotAppliedRetryTarget([
        { id: 'user-1', role: 'user', inputConfig: { modeId: 'plan' } },
        failureNotice({ requestedModeId: 'plan', effectiveModeId: 'auto' }),
      ])
    ).toBeNull();
  });
});

describe('useOneShotAction', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mount = (action: () => Promise<void>) => {
    const seen: { pending: boolean; run: () => void }[] = [];
    const Probe = () => {
      seen.push(useOneShotAction(action));
      return null;
    };
    act(() => root.render(<Probe />));
    return { latest: () => seen[seen.length - 1]! };
  };

  it('runs once while a run is open, however many times it is invoked', async () => {
    let resolve: (() => void) | undefined;
    const action = vi.fn(
      async () =>
        await new Promise<void>((r) => {
          resolve = r;
        })
    );
    const probe = mount(action);

    act(() => {
      probe.latest().run();
      // The second click lands before React re-renders with `pending`, so the
      // disabled attribute cannot be what stops it.
      probe.latest().run();
      probe.latest().run();
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(probe.latest().pending).toBe(true);

    await act(async () => {
      resolve?.();
    });
    expect(probe.latest().pending).toBe(false);
  });

  it('stays usable after a failed attempt', async () => {
    const action = vi.fn(async () => {
      throw new Error('dispatch refused');
    });
    const probe = mount(action);

    await act(async () => {
      probe.latest().run();
    });
    expect(probe.latest().pending).toBe(false);

    await act(async () => {
      probe.latest().run();
    });
    expect(action).toHaveBeenCalledTimes(2);
  });
});
