// @vitest-environment jsdom

import { act, useRef, useState } from 'react';
import { createStore, Provider, useAtomValue } from 'jotai';
import {
  createSemanticActionRouter,
  reportSemanticActionInteraction,
  type SemanticActionScope,
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

  const point = (element: HTMLElement, x = 10, y = 10, buttons = 0) => {
    element.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons })
    );
  };
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
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

  it('routes native browser ownership signals through its visible host', () => {
    window.dispatchEvent(new Event('blur'));
    reportSemanticActionInteraction(panel, 'pointer');
    close();
    expect(remaining().panelOpen).toBe(false);
    expect(remaining().conversation).toBe(2);
  });

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
    });
  const close = () => act(() => closeCurrentTabOrWindow());

  beforeEach(() => {
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
});
