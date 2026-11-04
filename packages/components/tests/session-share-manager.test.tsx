// @vitest-environment jsdom
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionShareManager,
  type SessionShareManagerProps,
} from '../src/components/sharing/session-share-manager';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: Record<string, unknown>) =>
      values
        ? fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(values[name] ?? ''))
        : fallback,
  }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as typeof globalThis & { ResizeObserver?: unknown }).ResizeObserver =
  TestResizeObserver;
const link = `https://share.test/s/demo#access=v1.${'demo'.repeat(16)}`;
describe('static share dialog steps', () => {
  let root: Root, container: HTMLDivElement, props: SessionShareManagerProps;
  const entry = {
    shareId: 'share',
    rootSessionId: 'root',
    publisherUserId: 'alice',
    title: 'Root',
    status: 'active' as const,
    revision: 1,
    credentialVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceIds: [{ sourceId: 'root', conversationId: 'c1' }],
    selectedSourceIds: ['root'],
    canManage: true,
    canRevoke: true,
  };
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    props = {
      sessionId: 'root',
      entry,
      selected: ['root'],
      hasPending: false,
      plaintextConfirmation: false,
      onConfirmPlaintextPublish: vi.fn(),
      onCancelPlaintextPublish: vi.fn(),
      phase: 'idle',
      progress: 0,
      result: null,
      shareLink: link,
      canCapture: true,
      candidates: [
        { sessionId: 'root', title: 'Root' },
        { sessionId: 'child', title: 'Child' },
      ],
      busy: false,
      conflict: false,
      hasSecret: true,
      error: null,
      notice: null,
      onSelect: vi.fn(),
      onPublish: vi.fn(),
      onDiscard: vi.fn(),
      onCopy: vi.fn(),
      onReset: vi.fn(),
      onRevoke: vi.fn(),
      onClose: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.querySelectorAll('[role="alertdialog"]').forEach((node) => node.remove());
  });
  const render = () => act(async () => root.render(<SessionShareManager {...props} />));
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === name
    );
  async function click(name: string) {
    expect(button(name), `missing button: ${name}`).toBeTruthy();
    await act(async () => button(name)!.click());
  }

  it('does not overstate scope when a share carries only some current children', async () => {
    props.entry = null;
    props.candidates = [
      { sessionId: 'root', title: 'Root' },
      { sessionId: 'child', title: 'Child' },
      { sessionId: 'child-2', title: 'Child 2' },
    ];
    props.selected = ['root', 'child'];
    await render();
    const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    expect(box.getAttribute('aria-checked')).toBe('mixed');
    expect(container.textContent).toContain('Also share sub-conversations (1 of 2)');
    await act(async () => box.click());
    expect(props.onSelect).toHaveBeenCalledWith(['root', 'child', 'child-2']);
  });

  it('lets an administrator revoke but not publish another member’s share', async () => {
    props.entry = { ...entry, canManage: false };
    props.hasSecret = false;
    props.shareLink = null;
    await render();
    expect(button('Update share')).toBeUndefined();
    expect(button('Reset link')).toBeUndefined();
    expect(container.textContent).toContain('Published by another workspace member');
    expect(container.textContent).not.toContain('Updating replaces');
    await click('Revoke share');
    expect(props.onRevoke).not.toHaveBeenCalled();
    await click('Confirm');
    expect(props.onRevoke).toHaveBeenCalledOnce();
  });

  it('invalidates a stale revoke confirmation when the revision changes', async () => {
    await render();
    await click('Revoke share');
    props.entry = { ...entry, revision: 2 };
    await render();
    expect(button('Confirm')?.disabled).toBe(true);
    await click('Confirm');
    expect(props.onRevoke).not.toHaveBeenCalled();
  });

  it('offers a link reset when this device has no credential', async () => {
    props.hasSecret = false;
    props.shareLink = null;
    await render();
    expect(container.textContent).toContain('link credential is not saved on this device');
    expect(button('Copy link')).toBeUndefined();
    await click('Reset link');
    expect(props.onReset).not.toHaveBeenCalled();
    await click('Confirm');
    expect(props.onReset).toHaveBeenCalledOnce();
  });

  it('keeps revoke and copy usable when the source is gone', async () => {
    props.canCapture = false;
    await render();
    expect(button('Update share')?.disabled).toBe(true);
    expect(button('Copy link')?.disabled).toBe(false);
    expect(button('Revoke share')?.disabled).toBe(false);
    expect(container.textContent).toContain('published copy is unchanged');
  });
});
