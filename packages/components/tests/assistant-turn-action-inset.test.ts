// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentActivityRow,
  AssistantTurnFooter,
  MOBILE_TURN_ACTION_LEADING_INSET_PX,
  SessionChatActionContext,
} from '../src/components/ai-gui/view';
import { toggleMobileMessageActions } from '../src/components/ai-gui/mobile-message-actions';
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
});

describe('mobile assistant-turn action reveal', () => {
  const finishedTurn = (id: string) =>
    ({
      id,
      role: 'assistant',
      timestamp: '2026-09-10T03:00:00.000Z',
      endedAt: Date.parse('2026-09-10T03:00:08.000Z'),
      finished: true,
      items: [{ type: 'text', text: `Answer ${id}.` }],
    }) as unknown as SessionHistoryParsed;

  const renderTurns = async (turns: { id: string; isLatestTurn: boolean }[]) => {
    await initI18n('en');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          ForceMobileLayoutProvider,
          { force: true },
          ...turns.map(({ id, isLatestTurn }) =>
            createElement(
              'div',
              { key: id, 'data-turn': id },
              createElement(AssistantTurnFooter, {
                message: finishedTurn(id),
                sessionId: 'session-reveal' as SessionId,
                showDuration: false,
                isTurnHovered: false,
                isLatestTurn,
                onFork: () => undefined,
              })
            )
          )
        )
      );
    });
    return { container, root };
  };

  const buttonsHidden = (container: HTMLElement, id: string) =>
    container
      .querySelector(`[data-turn="${id}"] [aria-label="Copy response"]`)
      ?.closest('[data-mobile-actions-hidden]') != null;
  const durationText = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-turn="${id}"] [data-assistant-turn-actions] > span`)
      ?.textContent;

  it('rests older turns with only their duration, and taps reveal one turn at a time', async () => {
    const { container, root } = await renderTurns([
      { id: 'older-a', isLatestTurn: false },
      { id: 'older-b', isLatestTurn: false },
      { id: 'latest', isLatestTurn: true },
    ]);

    expect(buttonsHidden(container, 'older-a')).toBe(true);
    expect(buttonsHidden(container, 'older-b')).toBe(true);
    expect(buttonsHidden(container, 'latest')).toBe(false);
    // The duration is information, not an action: it stays on every turn.
    expect(durationText(container, 'older-a')).toBe('Worked for 8s');

    await act(async () => toggleMobileMessageActions('older-a'));
    expect(buttonsHidden(container, 'older-a')).toBe(false);

    await act(async () => toggleMobileMessageActions('older-b'));
    expect(buttonsHidden(container, 'older-a')).toBe(true);
    expect(buttonsHidden(container, 'older-b')).toBe(false);

    await act(async () => toggleMobileMessageActions('older-b'));
    expect(buttonsHidden(container, 'older-b')).toBe(true);
    expect(buttonsHidden(container, 'latest')).toBe(false);

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

describe('desktop live-turn duration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds and updates duration in the live activity status rather than a footer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T03:00:00.000Z'));
    await initI18n('en');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const message = {
      id: 'assistant-turn-desktop-live',
      role: 'assistant',
      timestamp: '2026-09-10T02:59:55.000Z',
      finished: false,
      items: [{ type: 'text', text: 'Still working.' }],
    } as unknown as SessionHistoryParsed;

    await act(async () => {
      root.render(
        createElement(
          ForceDesktopLayoutProvider,
          null,
          createElement(
            'div',
            null,
            createElement(AgentActivityRow, {
              label: 'Exploring',
              tone: 'primary',
              shimmer: true,
              message,
            }),
            createElement(AssistantTurnFooter, {
              message,
              sessionId: 'session-desktop-live' as SessionId,
              showDuration: false,
              isLive: true,
              isTurnHovered: false,
            })
          )
        )
      );
    });

    const activityLabel = () =>
      container.querySelector('[data-agent-activity-status]')?.textContent;
    expect(activityLabel()).toBe('Exploring (Worked for 5s)');
    expect(container.querySelector('[data-assistant-turn-duration]')).toBeNull();
    expect(container.querySelector('[data-assistant-turn-actions]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(activityLabel()).toBe('Exploring (Worked for 7s)');

    await act(async () => root.unmount());
    container.remove();
  });

  it('does not render a live duration for an unfinished turn that is no longer current', async () => {
    await initI18n('en');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const message = {
      id: 'assistant-turn-desktop-stale',
      role: 'assistant',
      timestamp: '2026-09-10T02:00:00.000Z',
      finished: false,
      items: [{ type: 'text', text: 'Interrupted.' }],
    } as unknown as SessionHistoryParsed;

    await act(async () => {
      root.render(
        createElement(
          ForceDesktopLayoutProvider,
          null,
          createElement(AssistantTurnFooter, {
            message,
            sessionId: 'session-desktop-stale' as SessionId,
            showDuration: false,
            isLive: false,
            isTurnHovered: false,
          })
        )
      );
    });

    expect(container.querySelector('[data-assistant-turn-duration]')).toBeNull();
    expect(container.querySelector('[data-assistant-turn-actions]')).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });
});
