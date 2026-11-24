// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionMentionDropLayer } from '../src/components/sessions/session-mention-drop-layer';
import { initI18n } from '../src/i18n';
import {
  clearSessionMentionDrag,
  dropSessionMentionAtPoint,
  armSessionMentionDrag,
  registerSessionMentionPointerTarget,
  startSessionMentionDrag,
} from '../src/lib/session-mention-drag';
import { createSessionMentionTransfer } from './helpers/session-mention-transfer';
import { useAcceptableSessionMentionDrag } from '../src/hooks/use-session-mention-drag';

describe('session-mention-drop-layer', () => {
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

    it('accepts a pointer drag released over it, like a native drop', () => {
      const dropped: string[] = [];
      act(() => {
        root.render(
          <SessionMentionDropLayer
            enabled
            excludeSessionId="sess_open"
            onDropSessionId={(sessionId) => dropped.push(sessionId)}
          >
            <div data-testid="inside">active tab</div>
          </SessionMentionDropLayer>
        );
      });
      const inside = container.querySelector('[data-testid="inside"]');
      const elementFromPoint = document.elementFromPoint;
      document.elementFromPoint = () => inside;
      try {
        // The open conversation never mentions itself.
        expect(dropSessionMentionAtPoint(10, 10, 'sess_open')).toBe(false);
        expect(dropSessionMentionAtPoint(10, 10, 'sess_other')).toBe(true);
        document.elementFromPoint = () => document.body;
        expect(dropSessionMentionAtPoint(10, 10, 'sess_third')).toBe(false);
      } finally {
        document.elementFromPoint = elementFromPoint;
      }
      expect(dropped).toEqual(['sess_other']);
    });

    it('tells a pointer surface where an armed drag hovers, and that it left when the drag ends', () => {
      const surface = document.createElement('div');
      document.body.append(surface);
      const seen: string[] = [];
      const release = registerSessionMentionPointerTarget(surface, {
        accepts: () => true,
        drop: (sessionId, point) => seen.push(`drop ${sessionId} ${point?.y}`),
        hover: (x, y) => seen.push(`hover ${y}`),
        leave: () => seen.push('leave'),
      });
      const elementFromPoint = document.elementFromPoint;
      document.elementFromPoint = () => surface;
      const pointerMove = (y: number) =>
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: y }));
      try {
        pointerMove(20);
        // Any pointer drag source (tab strip, Pinned, Focus) reports moves once armed.
        armSessionMentionDrag('sess_a');
        pointerMove(30);
        dropSessionMentionAtPoint(5, 31, 'sess_a');
        pointerMove(40);
        clearSessionMentionDrag();
        pointerMove(50);
      } finally {
        document.elementFromPoint = elementFromPoint;
        release();
        surface.remove();
      }
      expect(seen).toEqual(['hover 30', 'drop sess_a 31', 'hover 40', 'leave']);
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
});

describe('use-session-mention-drag', () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  function Harness({ excludeSessionId }: { excludeSessionId?: string }) {
    const active = useAcceptableSessionMentionDrag(excludeSessionId);
    return <div data-testid="armed" data-active={active ? 'yes' : 'no'} />;
  }

  describe('useAcceptableSessionMentionDrag', () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      clearSessionMentionDrag();
      await act(async () => root.unmount());
      container.remove();
    });

    it('lights up as soon as a sidebar drag starts, and not for the open session', () => {
      act(() => {
        root.render(<Harness excludeSessionId="sess_open" />);
      });
      expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
        'no'
      );

      act(() => {
        startSessionMentionDrag(
          { dataTransfer: createSessionMentionTransfer() },
          { sessionId: 'sess_other' }
        );
      });
      expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
        'yes'
      );

      act(() => {
        startSessionMentionDrag(
          { dataTransfer: createSessionMentionTransfer() },
          { sessionId: 'sess_open' }
        );
      });
      expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
        'no'
      );

      act(() => {
        window.dispatchEvent(new Event('dragend'));
      });
      expect(container.querySelector('[data-testid="armed"]')?.getAttribute('data-active')).toBe(
        'no'
      );
    });
  });
});
