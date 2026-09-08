// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';

import { MessageRowView } from '../src/components/ai-gui/view';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'agent-warning-session' as SessionId;

function warningMessage(meta: Record<string, unknown>): SessionHistoryParsed {
  return {
    id: 'agent-warning-notice',
    role: 'system',
    timestamp: '2026-09-08T00:00:00.000Z',
    read: true,
    items: [
      {
        type: 'system_notice',
        name: 'agent_warning',
        meta,
      },
    ],
  } as SessionHistoryParsed;
}

describe('Agent warning notices', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(meta: Record<string, unknown>) {
    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <MessageRowView message={warningMessage(meta)} sessionId={sessionId} />
        </Provider>
      );
    });
  }

  it('announces informational outcomes without warning treatment', async () => {
    await render({ message: 'Command exited with status 1.', level: 'info' });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Command exited with status 1.'
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Agent notice');
  });

  it('keeps legacy notices as warnings when level is absent', async () => {
    await render({ message: 'Agent needs attention.' });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Agent needs attention.'
    );
    expect(container.textContent).toContain('Agent warning');
  });
});
