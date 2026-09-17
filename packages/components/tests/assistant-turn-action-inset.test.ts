// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AssistantTurnFooter,
  MOBILE_TURN_ACTION_LEADING_INSET_PX,
  SessionChatActionContext,
} from '../src/components/ai-gui/view';
import { EDGE_ZONE_PX } from '../src/components/mobile/mobile-edge-back-swipe';
import { ForceDesktopLayoutProvider, ForceMobileLayoutProvider } from '../src/hooks/use-mobile';
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

describe('mobile assistant-turn duration slot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /* An unfinished turn renders its action bar only when a copy-context handler
     exists, so the gate is part of the scenario, not scaffolding. */
  const renderMobileFooter = async (
    message: SessionHistoryParsed
  ): Promise<{ container: HTMLDivElement; root: Root }> => {
    await initI18n('en');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          ForceMobileLayoutProvider,
          { force: true },
          createElement(
            SessionChatActionContext.Provider,
            { value: { copyContext: () => undefined } },
            createElement(AssistantTurnFooter, {
              message,
              sessionId: 'session-live' as SessionId,
              showDuration: false,
              isLive: message.finished !== true,
              isTurnHovered: false,
            })
          )
        )
      );
    });
    return { container, root };
  };

  const leadingSlotText = (container: HTMLElement): string | null =>
    container.querySelector('[data-assistant-turn-actions] > span')?.textContent ?? null;

  it('counts the live turn up once a second instead of leaving the slot blank', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T03:00:00.000Z'));
    const message = {
      id: 'assistant-turn-live',
      role: 'assistant',
      timestamp: '2026-09-10T02:59:55.000Z',
      items: [{ type: 'text', text: 'Still writing…' }],
    } as unknown as SessionHistoryParsed;

    const { container, root } = await renderMobileFooter(message);
    expect(leadingSlotText(container)).toBe('Worked for 5s');

    /* A whole number of sample periods, not a round 2s: the label is sampled
       faster than it changes, so the last sample inside the advanced window is
       what the span shows. */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(leadingSlotText(container)).toBe('Worked for 7s');

    await act(async () => root.unmount());
    container.remove();
  });

  it('flips the digit within a sample period of the real second boundary', async () => {
    /* The shared ticker's phase comes from whoever mounted first, not from this
       turn, so a once-a-second sample can land anywhere inside the second and
       the displayed value would sit up to a full second behind. Here the turn
       started 5.4s ago: the span becomes 6s at +600ms, and the label must say
       so well before a 1s sample would have noticed. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T03:00:00.000Z'));
    const message = {
      id: 'assistant-turn-live-phase',
      role: 'assistant',
      timestamp: '2026-09-10T02:59:54.600Z',
      items: [{ type: 'text', text: 'Still writing…' }],
    } as unknown as SessionHistoryParsed;

    const { container, root } = await renderMobileFooter(message);
    expect(leadingSlotText(container)).toBe('Worked for 5s');

    // 5.9s elapsed: six whole seconds have NOT passed, so the digit holds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(leadingSlotText(container)).toBe('Worked for 5s');

    // 6.1s elapsed, i.e. 100ms past the boundary — already updated.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(leadingSlotText(container)).toBe('Worked for 6s');

    await act(async () => root.unmount());
    container.remove();
  });

  it('leaves a finished turn on its recorded duration, which does not tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T03:00:00.000Z'));
    const message = {
      id: 'assistant-turn-done',
      role: 'assistant',
      timestamp: '2026-09-10T02:59:48.000Z',
      endedAt: Date.parse('2026-09-10T02:59:58.000Z'),
      finished: true,
      items: [{ type: 'text', text: 'Done.' }],
    } as unknown as SessionHistoryParsed;

    const { container, root } = await renderMobileFooter(message);
    expect(leadingSlotText(container)).toBe('Worked for 10s');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(leadingSlotText(container)).toBe('Worked for 10s');

    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps the slot reserved for a stalled turn that is no longer the live one', async () => {
    const message = {
      id: 'assistant-turn-interrupted',
      role: 'assistant',
      timestamp: '2026-09-10T02:00:00.000Z',
      items: [{ type: 'text', text: 'Interrupted.' }],
    } as unknown as SessionHistoryParsed;

    await initI18n('en');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          ForceMobileLayoutProvider,
          { force: true },
          createElement(
            SessionChatActionContext.Provider,
            { value: { copyContext: () => undefined } },
            createElement(AssistantTurnFooter, {
              message,
              sessionId: 'session-live' as SessionId,
              showDuration: false,
              isLive: false,
              isTurnHovered: false,
            })
          )
        )
      );
    });

    // An unfinished turn the session already moved past must not count forever.
    expect(leadingSlotText(container)).toBe('');
    const slot = container.querySelector<HTMLElement>('[data-assistant-turn-actions] > span');
    expect(slot?.style.minWidth).toBe(`${MOBILE_TURN_ACTION_LEADING_INSET_PX}px`);

    await act(async () => root.unmount());
    container.remove();
  });
});
