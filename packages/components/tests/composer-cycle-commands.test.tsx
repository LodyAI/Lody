// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerCycleCommands } from '../src/hooks/use-composer-cycle-commands';
import { commands } from '../src/lib/commands';
import { CommandShortcutHost } from '../src/lib/commands/shortcut-host';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type CycleCommandProbeProps = {
  id: string;
  enabled: boolean;
  onModeSelect: (value: string) => void;
  onModelSelect: (value: string) => void;
  onThinkEffortSelect: (value: string) => void;
};

class MemoryStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

function CycleCommandProbe({
  id,
  enabled,
  onModeSelect,
  onModelSelect,
  onThinkEffortSelect,
}: CycleCommandProbeProps) {
  useComposerCycleCommands({
    enabled,
    mode: { values: ['ask', 'auto'], current: 'ask', onSelect: onModeSelect },
    model: { values: ['model-a', 'model-b'], current: 'model-a', onSelect: onModelSelect },
    thinkEffort: {
      values: ['medium', 'high'],
      current: 'medium',
      onSelect: onThinkEffortSelect,
    },
    provider: null,
  });

  return <textarea id={id} data-lody-composer-input="" />;
}

describe('composer cycle command ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    commands.resetAllUserKeybindings();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    commands.resetAllUserKeybindings();
    act(() => root.unmount());
    for (const command of commands.list()) commands.unregister(command.id);
    container.remove();
    vi.unstubAllGlobals();
  });

  it('routes mode, model, and thinking commands to the enabled composer', () => {
    const first = {
      mode: vi.fn(),
      model: vi.fn(),
      thinkEffort: vi.fn(),
    };
    const second = {
      mode: vi.fn(),
      model: vi.fn(),
      thinkEffort: vi.fn(),
    };

    const render = (active: 'first' | 'second') => {
      root.render(
        <>
          <CommandShortcutHost />
          <CycleCommandProbe
            id="first"
            enabled={active === 'first'}
            onModeSelect={first.mode}
            onModelSelect={first.model}
            onThinkEffortSelect={first.thinkEffort}
          />
          <CycleCommandProbe
            id="second"
            enabled={active === 'second'}
            onModeSelect={second.mode}
            onModelSelect={second.model}
            onThinkEffortSelect={second.thinkEffort}
          />
        </>
      );
    };

    act(() => render('first'));
    expect(commands.execute('session.cycleMode')).toBe(true);
    expect(commands.execute('session.cycleModel')).toBe(true);
    expect(commands.execute('session.cycleThinkEffort')).toBe(true);
    expect(first.mode).toHaveBeenCalledWith('auto');
    expect(first.model).toHaveBeenCalledWith('model-b');
    expect(first.thinkEffort).toHaveBeenCalledWith('high');
    expect(second.mode).not.toHaveBeenCalled();
    expect(second.model).not.toHaveBeenCalled();
    expect(second.thinkEffort).not.toHaveBeenCalled();

    act(() => render('second'));
    expect(commands.execute('session.cycleMode')).toBe(true);
    expect(commands.execute('session.cycleModel')).toBe(true);
    expect(commands.execute('session.cycleThinkEffort')).toBe(true);
    expect(second.mode).toHaveBeenCalledWith('auto');
    expect(second.model).toHaveBeenCalledWith('model-b');
    expect(second.thinkEffort).toHaveBeenCalledWith('high');
    expect(first.mode).toHaveBeenCalledTimes(1);
    expect(first.model).toHaveBeenCalledTimes(1);
    expect(first.thinkEffort).toHaveBeenCalledTimes(1);
  });

  it('lets a custom mode binding run outside the composer while keeping default Shift+Tab scoped', () => {
    const mode = vi.fn();
    act(() => {
      root.render(
        <>
          <CommandShortcutHost />
          <CycleCommandProbe
            id="composer"
            enabled
            onModeSelect={mode}
            onModelSelect={vi.fn()}
            onThinkEffortSelect={vi.fn()}
          />
        </>
      );
    });

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true })
    );
    expect(mode).not.toHaveBeenCalled();

    act(() => commands.setUserKeybindings('session.cycleMode', ['Control+m']));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'm',
          code: 'KeyM',
          ctrlKey: true,
          bubbles: true,
        })
      );
    });
    expect(mode).toHaveBeenCalledWith('auto');

    act(() => commands.setUserKeybindings('session.cycleMode', null));
    const composer = container.querySelector<HTMLTextAreaElement>('#composer');
    composer?.focus();
    composer?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true })
    );
    expect(mode).toHaveBeenCalledTimes(2);
  });
});
