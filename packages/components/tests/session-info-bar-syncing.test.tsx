// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_GOAL_COMMANDS, type SessionGoalMessage } from '@lody/shared';
import { SessionInfoBar } from '../src/components/sessions/session-info-bar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A context-less chat session: every cluster/stage item absent. */
const CONTEXT_LESS_PROPS = {
  status: null,
  projectName: null,
  branch: null,
  workspaceLocation: null,
  pr: null,
  diffStat: null,
} as const;

const ACTIVE_GOAL: SessionGoalMessage = {
  type: 'goal',
  threadId: 'thread-1',
  objective: 'Ship the ACP update',
  status: 'active',
};

describe('SessionInfoBar syncing indicator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the bar for syncing alone on a context-less session', () => {
    act(() => {
      root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} syncing />);
    });

    expect(container.textContent).toContain('Syncing');
    // Sync-only mode: no staged item, no divider — the spinner keeps its
    // right-edge pin via the ml-auto wrapper.
    const wrapper = container.querySelector('.ml-auto');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.textContent).toContain('Syncing');
  });

  it('still hides the bar entirely with no items and no syncing', () => {
    act(() => {
      root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} />);
    });

    expect(container.innerHTML).toBe('');
  });

  it('renders and activates a reported preview action without staged context', () => {
    const onOpenBrowser = vi.fn();
    act(() => {
      root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} onOpenBrowser={onOpenBrowser} />);
    });

    const openPreview = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open preview"]'
    );
    expect(openPreview).not.toBeNull();

    act(() => openPreview?.click());
    expect(onOpenBrowser).toHaveBeenCalledOnce();
  });

  it('renders the indicator alongside context when items are present', () => {
    act(() => {
      root.render(<SessionInfoBar status={null} projectName="loro-dev/lody" syncing />);
    });

    expect(container.textContent).toContain('loro-dev/lody');
    expect(container.textContent).toContain('Syncing');
  });

  it('keeps a neutral goal read-only when no commands are supported', () => {
    act(() => {
      root.render(
        <SessionInfoBar
          {...CONTEXT_LESS_PROPS}
          goal={ACTIVE_GOAL}
          goalCommands={[]}
          onGoalCommand={vi.fn()}
        />
      );
    });

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Goal"]')?.click());

    expect(document.body.textContent).not.toContain('Pause');
    expect(document.body.textContent).not.toContain('Clear');
  });

  it('shows and dispatches Codex prompt-bridge goal commands', () => {
    const onGoalCommand = vi.fn();
    act(() => {
      root.render(
        <SessionInfoBar
          {...CONTEXT_LESS_PROPS}
          goal={ACTIVE_GOAL}
          goalCommands={SESSION_GOAL_COMMANDS}
          onGoalCommand={onGoalCommand}
        />
      );
    });

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Goal"]')?.click());
    const pauseButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Pause'
    );
    expect(pauseButton).toBeDefined();
    expect(document.body.textContent).toContain('Clear');

    act(() => pauseButton?.click());
    expect(onGoalCommand).toHaveBeenCalledWith('pause', ACTIVE_GOAL);
  });

  it('shows and dispatches Resume for a blocked Codex goal', () => {
    const blockedGoal: SessionGoalMessage = { ...ACTIVE_GOAL, status: 'blocked' };
    const onGoalCommand = vi.fn();
    act(() => {
      root.render(
        <SessionInfoBar
          {...CONTEXT_LESS_PROPS}
          goal={blockedGoal}
          goalCommands={SESSION_GOAL_COMMANDS}
          onGoalCommand={onGoalCommand}
        />
      );
    });

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Goal"]')?.click());
    const resumeButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Resume'
    );
    expect(resumeButton).toBeDefined();

    act(() => resumeButton?.click());
    expect(onGoalCommand).toHaveBeenCalledWith('resume', blockedGoal);
  });
});
