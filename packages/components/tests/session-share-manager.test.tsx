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
      pending: null,
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
      onPrepare: vi.fn(),
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

  it('offers one publish action from the first screen and never uploads on its own', async () => {
    props.entry = null;
    props.hasSecret = false;
    props.shareLink = null;
    await render();
    expect(container.textContent).toContain('Anyone with the link can view this conversation.');
    expect(button('Share conversation')).toBeTruthy();
    expect(button('Cancel')).toBeTruthy();
    expect(props.onPublish).not.toHaveBeenCalled();
    await click('Share conversation');
    expect(props.onPublish).toHaveBeenCalledOnce();
    expect(props.onPrepare).not.toHaveBeenCalled();
  });

  it('freezes only the explicit current sub-conversation selection', async () => {
    props.entry = null;
    await render();
    expect(container.textContent).toContain('Also share 1 sub-conversations');
    await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(props.onSelect).toHaveBeenCalledWith(['root', 'child']);
    expect(props.onPublish).not.toHaveBeenCalled();
  });

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
    expect(box.getAttribute('data-state')).toBe('indeterminate');
    expect(container.textContent).toContain('Also share sub-conversations (1 of 2)');
    await act(async () => box.click());
    expect(props.onSelect).toHaveBeenCalledWith(['root', 'child', 'child-2']);
  });

  it('shows an indeterminate bar while freezing and a measured one only while uploading', async () => {
    props.phase = 'capturing';
    props.busy = true;
    await render();
    expect(container.textContent).toContain('Freezing this conversation…');
    expect(
      container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')
    ).toBeNull();
    expect(button('Share conversation')).toBeUndefined();
    props.phase = 'uploading';
    props.progress = 62;
    await render();
    expect(container.textContent).toContain('Uploading the copy… 62%');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '62'
    );
    props.phase = 'publishing';
    await render();
    expect(container.textContent).toContain('Publishing…');
    expect(
      container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')
    ).toBeNull();
  });

  it('claims a copied link only when the clipboard write succeeded', async () => {
    props.result = { url: link, copied: true };
    await render();
    expect(container.textContent).toContain('Link copied to your clipboard');
    expect(container.textContent).not.toContain('Automatic copying was blocked');
    props.result = { url: link, copied: false };
    await render();
    expect(container.textContent).not.toContain('Link copied to your clipboard');
    expect(container.textContent).toContain('Automatic copying was blocked');
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(link);
    await click('Copy link');
    expect(props.onCopy).toHaveBeenCalledOnce();
  });

  it('keeps the published screen to copy and revoke', async () => {
    props.result = { url: link, copied: true };
    await render();
    expect(button('Copy link')).toBeTruthy();
    expect(button('Revoke share')).toBeTruthy();
    expect(button('Update share')).toBeUndefined();
  });

  it('offers update, copy and revoke for an existing share', async () => {
    props.selected = ['root', 'child'];
    await render();
    expect(button('Update share')).toBeTruthy();
    expect(button('Copy link')).toBeTruthy();
    expect(button('Revoke share')).toBeTruthy();
    await click('Update share');
    expect(props.onPublish).toHaveBeenCalledOnce();
  });

  it('retries a failed publication with the frozen package instead of restarting', async () => {
    props.pending = await prepareSharePackage({
      rootSourceId: 'root',
      conversations: [{ sourceId: 'root', title: 'Frozen Root', history: [] }],
      capturedAt: '2026-09-12T00:00:00.000Z',
      readAttachment: async () => {
        throw new Error('Unexpected attachment');
      },
    });
    props.error = 'Could not update sharing.';
    await render();
    expect(button('Update share')).toBeUndefined();
    await click('Retry');
    expect(props.onPublish).toHaveBeenCalledOnce();
  });

  it('recovers a conflicting preview by starting over rather than publishing it', async () => {
    props.conflict = true;
    props.pending = await prepareSharePackage({
      rootSourceId: 'root',
      conversations: [{ sourceId: 'root', title: 'Frozen Root', history: [] }],
      capturedAt: '2026-09-12T00:00:00.000Z',
      readAttachment: async () => {
        throw new Error('Unexpected attachment');
      },
    });
    await render();
    await click('Start over');
    expect(props.onDiscard).toHaveBeenCalledOnce();
    expect(props.onPublish).not.toHaveBeenCalled();
  });

  it('shows the frozen copy on request without publishing it', async () => {
    props.entry = null;
    await render();
    await click('Preview what will be published');
    expect(props.onPrepare).toHaveBeenCalledOnce();
    expect(props.onPublish).not.toHaveBeenCalled();
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
  });

  it('freezes an agent-requested target set for review as soon as the editor opens', async () => {
    props.entry = null;
    props.selectionLocked = true;
    await render();
    expect(props.onPrepare).toHaveBeenCalledOnce();
    expect(props.onPublish).not.toHaveBeenCalled();
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('routes an unfinished draft to discard instead of a dead publish button', async () => {
    props.entry = { ...entry, status: 'draft' };
    props.hasSecret = false;
    props.shareLink = null;
    await render();
    expect(container.textContent).toContain('This share was never finished.');
    expect(button('Share conversation')).toBeUndefined();
    expect(button('Update share')).toBeUndefined();
    await click('Discard and start over');
    expect(props.onRevoke).toHaveBeenCalledOnce();
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
