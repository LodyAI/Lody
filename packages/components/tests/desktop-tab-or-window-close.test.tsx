// @vitest-environment jsdom

import { act, useRef, useState } from 'react';
import { createStore, Provider, useAtomValue } from 'jotai';
import {
  createSemanticActionRouter,
  reportSemanticActionInteraction,
  type SemanticActionScope,
  SEMANTIC_HOVER_DWELL_MS,
} from '../src/lib/commands/semantic-action-router';
import { useSemanticActionRouter } from '../src/lib/commands/use-semantic-action-router';
import {
  developerModeEnabledAtom,
  semanticShortcutsBetaEnabledAtom,
  semanticShortcutsFeatureEnabledAtom,
} from '../src/atoms/settings';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeCurrentTabOrWindow,
  registerDesktopTabCloser,
  useDesktopTabCloser,
  __resetDesktopTabClosersForTests,
} from '../src/lib/desktop-tab-or-window-close';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('desktop closer lifecycle', () => {
  let windowOpen: boolean;
  beforeEach(() => {
    __resetDesktopTabClosersForTests();
    windowOpen = true;
    vi.spyOn(window, 'close').mockImplementation(() => {
      windowOpen = false;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetDesktopTabClosersForTests();
  });
  it('closes a window with no registered surface', () => {
    closeCurrentTabOrWindow();
    expect(windowOpen).toBe(false);
  });
  it('restores the previous surface after the top closer is removed', () => {
    const tabs = ['older', 'newer'];
    registerDesktopTabCloser(() => {
      tabs.splice(tabs.indexOf('older'), 1);
      return 'handled';
    });
    const dispose = registerDesktopTabCloser(() => {
      tabs.splice(tabs.indexOf('newer'), 1);
      return 'handled';
    });
    closeCurrentTabOrWindow();
    expect(tabs).toEqual(['older']);
    expect(windowOpen).toBe(true);
    dispose();
    closeCurrentTabOrWindow();
    expect(tabs).toEqual([]);
    expect(windowOpen).toBe(true);
  });
  it('honors an explicit native-window result from the active surface', () => {
    registerDesktopTabCloser(() => 'unhandled');
    closeCurrentTabOrWindow();
    expect(windowOpen).toBe(false);
  });
});

describe('semantic close routing', () => {
  let host: HTMLDivElement;
  let conversation: HTMLElement;
  let panel: HTMLElement;
  let input: HTMLInputElement;
  let router: ReturnType<typeof createSemanticActionRouter>;
  let disposeCloser: () => void;
  let windowOpen: boolean;
  let cancelled: boolean;
  let scopes: SemanticActionScope[];

  const move = (element: HTMLElement, x = 10, y = 10, buttons = 0) => {
    element.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons })
    );
  };
  const point = (element: HTMLElement, x = 10, y = 10, buttons = 0) => {
    move(element, x, y, buttons);
    vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
  };
  const click = (element: HTMLElement) =>
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  const wheel = (element: HTMLElement) =>
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
  const press = (element: HTMLElement, key: string, options: KeyboardEventInit = {}) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, ...options }));
  };
  const close = () => closeCurrentTabOrWindow();
  const remaining = () => ({
    conversation: conversation.querySelectorAll('[data-tab]').length,
    panel: panel.querySelectorAll('[data-tab]').length,
    panelOpen: !panel.hidden,
    windowOpen,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    __resetDesktopTabClosersForTests();
    // jsdom has no layout. Give real DOM nodes a visible rectangle; semantic
    // hidden/aria-hidden/inert checks still run in the production resolver.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      { width: 100, height: 100 },
    ] as unknown as DOMRectList);
    windowOpen = true;
    cancelled = false;
    vi.spyOn(window, 'close').mockImplementation(() => {
      windowOpen = false;
    });
    host = document.createElement('div');
    host.innerHTML =
      '<section data-lody-action-scope="conversation"><input><span data-tab>one</span><span data-tab>two</span></section><section data-lody-action-scope="side-panel"><button>tool</button><span data-tab>file</span></section>';
    document.body.append(host);
    conversation = host.children[0] as HTMLElement;
    panel = host.children[1] as HTMLElement;
    input = conversation.querySelector('input')!;
    scopes = [
      {
        id: 'conversation',
        element: conversation,
        actions: {
          close: () => {
            if (conversation.querySelectorAll('[data-tab]').length === 1) return 'unhandled';
            conversation.querySelector('[data-tab]')?.remove();
            return 'handled';
          },
        },
      },
      {
        id: 'side-panel',
        element: panel,
        actions: {
          close: () => {
            if (cancelled) return 'handled';
            panel.querySelector('[data-tab]')?.remove();
            if (!panel.querySelector('[data-tab]')) {
              panel.hidden = true;
              router.activate('conversation');
              input.focus();
            }
            return 'handled';
          },
        },
      },
    ];
    router = createSemanticActionRouter(host, () => scopes, 'conversation');
    disposeCloser = registerDesktopTabCloser(() => router.dispatch('close'));
    input.focus();
  });

  afterEach(() => {
    disposeCloser();
    router.dispose();
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetDesktopTabClosersForTests();
  });

  it('closes the pointed-at panel without clicking and transfers focus after collapse', () => {
    point(panel);
    expect(panel.dataset.lodyActionActive).toBe('true');
    expect(document.activeElement).toBe(input);
    close();
    expect(remaining()).toEqual({ conversation: 2, panel: 0, panelOpen: false, windowOpen: true });
    expect(document.activeElement).toBe(input);
    expect(conversation.dataset.lodyActionActive).toBe('true');
    close();
    expect(remaining().conversation).toBe(1);
    expect(windowOpen).toBe(true);
  });

  it('collapses an already empty panel without closing the conversation', () => {
    panel.querySelector('[data-tab]')!.remove();
    point(panel);
    close();
    expect(remaining()).toEqual({ conversation: 2, panel: 0, panelOpen: false, windowOpen: true });
  });

  it('selects an iframe host on pointer entry without reading its document', () => {
    const frame = document.createElement('iframe');
    panel.append(frame);
    frame.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 25, clientY: 25 }));
    vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

  it('routes native browser ownership signals through its visible host', () => {
    window.dispatchEvent(new Event('blur'));
    reportSemanticActionInteraction(panel, 'pointer');
    vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

  it('keeps an opened file targeted after the pointer returns to the sole conversation', () => {
    conversation.querySelector('[data-tab]')!.remove();
    const finishOpen = router.deferActivation('side-panel');
    finishOpen();
    point(conversation, 40, 40);
    expect(panel.dataset.lodyActionActive).toBe('true');
    close();
    expect(remaining()).toEqual({ conversation: 1, panel: 0, panelOpen: false, windowOpen: true });
    // Successful collapse deliberately hands off for the next invocation.
    close();
    expect(windowOpen).toBe(false);
  });

  it.each(['click', 'typing', 'wheel'])(
    'lets deliberate conversation %s reclaim ownership from an opened file',
    (interaction) => {
      router.activate('side-panel');
      if (interaction === 'click') click(conversation);
      if (interaction === 'typing') press(input, 'a');
      if (interaction === 'wheel') wheel(conversation);
      point(panel, 40, 40);
      close();
      expect(remaining()).toEqual({ conversation: 1, panel: 1, panelOpen: true, windowOpen: true });
    }
  );

  it('does not treat programmatic focus or scrolling as deliberate input', () => {
    router.activate('side-panel');
    input.focus();
    conversation.dispatchEvent(new Event('scroll', { bubbles: true }));
    point(conversation, 30, 30);
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

  it('commits hover only after continuous dwell without moving keyboard focus', () => {
    move(panel);
    vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS - 1);
    expect(panel.dataset.lodyActionActive).toBeUndefined();
    expect(document.activeElement).toBe(input);
    move(panel, 15, 15);
    vi.advanceTimersByTime(1);
    expect(panel.dataset.lodyActionActive).toBe('true');
    expect(document.activeElement).toBe(input);
    close();
    expect(remaining().panelOpen).toBe(false);
  });

  it('does not commit a pane merely crossed by the pointer', () => {
    move(panel);
    vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS - 1);
    move(conversation, 30, 30);
    vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
  });

  it.each(['hover', 'focused fallback', 'default fallback'])(
    'does not close the window through %s while a second close scope is visible',
    (selection) => {
      conversation.querySelector('[data-tab]')!.remove();
      if (selection === 'hover') point(conversation);
      if (selection === 'default fallback') input.blur();
      close();
      expect(remaining()).toEqual({ conversation: 1, panel: 1, panelOpen: true, windowOpen: true });
      click(conversation);
      close();
      expect(windowOpen).toBe(false);
    }
  );

  it('preserves window closure when there is no other visible close scope', () => {
    conversation.querySelector('[data-tab]')!.remove();
    panel.hidden = true;
    close();
    expect(windowOpen).toBe(false);
  });

  it('does not let a late file open override newer deliberate input', () => {
    const finishOpen = router.deferActivation('side-panel');
    press(input, 'a');
    finishOpen();
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
  });

  it('only lets the newest asynchronous open claim its destination', () => {
    const older = router.deferActivation('conversation');
    const newer = router.deferActivation('side-panel');
    newer();
    older();
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

  it('supersedes asynchronous activation on deliberate input outside the scopes', () => {
    const finishOpen = router.deferActivation('side-panel');
    click(host);
    finishOpen();
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
  });

  it.each(['blur', 'dispose'])('invalidates an asynchronous activation on %s', (reset) => {
    const finishOpen = router.deferActivation('side-panel');
    if (reset === 'blur') window.dispatchEvent(new Event('blur'));
    else router.dispose();
    finishOpen();
    expect(panel.dataset.lodyActionActive).toBeUndefined();
    close();
    expect(remaining().panel).toBe(1);
    expect(windowOpen).toBe(true);
  });

  it.each(['pointerdown', 'keyboard', 'wheel'] as const)(
    'native browser %s takes persistent ownership',
    (source) => {
      reportSemanticActionInteraction(panel, source);
      point(conversation, 40, 40);
      close();
      expect(remaining().panelOpen).toBe(false);
      expect(remaining().conversation).toBe(2);
    }
  );

  it('native browser pointer exit cancels pending hover without clearing another owner', () => {
    reportSemanticActionInteraction(panel, 'pointer');
    reportSemanticActionInteraction(panel, 'pointerleave');
    vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
    click(conversation);
    reportSemanticActionInteraction(panel, 'pointerleave');
    close();
    expect(windowOpen).toBe(false);
  });

  it.each(['pointer exit', 'hidden target', 'modal', 'drag', 'blur'])(
    'cancels pending hover on %s',
    async (interruption) => {
      move(panel);
      if (interruption === 'pointer exit') {
        panel.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
      }
      if (interruption === 'hidden target') panel.hidden = true;
      if (interruption === 'modal') {
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.dataset.state = 'open';
        host.append(overlay);
        await Promise.resolve();
        overlay.remove();
      }
      if (interruption === 'drag') host.dispatchEvent(new Event('dragstart', { bubbles: true }));
      if (interruption === 'blur') window.dispatchEvent(new Event('blur'));
      vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
      expect(panel.dataset.lodyActionActive).toBeUndefined();
      close();
      expect(remaining().panel).toBe(1);
      expect(windowOpen).toBe(true);
    }
  );

  it('typing reclaims the conversation from a stationary pointer', () => {
    point(panel);
    press(input, 'a');
    point(panel); // Same coordinates are not a new deliberate movement.
    close();
    expect(remaining()).toEqual({ conversation: 1, panel: 1, panelOpen: true, windowOpen: true });
  });

  it('a close chord does not replace the pointer target with the old text caret', () => {
    point(panel);
    press(input, 'w', { code: 'KeyW', ctrlKey: true });
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

  it('does not add any repeat-key suppression', () => {
    point(panel);
    close();
    press(input, 'w', { code: 'KeyW', ctrlKey: true, repeat: true });
    close();
    expect(remaining().conversation).toBe(1);
  });

  it('ignores programmatic focus restoration after hovering', () => {
    point(panel);
    panel.querySelector('button')!.focus();
    input.focus();
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

  it('follows focus moved by keyboard navigation', () => {
    point(panel);
    const button = panel.querySelector('button')!;
    button.focus();
    press(button, 'Tab');
    input.focus();
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
  });

  it('cancelled or pending close stays owned by the original panel', () => {
    cancelled = true;
    point(panel);
    close();
    close();
    expect(remaining()).toEqual({ conversation: 2, panel: 1, panelOpen: true, windowOpen: true });
    cancelled = false;
    close();
    expect(remaining().panelOpen).toBe(false);
  });

  it.each(['dialog', 'alertdialog', 'menu', 'listbox'])(
    'blocks background close while an open %s owns interaction',
    (role) => {
      point(panel);
      const overlay = document.createElement('div');
      overlay.setAttribute('role', role);
      overlay.dataset.state = 'open';
      host.append(overlay);
      close();
      expect(remaining()).toEqual({ conversation: 2, panel: 1, panelOpen: true, windowOpen: true });
      overlay.remove();
      close();
      expect(remaining().panelOpen).toBe(false);
    }
  );

  it('does not redirect a removed selected scope to another region', () => {
    point(panel);
    panel.remove();
    close();
    expect(remaining().conversation).toBe(2);
    expect(windowOpen).toBe(true);
  });

  it('excludes hidden retained panels from new pointer targeting', () => {
    panel.setAttribute('aria-hidden', 'true');
    point(panel);
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
  });

  it('unsupported actions do not fall through to window close', () => {
    point(panel);
    delete scopes[1]!.actions.close;
    close();
    expect(remaining()).toEqual({ conversation: 2, panel: 1, panelOpen: true, windowOpen: true });
  });

  it('clears hover ownership when the pointer leaves the window', () => {
    point(panel);
    panel.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
    close();
    expect(remaining().conversation).toBe(1);
  });

  it('clears transient ownership on window blur', () => {
    point(panel);
    window.dispatchEvent(new Event('blur'));
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
  });

  it('ignores pointer movement during a drag', () => {
    point(panel, 20, 20, 1);
    close();
    expect(remaining().conversation).toBe(1);
    expect(remaining().panel).toBe(1);
  });

  it('chooses the innermost registered action scope independently of registration order', () => {
    const nested = document.createElement('div');
    nested.textContent = 'nested item';
    panel.append(nested);
    scopes.unshift({
      id: 'nested',
      element: nested,
      actions: {
        close: () => {
          nested.remove();
          return 'handled';
        },
      },
    });
    point(nested);
    close();
    expect(nested.isConnected).toBe(false);
    expect(remaining().panel).toBe(1);
    expect(remaining().conversation).toBe(2);
  });
});

describe('semantic close developer gate lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  function Harness({ session = 'one' }: { session?: string }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const enabled = useAtomValue(semanticShortcutsFeatureEnabledAtom);
    const [closed, setClosed] = useState('none');
    const router = useSemanticActionRouter({
      rootRef,
      enabled,
      resetKey: session,
      defaultScopeId: 'conversation',
      scopes: {
        conversation: {
          close: () => {
            setClosed('conversation');
            return 'handled';
          },
        },
        'side-panel': {
          close: () => {
            setClosed('side-panel');
            return 'handled';
          },
        },
      },
    });
    useDesktopTabCloser(() => {
      if (enabled) return router.current?.dispatch('close') ?? 'handled';
      setClosed('legacy');
      return 'handled';
    });
    return (
      <div ref={rootRef}>
        <div data-lody-action-scope="conversation">conversation</div>
        <div data-lody-action-scope="side-panel">panel</div>
        <output>{closed}</output>
      </div>
    );
  }
  const render = (session = 'one') =>
    act(() =>
      root.render(
        <Provider store={store}>
          <Harness session={session} />
        </Provider>
      )
    );
  const pointPanel = () =>
    act(() => {
      container
        .querySelector('[data-lody-action-scope="side-panel"]')!
        .dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 30 }));
      vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
    });
  const close = () => act(() => closeCurrentTabOrWindow());

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    __resetDesktopTabClosersForTests();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
      { width: 100 },
    ] as unknown as DOMRectList);
    store = createStore();
    store.set(developerModeEnabledAtom, false);
    store.set(semanticShortcutsBetaEnabledAtom, false);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetDesktopTabClosersForTests();
  });
  it('requires both opt-ins, updates immediately, and retains the choice when developer mode is disabled', () => {
    render();
    pointPanel();
    close();
    expect(container.querySelector('output')!.textContent).toBe('legacy');
    act(() => store.set(semanticShortcutsBetaEnabledAtom, true));
    pointPanel();
    close();
    expect(container.querySelector('output')!.textContent).toBe('legacy');
    act(() => store.set(developerModeEnabledAtom, true));
    pointPanel();
    close();
    expect(container.querySelector('output')!.textContent).toBe('side-panel');
    act(() => store.set(developerModeEnabledAtom, false));
    expect(store.get(semanticShortcutsBetaEnabledAtom)).toBe(true);
    expect(container.querySelector('[data-lody-action-active]')).toBeNull();
    close();
    expect(container.querySelector('output')!.textContent).toBe('legacy');
  });
  it('clears the selected scope when the route identity changes', () => {
    store.set(developerModeEnabledAtom, true);
    store.set(semanticShortcutsBetaEnabledAtom, true);
    render();
    pointPanel();
    render('two');
    close();
    expect(container.querySelector('output')!.textContent).toBe('conversation');
  });
  it.each(['route', 'beta', 'developer'])(
    'cancels uncommitted hover when the %s lifecycle changes',
    (change) => {
      store.set(developerModeEnabledAtom, true);
      store.set(semanticShortcutsBetaEnabledAtom, true);
      render();
      act(() => {
        container
          .querySelector('[data-lody-action-scope="side-panel"]')!
          .dispatchEvent(
            new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 30 })
          );
      });
      if (change === 'route') render('two');
      if (change === 'beta') act(() => store.set(semanticShortcutsBetaEnabledAtom, false));
      if (change === 'developer') act(() => store.set(developerModeEnabledAtom, false));
      act(() => {
        vi.advanceTimersByTime(SEMANTIC_HOVER_DWELL_MS);
      });
      expect(
        container.querySelector('[data-lody-action-scope="side-panel"][data-lody-action-active]')
      ).toBeNull();
      close();
      expect(container.querySelector('output')!.textContent).toBe(
        change === 'route' ? 'conversation' : 'legacy'
      );
    }
  );
});
