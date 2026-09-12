// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionShareManager,
  type SessionShareManagerProps,
} from '../src/components/sharing/session-share-manager';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('session share management surface', () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: SessionShareManagerProps;
  const entry = {
    title: 'Root',
    shareId: 'share',
    rootSessionId: 'root',
    authorUserId: 'alice',
    status: 'active' as const,
    scopeVersion: 1,
    credentialVersion: 1,
    sessionIds: ['root'],
    readableSessionIds: ['root'],
    validUntil: 200,
    canManage: true,
    canRevoke: true,
  };
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    props = {
      sessionId: 'root',
      state: {
        root: entry,
        sources: [entry],
        candidates: [
          { sessionId: 'root', title: 'Root', available: true, validUntil: 200 },
          { sessionId: 'child', title: 'Child', available: true, validUntil: 200 },
          { sessionId: 'local', title: 'Local', available: false, validUntil: null },
        ],
      },
      candidates: [
        { sessionId: 'root', title: 'Root' },
        { sessionId: 'child', title: 'Child' },
        { sessionId: 'local', title: 'Local' },
      ],
      selected: ['root'],
      copyableShareIds: ['share'],
      now: 100,
      busy: false,
      conflict: false,
      error: null,
      notice: null,
      onSelect: vi.fn(),
      onReload: vi.fn(),
      onCreate: vi.fn(),
      onSave: vi.fn(),
      onReset: vi.fn(),
      onCopy: vi.fn(),
      onRevoke: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render() {
    await act(async () => root.render(<SessionShareManager {...props} />));
  }
  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === label
    );
  }
  async function click(node: HTMLElement | undefined | null) {
    expect(node).toBeTruthy();
    await act(async () => node?.click());
  }
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]');

  it('creates a root-only link without extra confirmation and never widens it silently', async () => {
    props.state = { ...props.state!, root: null, sources: [] };
    await render();
    // One decision, and it starts off: a new link covers only this conversation.
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(button('Create share link')?.disabled).toBe(false);
    await click(button('Create share link'));
    expect(props.onCreate).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('adds every ready sub-conversation at once and excludes the ones that are not', async () => {
    props.state = { ...props.state!, root: null, sources: [] };
    await render();
    await click(toggle());
    // 'local' is unavailable, so the switch must not pull it in.
    expect(props.onSelect).toHaveBeenCalledWith(['root', 'child']);
  });

  it('turns the switch off back to the root alone', async () => {
    props.selected = ['root', 'child'];
    await render();
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    await click(toggle());
    expect(props.onSelect).toHaveBeenCalledWith(['root']);
  });

  it('explains a root that cannot be shared yet instead of only disabling the action', async () => {
    props.state = {
      ...props.state!,
      root: null,
      sources: [],
      candidates: props.state!.candidates.map((candidate) => ({
        ...candidate,
        available: false,
        validUntil: null,
      })),
    };
    await render();
    expect(button('Create share link')?.disabled).toBe(true);
    expect(container.textContent).toContain('Not synced to the cloud yet');
  });

  it('requires reset on a device without the secret and invalidates an open reset confirmation after a concurrent change', async () => {
    props.copyableShareIds = [];
    props.selected = ['root', 'child'];
    await render();
    expect(button('Copy share link')).toBeUndefined();
    expect(button('Save changes')?.disabled).toBe(true);
    await click(button('Reset link'));
    props.state = { ...props.state!, root: { ...entry, credentialVersion: 2 } };
    await render();
    expect(button('Confirm')?.disabled).toBe(true);
    await click(button('Confirm'));
    expect(props.onReset).not.toHaveBeenCalled();
  });

  it('offers administrators revocation without author actions and confirms the exact independent grant', async () => {
    props.state = { ...props.state!, root: { ...entry, canManage: false } };
    props.copyableShareIds = [];
    await render();
    expect(button('Reset link')).toBeUndefined();
    expect(button('Save changes')).toBeUndefined();
    expect(container.querySelector('[role="switch"]')).toBeNull();
    await click(button('Revoke link'));
    expect(props.onRevoke).not.toHaveBeenCalled();
    await click(button('Confirm'));
    expect(props.onRevoke).toHaveBeenCalledWith(props.state.root);
  });

  it('does not surface other links that include this conversation', async () => {
    const foreign = {
      ...entry,
      title: 'Another conversation',
      shareId: 'foreign-share',
      rootSessionId: 'other',
      sessionIds: ['other', 'root'],
      readableSessionIds: ['other', 'root'],
    };
    props.state = { ...props.state!, sources: [entry, foreign] };
    await render();
    expect(container.textContent).not.toContain('Another conversation');
    // The only revocation offered is for this conversation's own link.
    expect(
      [...container.querySelectorAll('button')].filter((node) => node.textContent === 'Revoke link')
    ).toHaveLength(1);
  });

  it('hides the sub-conversation switch entirely when there is nothing to include', async () => {
    props.state = {
      ...props.state!,
      candidates: [{ sessionId: 'root', title: 'Root', available: true, validUntil: 200 }],
    };
    props.candidates = [{ sessionId: 'root', title: 'Root' }];
    await render();
    expect(toggle()).toBeNull();
    expect(container.textContent).not.toContain('Include sub-conversations');
  });

  it('freezes the sub-conversation switch while a mutation is in flight', async () => {
    props.busy = true;
    await render();
    expect(toggle()?.disabled).toBe(true);
  });

  it('stops presenting an expired grant as active without a new server record', async () => {
    props.now = 201;
    await render();
    expect(container.textContent).toContain('Link is currently unavailable');
    expect(button('Copy share link')).toBeUndefined();
    expect(button('Reset link')?.disabled).toBe(true);
  });
});
