// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_GOAL_COMMANDS, type SessionGoalMessage } from '@lody/shared';
import { SessionInfoBar } from '../src/components/sessions/session-info-bar';
import type { SessionMachineInfo } from '../src/components/sessions/session-machine-info';

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

const MACHINE: SessionMachineInfo = {
  machineId: 'machine-1' as SessionMachineInfo['machineId'],
  name: 'MacBook-Pro.local',
  ownerName: 'Maya Chen',
  isOwn: false,
  isCurrent: false,
  onlineStatus: 'online',
};

describe('SessionInfoBar ambient information', () => {
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

  it('says Updating while a cached conversation catches up, and hides for a null status', () => {
    act(() => {
      root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} syncStatus="updating" />);
    });
    expect(container.querySelector('.ml-auto')?.textContent).toContain('Updating');

    // An explicit null status wins over the legacy flag: nothing to announce.
    act(() => {
      root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} syncing syncStatus={null} />);
    });
    expect(container.textContent).toBe('');
  });

  it('still hides the bar entirely with no items and no syncing', () => {
    act(() => {
      root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} />);
    });

    // No bar is shown: only the hidden spacer that keeps the composer's gap.
    expect(container.textContent).toBe('');
    expect(container.querySelector('button, [role]')).toBeNull();
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a simulator-only action and keeps browser and simulator actions independent', () => {
    function Actions({ withBrowser = false }: { withBrowser?: boolean }) {
      const [opened, setOpened] = useState('');
      return (
        <>
          <SessionInfoBar
            {...CONTEXT_LESS_PROPS}
            onOpenIosSimulator={() => setOpened('Simulator')}
            onOpenBrowser={withBrowser ? () => setOpened('Browser') : undefined}
          />
          <output>{opened}</output>
        </>
      );
    }
    act(() => root.render(<Actions />));
    const action = container.querySelector<HTMLButtonElement>(
      'button[aria-label="iOS Simulator"]'
    )!;
    expect(action).not.toBeNull();
    act(() => action.click());
    expect(container.querySelector('output')?.textContent).toBe('Simulator');
    expect(container.querySelector('button[aria-label="Open preview"]')).toBeNull();
    act(() => root.render(<Actions withBrowser />));
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Open preview"]')!.click()
    );
    expect(container.querySelector('output')?.textContent).toBe('Browser');
    act(() => action.click());
    expect(container.querySelector('output')?.textContent).toBe('Simulator');
  });

  it('opens Android directly when it is the only simulator preview', () => {
    const openAndroid = vi.fn();
    act(() =>
      root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} onOpenAndroidEmulator={openAndroid} />)
    );
    const action = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Android Emulator"]'
    );
    expect(action).not.toBeNull();
    act(() => action!.click());
    expect(openAndroid).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([false, true])(
    'chooses either simulator from one popover (compact=%s)',
    (compactMachineInfo) => {
      const openIos = vi.fn();
      const openAndroid = vi.fn();
      act(() =>
        root.render(
          <SessionInfoBar
            {...CONTEXT_LESS_PROPS}
            compactMachineInfo={compactMachineInfo}
            onOpenIosSimulator={openIos}
            onOpenAndroidEmulator={openAndroid}
          />
        )
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="iOS Simulator / Android Emulator"]'
      );
      expect(trigger).not.toBeNull();
      expect(container.querySelectorAll('button')).toHaveLength(1);
      for (const label of ['Android Emulator', 'iOS Simulator']) {
        act(() => trigger!.click());
        const dialog = document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        const option = Array.from(dialog!.querySelectorAll('button')).find(
          (button) => button.textContent === label
        );
        expect(option).toBeDefined();
        act(() => option!.click());
        expect(trigger!.getAttribute('aria-expanded')).toBe('false');
        expect(openAndroid).toHaveBeenCalledTimes(1);
        expect(openIos).toHaveBeenCalledTimes(label === 'iOS Simulator' ? 1 : 0);
      }
    }
  );

  it('shows the execution target alone while keeping owner details out of the resting bar', () => {
    act(() => root.render(<SessionInfoBar {...CONTEXT_LESS_PROPS} machine={MACHINE} />));
    expect(container.textContent).toBe(MACHINE.name);
    const surface = container.querySelector('[data-info-bar-surface]');
    expect(surface).not.toBeNull();
    expect(surface!.className).toContain('rounded-lg');
    expect(container.querySelector('img')).toBeNull();
    expect(document.body.textContent).not.toContain('Maya Chen');
    act(() => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.body.textContent).toContain('Machine owner');
    expect(document.body.textContent).toContain('Maya Chen');
    expect(document.body.textContent).toContain('Another device');
    expect(document.body.textContent).toContain('Online');
  });

  it('opens full machine details from the mobile icon without guessing the local device', () => {
    act(() =>
      root.render(
        <SessionInfoBar
          {...CONTEXT_LESS_PROPS}
          machine={{ ...MACHINE, isCurrent: undefined }}
          compactMachineInfo
        />
      )
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Machine details: ${MACHINE.name}"]`
    )!;
    expect(trigger).not.toBeNull();
    expect(container.textContent).toBe('');
    expect(document.body.textContent).not.toContain('Maya Chen');
    act(() => trigger.click());
    const card = document.body.querySelector('[role="dialog"]')!;
    expect(card.textContent).toContain(MACHINE.name);
    expect(card.textContent).toContain('Maya Chen');
    expect(card.textContent).toContain('Online');
    expect(card.textContent).not.toContain('This device');
    expect(card.textContent).not.toContain('Another device');
  });

  it('keeps mobile privacy and repository actions independent of machine details', () => {
    function PrivateSession() {
      const [opened, setOpened] = useState('');
      return (
        <>
          <SessionInfoBar
            {...CONTEXT_LESS_PROPS}
            machine={MACHINE}
            compactMachineInfo
            projectName="LodyAI/Lody"
            diffStat={{ add: 128, del: 42 }}
            privateAccessStatus={{
              label: 'Private · Only you',
              description: 'Only you can access this private session',
              onAction: () => setOpened('Sharing'),
            }}
            contextActions={[
              { id: 'create-pr', label: 'Create PR', onClick: () => setOpened('Create PR') },
            ]}
          />
          <output>{opened}</output>
        </>
      );
    }
    act(() => root.render(<PrivateSession />));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Only you can access this private session"]'
        )!
        .click()
    );
    expect(container.querySelector('output')?.textContent).toBe('Sharing');
    const createPr = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Create PR'
    )!;
    expect(createPr).toBeDefined();
    act(() => createPr.click());
    expect(container.querySelector('output')?.textContent).toBe('Create PR');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(`button[aria-label="Machine details: ${MACHINE.name}"]`)!
        .click()
    );
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(MACHINE.name);
    expect(container.querySelector('output')?.textContent).toBe('Create PR');
  });

  it.each([
    { layout: 'desktop', compact: false },
    { layout: 'mobile', compact: true },
  ])('keeps the machine accessible as other items take the stage on $layout', ({ compact }) => {
    act(() =>
      root.render(
        <SessionInfoBar
          status={null}
          machine={MACHINE}
          compactMachineInfo={compact}
          projectName="LodyAI/Lody"
        />
      )
    );
    act(() =>
      root.render(
        <SessionInfoBar
          status={null}
          machine={MACHINE}
          compactMachineInfo={compact}
          projectName="LodyAI/Lody"
          goal={ACTIVE_GOAL}
        />
      )
    );
    expect(
      container.querySelector(`button[aria-label="Machine details: ${MACHINE.name}"]`)
    ).not.toBeNull();
    if (!compact) expect(container.textContent).toContain(MACHINE.name);
    expect(container.textContent).toContain(ACTIVE_GOAL.objective);
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="LodyAI/Lody"]')!.click()
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Machine details: ${MACHINE.name}"]`
    )!;
    expect(trigger).not.toBeNull();
    if (!compact) expect(container.textContent).toContain(MACHINE.name);
    expect(container.textContent).toContain('LodyAI/Lody');
    expect(container.textContent).not.toContain('Maya Chen');
    act(() => trigger.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Maya Chen');
  });

  it.each(['offline', 'unknown'] as const)(
    'keeps identity available with %s presence',
    (onlineStatus) => {
      act(() =>
        root.render(
          <SessionInfoBar
            {...CONTEXT_LESS_PROPS}
            machine={{ ...MACHINE, ownerName: null, onlineStatus }}
          />
        )
      );
      expect(container.textContent).toBe(MACHINE.name);
      act(() => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(document.body.textContent).toContain('Unknown owner');
      expect(document.body.textContent).toContain(
        onlineStatus === 'offline' ? 'Offline' : 'Status unavailable'
      );
      if (onlineStatus === 'unknown') expect(document.body.textContent).not.toContain('Offline');
    }
  );

  it.each([
    { layout: 'desktop', compact: false },
    { layout: 'mobile', compact: true },
  ])(
    'closes the old machine card on target change and clears missing metadata on $layout',
    ({ compact }) => {
      act(() =>
        root.render(
          <SessionInfoBar {...CONTEXT_LESS_PROPS} machine={MACHINE} compactMachineInfo={compact} />
        )
      );
      act(() => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(document.body.textContent).toContain('Maya Chen');
      act(() =>
        root.render(
          <SessionInfoBar
            {...CONTEXT_LESS_PROPS}
            compactMachineInfo={compact}
            machine={{
              ...MACHINE,
              machineId: 'machine-2' as SessionMachineInfo['machineId'],
              name: 'Build Server',
              isOwn: true,
              isCurrent: true,
            }}
          />
        )
      );
      expect(container.textContent).toBe(compact ? '' : 'Build Server');
      expect(
        container.querySelector('button[aria-label="Machine details: Build Server"]')
      ).not.toBeNull();
      expect(document.body.textContent).not.toContain('Maya Chen');
      act(() => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(document.body.textContent).toContain('You');
      expect(document.body.textContent).toContain('This device');
      act(() =>
        root.render(
          <SessionInfoBar {...CONTEXT_LESS_PROPS} machine={null} compactMachineInfo={compact} />
        )
      );
      expect(container.textContent).toBe('');
      expect(container.querySelector('button')).toBeNull();
      expect(document.body.textContent).not.toContain('Build Server');
    }
  );

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
