// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { describe, expect, it } from 'vitest';

import {
  AssistantTurnFooter,
  MOBILE_TURN_ACTION_LEADING_INSET_PX,
} from '../src/components/ai-gui/view';
import { EDGE_ZONE_PX } from '../src/components/mobile/mobile-edge-back-swipe';
import { ForceDesktopLayoutProvider } from '../src/hooks/use-mobile';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The mobile assistant-turn action bar puts the turn duration in front of the
 * copy / config / fork buttons. That leading slot is not decoration: it is what
 * keeps the copy button out of the session drawer's left-edge back-swipe strip.
 * Nothing inside the conversation `VList` can paint above that strip (virtua
 * sets `contain: strict`), so the buttons can only be rescued by insetting them.
 *
 * If the strip is ever widened, or the reserved inset shrunk, the copy button
 * silently becomes untappable again — a regression with no visual tell on
 * desktop and no type error. This pins the relationship instead.
 */
describe('mobile assistant-turn action bar inset', () => {
  it('reserves at least the full width of the edge-back swipe strip', () => {
    expect(MOBILE_TURN_ACTION_LEADING_INSET_PX).toBeGreaterThanOrEqual(EDGE_ZONE_PX);
  });

  it('reserves the inset from the row edge, before any conversation gutter', () => {
    /* The slot starts at the conversation gutter (>= 0 from the screen edge)
       and the strip starts at screen x=0, so a slot at least as wide as the
       strip clears it regardless of the gutter value. Guard against the inset
       being re-derived as "strip minus gutter", which would break the moment
       the gutter changed. */
    expect(MOBILE_TURN_ACTION_LEADING_INSET_PX).toBeGreaterThan(0);
    expect(EDGE_ZONE_PX).toBeGreaterThan(0);
  });
});

describe('desktop assistant-turn action bar visibility', () => {
  it('keeps the whole action group visible while a fork is pending', async () => {
    await initI18n('en');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const message = {
      id: 'assistant-turn-forking',
      role: 'assistant',
      timestamp: '2026-09-10T03:00:00.000Z',
      endedAt: '2026-09-10T03:00:01.000Z',
      finished: true,
      items: [{ type: 'text', text: 'A completed response.' }],
    } as unknown as SessionHistoryParsed;

    await act(async () => {
      root.render(
        createElement(
          ForceDesktopLayoutProvider,
          null,
          createElement(AssistantTurnFooter, {
            message,
            sessionId: 'session-forking' as SessionId,
            showDuration: true,
            isTurnHovered: false,
            onFork: () => undefined,
            isForking: true,
          })
        )
      );
    });

    const actions = container.querySelector('[data-assistant-turn-actions]');
    expect(actions?.classList.contains('opacity-100')).toBe(true);
    expect(container.querySelector('[aria-label="Copy response"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Fork session"] .animate-spin')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });
});
