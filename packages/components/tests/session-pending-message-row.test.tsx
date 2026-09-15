// @vitest-environment jsdom

// A failed pending send is an ordinary user message, not an error report: the
// same reason must appear exactly ONCE (on the attachment that failed), the
// message level must stay a short status, and an attachment that finished must
// not be dragged into the failure. Regressions here are what made the row read
// like a debug panel.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';

import { PendingMessageRow } from '../src/components/chat/session-pending-messages';
import type { SessionAttachmentDraft } from '../src/lib/session-attachment-draft';
import type { SessionSendRecord } from '../src/lib/session-send-journal';
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

const record = (overrides: Partial<SessionSendRecord> = {}): SessionSendRecord =>
  ({
    version: 2,
    id: 'pending-turn',
    sessionId,
    accountId: 'tester',
    workspaceId: 'pending-row-workspace' as WorkspaceId,
    sourceReplica: 'replica',
    sequence: 1,
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
    stage: 'saved',
    ...overrides,
  }) as SessionSendRecord;

describe('PendingMessageRow failure presentation', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onRetry = vi.fn();
  const onCancel = vi.fn();

  beforeEach(async () => {
    await initI18n('en');
    // jsdom ships no object-URL support; the image card needs one to preview.
    URL.createObjectURL = () => 'blob:pending-row';
    URL.revokeObjectURL = () => {};
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
  });

  const render = async (value: SessionSendRecord) => {
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
    expect(host.textContent).toContain('Ready');
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

  /**
   * jsdom has no layout, so the equal-height property is guarded structurally:
   * every card reserves the progress row in the flow and only a transferring one
   * fills it. Dropping the reservation is what let cards resize mid-transfer.
   */
  it('reserves the progress row on every card and fills only the transferring one', async () => {
    const host = await render(
      record({
        error: REASON,
        attachments: [
          { ...failedFile, id: 'uploading-file', name: 'a.log', error: undefined, progress: 40 },
          readyFile,
          failedFile,
        ],
      })
    );

    expect(host.querySelectorAll('[data-attachment-progress]')).toHaveLength(3);
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  });

  it('offers continue-sending as the primary action beside cancel', async () => {
    const host = await render(record({ error: REASON, attachments: [failedFile] }));
    const buttons = [...host.querySelectorAll('button')];

    expect(buttons.map((button) => button.textContent)).toEqual([
      'Cancel send',
      'Continue sending',
    ]);
    // Ghost cancel must not carry the filled primary surface.
    expect(buttons[0]?.className).not.toContain('bg-primary');
    expect(buttons[1]?.className).toContain('bg-primary');

    await act(async () => {
      buttons[1]?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('exposes no retry action while attachments are still uploading', async () => {
    const host = await render(
      record({ attachments: [{ ...failedFile, error: undefined, progress: 40 }] })
    );

    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Cancel send',
    ]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Waiting to send · Uploading attachments'
    );
  });
});
