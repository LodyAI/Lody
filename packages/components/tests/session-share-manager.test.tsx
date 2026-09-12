// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSharePackage } from '@lody/shared/session-sharing';
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
describe('static share confirmation controls', () => {
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
      pending: null,
      progress: 0,
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
      onPrepare: vi.fn(),
      onConfirm: vi.fn(),
      onDiscard: vi.fn(),
      onCopy: vi.fn(),
      onReset: vi.fn(),
      onRevoke: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = () => act(async () => root.render(<SessionShareManager {...props} />));
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === name
    );
  async function click(name: string) {
    expect(button(name)).toBeTruthy();
    await act(async () => button(name)!.click());
  }
  it('prepares without publishing and requires a separate frozen-copy confirmation', async () => {
    props.entry = null;
    props.hasSecret = false;
    await render();
    await click('Prepare share');
    expect(props.onPrepare).toHaveBeenCalledOnce();
    expect(props.onConfirm).not.toHaveBeenCalled();
    props.pending = await prepareSharePackage({
      rootSourceId: 'root',
      conversations: [{ sourceId: 'root', title: 'Frozen Root', history: [] }],
      capturedAt: '2026-09-12T00:00:00.000Z',
      readAttachment: async () => {
        throw new Error('Unexpected attachment');
      },
    });
    await render();
    expect(container.textContent).toContain('Frozen Root');
    await click('Confirm publication');
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });
  it('freezes only the explicit current sub-conversation selection', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(props.onSelect).toHaveBeenCalledWith(['root', 'child']);
    expect(props.onPrepare).not.toHaveBeenCalled();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
  it('allows update without requiring a target-selection edit', async () => {
    await render();
    expect(button('Update deployment')?.disabled).toBe(false);
    await click('Update deployment');
    expect(props.onPrepare).toHaveBeenCalledOnce();
  });
  it('allows administrators to revoke but not reset or publish another member’s share', async () => {
    props.entry = { ...entry, canManage: false };
    props.hasSecret = false;
    await render();
    expect(button('Update deployment')).toBeUndefined();
    expect(button('Reset link')).toBeUndefined();
    await click('Revoke');
    expect(props.onRevoke).not.toHaveBeenCalled();
    await click('Confirm');
    expect(props.onRevoke).toHaveBeenCalledOnce();
  });
  it('invalidates a stale reset confirmation when the revision changes', async () => {
    await render();
    await click('Reset link');
    props.entry = { ...entry, revision: 2 };
    await render();
    expect(button('Confirm')?.disabled).toBe(true);
    await click('Confirm');
    expect(props.onReset).not.toHaveBeenCalled();
  });
  it('keeps revoke and copy usable when the source is gone', async () => {
    props.canCapture = false;
    await render();
    expect(button('Update deployment')?.disabled).toBe(true);
    expect(button('Copy link')?.disabled).toBe(false);
    expect(button('Revoke')?.disabled).toBe(false);
    expect(container.textContent).toContain('published copy is unchanged');
  });
});
