// @vitest-environment jsdom

// A failed pending send is an ordinary user message, not an error report: the
// same reason must appear exactly ONCE (on the attachment that failed), the
// message level must stay a short status, and an attachment that finished must
// not be dragged into the failure. Regressions here are what made the row read
// like a debug panel.

import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';

import { Provider, createStore } from 'jotai';

import { authTokenAtom, runtimeAtom } from '../src/atoms/runtime';
import {
  PendingMessageRow,
  SessionPendingMessages,
} from '../src/components/chat/session-pending-messages';
import type { SessionAttachmentDraft } from '../src/lib/session-attachment-draft';
import {
  createPendingSessionSends,
  type PendingSessionSend,
} from '../src/lib/session-pending-sends';
import {
  clearSessionImageCache,
  seedSessionImageCache,
  peekSessionImageUrl,
} from '../src/lib/session-image-cache';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { WorkspaceUserImageBlock } from '../src/components/ai-gui/view';
import { createSessionImageGalleryEntry } from '../src/lib/session-image-gallery';
import { SessionFileCard } from '../src/components/ai-gui/session-file-card';
import type { SessionFilePayload } from '@lody/shared';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const REASON = 'Network error while preparing the file';
const sessionId = 'pending-row-session' as SessionId;

const readyImage: SessionAttachmentDraft = {
  id: 'ready-image',
  kind: 'image',
  source: new Blob(['image']),
  name: 'design.png',
  mimeType: 'image/png',
  lastModified: 0,
  ready: { type: 'image', imageId: 'uploaded', mimeType: 'image/png', sizeBytes: 16 },
  progress: 100,
};

const readyFile: SessionAttachmentDraft = {
  id: 'ready-file',
  kind: 'file',
  source: new Blob(['notes']),
  name: 'notes.md',
  mimeType: 'text/markdown',
  lastModified: 0,
  ready: { type: 'file', fileId: 'uploaded-file', fileName: 'notes.md', sizeBytes: 5 },
  progress: 100,
} as SessionAttachmentDraft;

const failedFile: SessionAttachmentDraft = {
  id: 'failed-file',
  kind: 'file',
  source: new Blob(['archive']),
  name: 'evidence.zip',
  mimeType: 'application/zip',
  lastModified: 0,
  error: REASON,
  progress: 0,
};

const record = (overrides: Partial<PendingSessionSend> = {}): PendingSessionSend =>
  ({
    id: 'pending-turn',
    sessionId,
    workspaceId: 'pending-row-workspace' as WorkspaceId,
    sequence: 1,
    attachments: [],
    entry: {
      id: 'pending-turn',
      role: 'user',
      userId: 'tester',
      timestamp: '2026-09-15T00:00:00.000Z',
      status: 'pending',
      read: false,
      finished: true,
      items: [{ type: 'text', text: 'Take a look at these.' }],
      fileDiff: [],
    } as unknown as SessionHistory,
    delivery: { kind: 'dispatch' },
    ...overrides,
  }) as PendingSessionSend;

describe('PendingMessageRow failure presentation', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onRetry = vi.fn();
  const onCancel = vi.fn();

  beforeEach(async () => {
    await initI18n('en');
    // jsdom ships no object-URL support; the image card needs one to preview.
    let nextUrl = 0;
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL() {
          return `blob:pending-row-${++nextUrl}`;
        }
        static revokeObjectURL() {}
      }
    );
    onRetry.mockClear();
    onCancel.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    clearSessionImageCache();
    vi.unstubAllGlobals();
  });

  const render = async (value: PendingSessionSend) => {
    await act(async () => {
      root?.render(createElement(PendingMessageRow, { record: value, onRetry, onCancel }));
    });
    return container!;
  };

  /**
   * Counts only LEAF elements carrying the reason. An ancestor inherits the same
   * textContent, so counting every element would report a container plus its own
   * text as two separate displays of one reason.
   */
  const reasonNodes = (host: HTMLElement) =>
    [...host.querySelectorAll('*')].filter(
      (node) => node.childElementCount === 0 && node.textContent?.trim() === REASON
    );

  it('prints the attachment reason once and keeps the message status short', async () => {
    const host = await render(record({ error: REASON, attachments: [readyImage, failedFile] }));

    expect(reasonNodes(host)).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Not sent');
  });

  /**
   * The framed card below already carries the alarm. Colouring the status line
   * too is what stacked three red things down one message.
   */
  it('keeps the message status neutral so the failed card owns the alarm', async () => {
    const host = await render(record({ error: REASON, attachments: [readyImage, failedFile] }));
    const status = host.querySelector('[role="status"]');

    expect(status?.className).toContain('text-muted-foreground');
    expect(status?.className).not.toContain('text-destructive');
    // The filename stays neutral for the same reason.
    const name = [...host.querySelectorAll('span')].find(
      (node) => node.textContent === 'evidence.zip'
    );
    expect(name?.className).not.toContain('text-destructive');
  });

  it('shows the record reason only when no attachment carries one', async () => {
    const host = await render(record({ error: REASON, attachments: [readyImage] }));

    expect(reasonNodes(host)).toHaveLength(1);
    expect(
      host.querySelector('.border-destructive\\/30')?.contains(host.querySelector('img'))
    ).toBe(false);
  });

  // Image frames match the delivered image and carry no caption, so a failed
  // image's reason must still reach the reader through the row notice.
  it('explains a failed image through the row notice', async () => {
    const host = await render(
      record({
        error: REASON,
        attachments: [{ ...readyImage, id: 'failed-image', ready: undefined, error: REASON }],
      })
    );

    expect(reasonNodes(host)).toHaveLength(1);
  });

  // A ready FILE sits beside the failed one on purpose: with only a ready image
  // here, painting every file card red would go unnoticed.
  it('leaves a finished attachment out of the failure styling', async () => {
    const host = await render(
      record({ error: REASON, attachments: [readyImage, readyFile, failedFile] })
    );
    const cards = [...host.querySelectorAll('div')].filter((node) =>
      node.className.includes('border-destructive/')
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain('evidence.zip');
    expect(cards[0]?.textContent).not.toContain('notes.md');
    expect(cards[0]?.textContent).not.toContain('design.png');
  });

  it('keeps the same file card mounted as progress becomes its final size', async () => {
    const uploading = { ...readyFile, ready: undefined, progress: 40 };
    const host = await render(record({ attachments: [uploading] }));
    const card = host.querySelector('button[aria-label="notes.md"]')?.parentElement;
    const progress = host.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuenow')).toBe('40');
    expect(card?.textContent).toContain('Uploading · 40%');

    await render(record({ attachments: [{ ...readyFile, source: undefined }] }));
    expect(host.querySelector('button[aria-label="notes.md"]')?.parentElement).toBe(card);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(card?.textContent).toBe('notes.md5 B');

    // The successful card owns the geometry before and after history publication.
    await act(async () =>
      root?.render(
        createElement(SessionFileCard, {
          file: {
            ...readyFile.ready,
            mimeType: 'text/markdown',
            uploadedAt: 1,
            textPreview: false,
          } as SessionFilePayload,
          retention: 'publication',
        })
      )
    );
    const delivered = host.querySelector('button[aria-label="notes.md"]')?.parentElement;
    expect(delivered?.textContent).toBe('notes.md5 B');
    expect(delivered?.querySelector('svg')?.outerHTML).toBe(card?.querySelector('svg')?.outerHTML);
  });

  it('retains the image after preparation releases the source, including remounts', async () => {
    const held = record({ attachments: [{ ...readyImage, ready: undefined, progress: 40 }] });
    const host = await render(held);
    const image = host.querySelector('img');
    const frame = image?.parentElement;
    expect(image?.getAttribute('src')).toBe('blob:pending-row-1');
    await seedSessionImageCache(
      { workspaceId: held.workspaceId as WorkspaceId, sessionId, imageId: 'uploaded' },
      readyImage.source!
    );
    const url = peekSessionImageUrl({
      workspaceId: held.workspaceId as WorkspaceId,
      sessionId,
      imageId: 'uploaded',
    });
    const prepared = record({ attachments: [{ ...readyImage, source: undefined }] });
    await render(prepared);
    expect(host.querySelector('img')).toBe(image);
    expect(image?.parentElement).toBe(frame);
    expect(image?.getAttribute('src')).toBe(url);
    expect(host.querySelector('[role="progressbar"]')).toBeNull();

    await act(async () => root?.render(null));
    await render(prepared);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(url);
  });

  it.each(['full', 'large', 'compact'] as const)(
    'paints the delivered %s image immediately from the prepared bytes',
    async (size) => {
      const held = record({ attachments: [readyImage] });
      const identity = {
        workspaceId: held.workspaceId as WorkspaceId,
        sessionId,
        imageId: 'uploaded',
      };
      await seedSessionImageCache(identity, readyImage.source!);
      const url = peekSessionImageUrl(identity);
      const store = createStore();
      store.set(currentWorkspaceIdAtom, identity.workspaceId);
      store.set(authTokenAtom, 'synthetic-preview-token');
      const entry = createSessionImageGalleryEntry({
        sessionId,
        messageId: held.id,
        itemIndex: 0,
        imageIndex: 0,
        image: readyImage.ready as never,
      });
      // Server rendering runs no effects: the image must exist before async loading begins.
      const markup = renderToStaticMarkup(
        createElement(
          Provider,
          { store },
          createElement(WorkspaceUserImageBlock, {
            entry,
            onPreviewRequest: () => {},
            variant: size === 'full' ? 'full' : 'thumbnail',
            thumbnailSize: size === 'large' ? 'large' : 'compact',
          })
        )
      );
      const fragment = document.createElement('div');
      fragment.innerHTML = markup;
      expect(fragment.querySelector('img')?.getAttribute('src')).toBe(url);
      expect(fragment.querySelectorAll('button')).toHaveLength(1);
      expect(fragment.querySelector('img')?.parentElement?.parentElement?.children).toHaveLength(1);
    }
  );

  it('offers continue-sending as the primary action beside cancel', async () => {
    const host = await render(record({ error: REASON, attachments: [failedFile] }));
    const buttons = [...host.querySelectorAll('button:not(:disabled)')];

    expect(buttons.map((button) => button.textContent)).toEqual([
      'Cancel send',
      'Continue sending',
    ]);
    // Ghost cancel must not carry the filled primary surface.
    expect(buttons[0]?.getAttribute('data-variant')).toBe('ghost');
    expect(buttons[1]?.getAttribute('data-variant')).toBe('primary');

    onRetry.mockImplementationOnce(() => {
      root?.render(
        createElement(PendingMessageRow, {
          record: record({ attachments: [{ ...failedFile, error: undefined, progress: 0 }] }),
          onRetry,
          onCancel,
        })
      );
    });
    await act(async () => {
      buttons[1]?.click();
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Waiting to send · Uploading attachments'
    );
    expect(reasonNodes(host)).toHaveLength(0);
    expect(
      [...host.querySelectorAll('button:not(:disabled)')].map((button) => button.textContent)
    ).toEqual(['Cancel send']);
  });

  it('exposes no retry action while attachments are still uploading', async () => {
    const host = await render(
      record({ attachments: [{ ...failedFile, error: undefined, progress: 40 }] })
    );

    expect(
      [...host.querySelectorAll('button:not(:disabled)')].map((button) => button.textContent)
    ).toEqual(['Cancel send']);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Waiting to send · Uploading attachments'
    );
  });
});

// The write reaches the conversation view before the held send is removed; in
// between, the turn must show once, as the history row, not also as a pending
// row beneath it.
describe('SessionPendingMessages', () => {
  it('hides a held send as soon as its turn is in history', async () => {
    await initI18n('en');
    URL.createObjectURL = () => 'blob:pending-row';
    URL.revokeObjectURL = () => {};
    const historyIds = new Set<string>();
    const listeners = new Set<() => void>();
    const history = {
      indexOf: (id: string) => (historyIds.has(id) ? 0 : -1),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const writing = Promise.withResolvers<void>();
    const finishWrite = Promise.withResolvers<void>();
    const pendingSends = createPendingSessionSends({
      prepare: async (send) => ({
        entry: send.entry,
        queue: send.queue,
        attachments: send.attachments.map((attachment) => ({ ...attachment, ...readyImage })),
      }),
      write: async (send) => {
        historyIds.add(send.id);
        for (const listener of listeners) listener();
        writing.resolve();
        await finishWrite.promise;
      },
      deliver: async () => {},
    });
    const store = createStore();
    store.set(runtimeAtom, {
      workspaceId: 'pending-row-workspace',
      workspaceSlug: 'pending-row-workspace',
      pendingSends,
    } as never);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(SessionPendingMessages, { sessionId, history })
        )
      );
    });

    const held = record({
      attachments: [{ ...readyImage, ready: undefined, progress: 0 }],
    });
    await act(async () => {
      pendingSends.enqueue(held);
      await writing.promise;
    });
    expect(pendingSends.has(held.id)).toBe(true);
    expect(container.textContent).toBe('');

    await act(async () => {
      finishWrite.resolve();
    });
    expect(pendingSends.has(held.id)).toBe(false);
    expect(container.textContent).toBe('');

    await act(async () => root.unmount());
    container.remove();
    pendingSends.dispose();
  });
});
