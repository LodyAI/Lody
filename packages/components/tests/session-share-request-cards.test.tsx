// @vitest-environment jsdom
import { act, Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Virtualizer } from 'virtua';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
const cloud = vi.hoisted(() => ({
  status: 'pending',
  queryError: null as Error | null,
  cancel: vi.fn(),
  loaded: true,
  listeners: new Set<() => void>(),
}));
vi.mock('@lody/platform/react', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    cloud.listeners.add(listener);
    return () => {
      cloud.listeners.delete(listener);
    };
  };
  return {
    useCloudQuery: () => {
      // Convex surfaces a failed query by throwing out of render.
      if (cloud.queryError) throw cloud.queryError;
      const status = useSyncExternalStore(subscribe, () =>
        cloud.loaded ? cloud.status : undefined
      );
      if (status === undefined) return undefined;
      return [{ requestId: 'request', sourceSessionId: 'root', sessionIds: ['root'], status }];
    },
    useCloudMutation: () => cloud.cancel,
  };
});
vi.mock('../src/lib/app-platform', () => ({ useAppCapability: () => true }));
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ enabled: true }),
}));
vi.mock('../src/atoms', async () => ({ userAtom: (await import('jotai')).atom({ id: 'alice' }) }));
vi.mock('../src/atoms/doc-meta', async () => ({
  sessionMetaCacheAtom: (await import('jotai')).atom({ root: { id: 'root', title: 'Root title' } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/components/sharing/session-share-dialog', () => ({
  SessionShareDialog: ({
    confirmation,
    onClose,
  }: {
    confirmation: { requestId: string };
    onClose: () => void;
  }) => (
    <div role="dialog" data-request={confirmation.requestId}>
      <button onClick={onClose}>Close editor</button>
    </div>
  ),
}));
import { SessionShareRequestCards } from '../src/components/sharing/session-share-request-cards';

/** Stands in for the chat-stream boundary the cards must never reach. */
class ConversationBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? <p>conversation crashed</p> : this.props.children;
  }
}
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <ConversationBoundary>
        <SessionShareRequestCards
          workspaceId={'workspace' as WorkspaceId}
          session={{ id: 'root' } as SessionMeta}
          isVisible
        />
      </ConversationBoundary>
    )
  );
const click = (text: string) =>
  act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === text)!
      .click()
  );
beforeEach(() => {
  cloud.status = 'pending';
  cloud.loaded = true;
  cloud.listeners.clear();
  cloud.queryError = null;
  cloud.cancel.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('opens human review without publishing and retains its editor after confirmation consumes the request', async () => {
  await render();
  expect(container.textContent).toContain('Root title');
  await click('Review and share');
  expect(container.querySelector('[role="dialog"]')?.getAttribute('data-request')).toBe('request');
  expect(cloud.cancel).not.toHaveBeenCalled();
  cloud.status = 'confirmed';
  await render();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain('Closing it discards the upload credentials');
  await click('Close editor');
  expect(container.textContent).toContain('cannot be resumed after the editor closes');
  expect(container.textContent).not.toContain('Retry in the open editor');
  await click('Abandon deployment');
  expect(cloud.cancel).toHaveBeenCalledWith({ requestId: 'request' });
});

it('explains abandon-and-restart after remount and hides completed requests', async () => {
  cloud.status = 'confirmed';
  await render();
  expect(container.textContent).toContain('Abandon deployment');
  expect(container.textContent).not.toContain('Review and share');
  expect(container.textContent).toContain('new share request with a new requestId');
  cloud.status = 'published';
  await render();
  expect(container.querySelector('section')).toBeNull();
});

it('keeps the conversation alive when the share-request query fails, and recovers on retry', async () => {
  // React re-logs a caught render error; the boundary under test owns reporting.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    cloud.queryError = new Error('[CONVEX Q(sessionSharing:listRequests)] Server Error');
    await render();
    expect(container.textContent).not.toContain('conversation crashed');
    expect(container.textContent).toContain('Could not load pending share requests.');
    cloud.queryError = null;
    await click('Retry');
    expect(container.textContent).toContain('Root title');
    expect(container.textContent).toContain('Review and share');
  } finally {
    logged.mockRestore();
  }
});

it.each(['leading-row', 'outside-list'] as const)(
  'delivers a delayed share request after scrolling with cards at %s',
  async (placement) => {
    cloud.loaded = false;
    const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        entry: (typeof observers)[number];
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: new Set() };
          observers.push(this.entry);
        }
        observe = (element: Element) => this.entry.targets.add(element);
        unobserve = (element: Element) => this.entry.targets.delete(element);
        disconnect = () => this.entry.targets.clear();
      }
    );
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.parentElement;
      }
    );
    const cards = (
      <SessionShareRequestCards
        workspaceId={'workspace' as WorkspaceId}
        session={{ id: 'root' } as SessionMeta}
        isVisible
      />
    );
    const measure = () => {
      for (const { callback, targets } of observers) {
        callback(
          [...targets].map((target) => ({
            target,
            contentRect: {
              width: 400,
              height: target.hasAttribute('data-viewport')
                ? 400
                : target.querySelector('[data-share-leading]')
                  ? 0
                  : 100,
            },
          })) as ResizeObserverEntry[],
          {} as ResizeObserver
        );
      }
    };
    await act(async () =>
      root.render(
        <>
          <div data-viewport="">
            <Virtualizer itemSize={100} bufferSize={800} shift={false}>
              {placement === 'leading-row' && <div data-share-leading="">{cards}</div>}
              {Array.from({ length: 60 }, (_, i) => (
                <div key={i}>message {i}</div>
              ))}
            </Virtualizer>
          </div>
          {placement === 'outside-list' && cards}
        </>
      )
    );
    const viewport = container.querySelector<HTMLElement>('[data-viewport]')!;
    await act(async () => measure());
    expect(container.textContent).toContain('message 0');
    // Same initial bottom restoration as the conversation, with no human scroll.
    await act(async () => {
      viewport.scrollTop = 5600;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(container.textContent).toContain('message 59');
    expect(container.textContent).not.toContain('message 0');
    await act(async () => {
      cloud.loaded = true;
      for (const notify of cloud.listeners) notify();
    });
    if (placement === 'leading-row') {
      // Reproduce Add -> Remove before the pending result can render.
      expect(cloud.listeners.size).toBe(0);
      expect(container.querySelector('section')).toBeNull();
    } else {
      expect(container.textContent).toContain('Review and share');
      await click('Review and share');
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => {
        cloud.status = 'confirmed';
        for (const notify of cloud.listeners) notify();
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(container.textContent).toContain('message 0');
      expect(container.textContent).not.toContain('message 59');
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.textContent).toContain('Closing it discards the upload credentials');
    }
  }
);
