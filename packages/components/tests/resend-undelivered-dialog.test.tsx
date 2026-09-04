// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider as JotaiProvider, createStore } from 'jotai';
import {
  getSessionRoomId,
  type MachineId,
  type SessionHistoryParsed,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { MessageRowView } from '../src/components/ai-gui/view';
import type { UserTurnResendReason } from '../src/components/ai-gui/view';
import { initI18n } from '../src/i18n';
import { buildResendInputBlocks } from '../src/lib/undelivered-user-turn';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'session-not-delivered-dialog' as SessionId;
const missingTurnId = 'user-turn-missing-dialog';

const markerMeta = {
  id: sessionId,
  machineId: 'machine-1' as MachineId,
  userId: 'user-1',
  createdAt: '2026-08-19T09:00:00.000Z',
  cliType: 'builtin',
  agentType: 'codex',
  status: { type: 'idle' as const },
  latestUserMsgId: missingTurnId,
  lastMissingHistoryUserMsgId: missingTurnId,
} satisfies SessionMeta;

const undeliveredMessage = {
  id: missingTurnId,
  role: 'user',
  userId: 'user-1',
  timestamp: '2026-08-19T09:00:00.000Z',
  read: false,
  status: 'pending',
  items: [{ type: 'text', text: 'resend me from the dialog' }],
  inputConfig: {
    prompt: 'resend me from the dialog',
    inputBlocks: [{ type: 'text', text: 'resend me from the dialog' }],
  },
} as unknown as SessionHistoryParsed;

const uncertainMessage = {
  ...undeliveredMessage,
  id: 'user-turn-delivery-unknown',
  status: 'failed',
  read: true,
  sendStatus: 'delivery_unknown',
  items: [{ type: 'text', text: 'this steer may already have run' }],
  inputConfig: {
    prompt: 'this steer may already have run',
    inputBlocks: [{ type: 'text', text: 'this steer may already have run' }],
  },
} as unknown as SessionHistoryParsed;

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const queryBodyButton = (text: string): HTMLButtonElement => {
  const button = [...document.body.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!button) {
    throw new Error(`No button containing "${text}" rendered`);
  }
  return button;
};

describe('UserMessageRowView undelivered resend dialog', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  const renderRow = async (
    onResendUndelivered: (
      userTurnId: string,
      inputBlocks: unknown,
      reason: UserTurnResendReason
    ) => Promise<boolean>,
    message: SessionHistoryParsed = undeliveredMessage,
    onEdit?: (message: SessionHistoryParsed, text: string) => Promise<boolean>
  ) => {
    const store = createStore();
    store.set(sessionMetaCacheAtom, { [getSessionRoomId(sessionId)]: markerMeta });
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          { store },
          createElement(MessageRowView, {
            message,
            sessionId,
            onResendUndelivered,
            onEdit,
          })
        )
      );
    });
  };

  it('opens a confirmation dialog from the label and resends the exact content on confirm', async () => {
    const onResendUndelivered = vi.fn(async () => true);
    await renderRow(onResendUndelivered);

    await click(queryBodyButton('Not delivered'));
    expect(document.body.textContent).toContain('Message not delivered');
    expect(document.body.textContent).toContain('did not run');

    await click(queryBodyButton('Resend message'));
    expect(onResendUndelivered).toHaveBeenCalledTimes(1);
    expect(onResendUndelivered).toHaveBeenCalledWith(
      missingTurnId,
      buildResendInputBlocks(undeliveredMessage),
      'not-delivered'
    );
    // The dialog closed after the action.
    expect(document.body.textContent).not.toContain('did not run');
  });

  it('cancels without resending', async () => {
    const onResendUndelivered = vi.fn(async () => true);
    await renderRow(onResendUndelivered);

    await click(queryBodyButton('Not delivered'));
    expect(document.body.textContent).toContain('Message not delivered');

    await click(queryBodyButton('Cancel'));
    expect(onResendUndelivered).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('did not run');
  });

  it('warns before manually resending a delivery-ambiguous steer', async () => {
    const onResendUndelivered = vi.fn(async () => true);
    const onEdit = vi.fn(async () => true);
    await renderRow(onResendUndelivered, uncertainMessage, onEdit);

    expect(document.body.querySelector('[aria-label="Edit message"]')).toBeNull();

    await click(queryBodyButton('Delivery uncertain'));
    expect(document.body.textContent).toContain('may already have received');
    expect(document.body.textContent).toContain('may repeat work');

    await renderRow(
      onResendUndelivered,
      { ...uncertainMessage, status: 'handled', sendStatus: undefined } as SessionHistoryParsed,
      onEdit
    );
    expect(document.body.textContent).not.toContain('may repeat work');
    expect(onResendUndelivered).not.toHaveBeenCalled();

    await renderRow(onResendUndelivered, uncertainMessage, onEdit);
    await click(queryBodyButton('Delivery uncertain'));

    await click(queryBodyButton('Resend message'));
    expect(onResendUndelivered).toHaveBeenCalledWith(
      uncertainMessage.id,
      buildResendInputBlocks(uncertainMessage),
      'delivery-unknown'
    );
  });

  it('keeps the label non-interactive without a resend handler', async () => {
    const store = createStore();
    store.set(sessionMetaCacheAtom, { [getSessionRoomId(sessionId)]: markerMeta });
    await act(async () => {
      root?.render(
        createElement(
          JotaiProvider,
          { store },
          createElement(MessageRowView, { message: undeliveredMessage, sessionId })
        )
      );
    });

    const labelButton = [...document.body.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Not delivered')
    );
    expect(labelButton).toBeUndefined();
    expect(container?.textContent).toContain('Not delivered');
  });
});
