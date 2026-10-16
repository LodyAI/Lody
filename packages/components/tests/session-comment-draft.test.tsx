// @vitest-environment jsdom

import { useState } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { CommentReferencePayload } from '@lody/shared';
import { SessionCommentDraft } from '../src/ui/diff-viewer/session-comment-draft';
import type { CommentAnchor } from '../src/ui/diff-viewer/session-comment-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const anchor: CommentAnchor = {
  anchorType: 'diff',
  path: 'src/app.ts',
  lineNumber: 12,
  side: 'additions',
  turnId: 'turn-1',
  mode: 'conversation',
};

function Harness(props: {
  anchor?: CommentAnchor;
  anonymous?: boolean;
  prLinked?: boolean;
  onSendToChat?: (reference: CommentReferencePayload) => boolean | void;
  onSubmitToGitHub?: (input: { anchor: CommentAnchor; body: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  return open ? (
    <SessionCommentDraft
      anchor={props.anchor ?? anchor}
      currentUser={props.anonymous ? null : { id: 'user-1', name: 'Ada' }}
      prLinked={props.prLinked}
      onSendToChat={props.onSendToChat}
      onSubmitToGitHub={props.onSubmitToGitHub}
      onCancel={() => setOpen(false)}
    />
  ) : (
    <p>closed</p>
  );
}

describe('SessionCommentDraft', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    let id = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  const render = (node: React.ReactNode) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(node));
    return container;
  };

  const type = (text: string) => {
    const textarea = container?.querySelector('textarea');
    if (!textarea) throw new Error('Expected comment textarea');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        text
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const click = async (label: string) => {
    const button = Array.from(container?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent === label
    );
    if (!button) throw new Error(`Expected ${label} button`);
    await act(async () => button.click());
  };

  const key = async (eventKey: string, ctrlKey = false) => {
    await act(async () => {
      container
        ?.querySelector('textarea')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: eventKey, ctrlKey, bubbles: true, cancelable: true })
        );
    });
  };

  it('adds a local reference to chat without a linked pull request', async () => {
    const sent: CommentReferencePayload[] = [];
    const view = render(<Harness onSendToChat={(reference) => void sent.push(reference)} />);

    expect(view.textContent).toContain('Sends with your next message');
    expect(view.textContent).not.toContain('Comment');
    type('  Rename this helper.  ');
    await click('Add to chat');

    expect(sent).toEqual([
      expect.objectContaining({
        source: 'lody',
        path: 'src/app.ts',
        lineNumber: 12,
        side: 'additions',
        commentBody: 'Rename this helper.',
        authorName: 'Ada',
        turnId: 'turn-1',
        mode: 'conversation',
      }),
    ]);
    expect(view.textContent).toBe('closed');
  });

  it('posts to GitHub when a pull request is linked and still offers chat', async () => {
    const posted: string[] = [];
    const view = render(
      <Harness
        prLinked
        onSendToChat={() => true}
        onSubmitToGitHub={async (input) => void posted.push(input.body)}
      />
    );

    expect(view.textContent).toContain('Posts to GitHub');
    expect(view.textContent).toContain('Add to chat');
    type('Ship it');
    await click('Comment');

    expect(posted).toEqual(['Ship it']);
    expect(view.textContent).toBe('closed');
  });

  it('uses an anonymous author and additions for a file anchor in All Changes', async () => {
    const sent: CommentReferencePayload[] = [];
    const view = render(
      <Harness
        anonymous
        anchor={{ anchorType: 'file', path: 'README.md', lineNumber: 1, mode: 'base' }}
        onSendToChat={(ref) => void sent.push(ref)}
      />
    );
    type('  Keep this file.  ');
    await key('Enter', true);
    expect(sent).toEqual([
      {
        source: 'lody',
        path: 'README.md',
        lineNumber: 1,
        side: 'additions',
        commentBody: 'Keep this file.',
        authorName: 'Anonymous',
        authorImage: undefined,
        turnId: undefined,
        mode: 'base',
        threadId: '00000000-0000-4000-8000-000000000001',
      },
    ]);
    expect(view.textContent).toBe('closed');
  });

  it('keeps rejected keyboard submissions editable and cancels with Escape', async () => {
    const view = render(<Harness onSendToChat={() => false} />);
    type('Keep this draft');
    await key('Enter', true);
    expect(view.querySelector('textarea')?.value).toBe('Keep this draft');
    expect(view.querySelector('textarea')?.disabled).toBe(false);
    await key('Escape');
    expect(view.textContent).toBe('closed');
  });

  it('blocks empty comments and drafts without a destination', async () => {
    const sent: CommentReferencePayload[] = [];
    const view = render(<Harness onSendToChat={(ref) => void sent.push(ref)} />);
    type('   ');
    await click('Add to chat');
    await key('Enter', true);
    expect(sent).toEqual([]);
    act(() => root?.render(<Harness />));
    type('No destination');
    await click('Add to chat');
    await key('Enter', true);
    expect(view.querySelector('textarea')?.value).toBe('No destination');
    expect(
      Array.from(view.querySelectorAll('button')).find((b) => b.textContent === 'Add to chat')
        ?.disabled
    ).toBe(true);
  });

  it('sends the secondary action locally without posting to a linked PR', async () => {
    const sent: CommentReferencePayload[] = [];
    const posted: string[] = [];
    const view = render(
      <Harness
        prLinked
        onSendToChat={(ref) => void sent.push(ref)}
        onSubmitToGitHub={async ({ body }) => void posted.push(body)}
      />
    );
    type('Local review');
    await click('Add to chat');
    expect(sent.map((ref) => [ref.source, ref.commentBody])).toEqual([['lody', 'Local review']]);
    expect(posted).toEqual([]);
    expect(view.textContent).toBe('closed');
  });

  it('locks controls during a GitHub keyboard submission and retains text on failure', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const posted: string[] = [];
    const sent: CommentReferencePayload[] = [];
    const view = render(
      <Harness
        prLinked
        onSendToChat={(ref) => void sent.push(ref)}
        onSubmitToGitHub={({ body }) => {
          posted.push(body);
          return pending;
        }}
      />
    );
    type('Review before merge');
    await key('Enter', true);
    expect(view.querySelector('textarea')?.disabled).toBe(true);
    expect(Array.from(view.querySelectorAll('button')).every((b) => b.disabled)).toBe(true);
    await key('Enter', true);
    await click('Add to chat');
    expect(posted).toEqual(['Review before merge']);
    expect(sent).toEqual([]);
    await act(async () => reject(new Error('Synthetic GitHub failure')));
    expect(view.querySelector('textarea')?.value).toBe('Review before merge');
    expect(view.querySelector('textarea')?.disabled).toBe(false);
    await key('Enter', true);
    expect(posted).toEqual(['Review before merge', 'Review before merge']);
  });
});
