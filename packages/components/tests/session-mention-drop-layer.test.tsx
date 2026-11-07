// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionMentionDropLayer } from '../src/components/sessions/session-mention-drop-layer';
import { initI18n } from '../src/i18n';
import { clearSessionMentionDrag, startSessionMentionDrag } from '../src/lib/session-mention-drag';
import { createSessionMentionTransfer } from './helpers/session-mention-transfer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionMentionDropLayer', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    clearSessionMentionDrag();
    await act(async () => root.unmount());
    container.remove();
  });

  it('paints one overlay for a tab stack as soon as a sidebar drag starts', () => {
    act(() => {
      root.render(
        <SessionMentionDropLayer
          enabled
          excludeSessionId="sess_open"
          onDropSessionId={() => undefined}
        >
          <div hidden style={{ position: 'absolute', inset: 0 }}>
            hidden tab
          </div>
          <div style={{ position: 'absolute', inset: 0 }}>active tab</div>
        </SessionMentionDropLayer>
      );
    });
    expect(container.querySelector('[data-testid="conversation-drop-overlay"]')).toBeNull();

    act(() => {
      startSessionMentionDrag(
        { dataTransfer: createSessionMentionTransfer() },
        { sessionId: 'sess_other' }
      );
    });
    const overlay = container.querySelector('[data-testid="conversation-drop-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('data-drop-kind')).toBe('session-mention');
  });

  it('does not light up when the active tab is the dragged session', () => {
    act(() => {
      root.render(
        <SessionMentionDropLayer
          enabled
          excludeSessionId="sess_open"
          onDropSessionId={() => undefined}
        >
          <div>active tab</div>
        </SessionMentionDropLayer>
      );
    });
    act(() => {
      startSessionMentionDrag(
        { dataTransfer: createSessionMentionTransfer() },
        { sessionId: 'sess_open' }
      );
    });
    expect(container.querySelector('[data-testid="conversation-drop-overlay"]')).toBeNull();
  });
});
