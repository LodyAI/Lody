import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_MAX_PER_SESSION,
} from '@lody/shared';
import { ChevronDown, Plus, TerminalSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useSetAtom } from 'jotai';
import { usePostHog } from '@posthog/react';

import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { cn } from '@/lib/utils';
import { LocalTerminalPanel } from './local-terminal-panel';
import {
  terminalControllerAtom,
  terminalDockCanCreateAtom,
  terminalDockOpenAtom,
} from './terminal-controller';
import type { TerminalChannel, TerminalSnapshot } from './terminal-channel';

// A bottom dock that stays fully hidden until it is opened (from the session
// header's dock toggle, or the ⌃` / ⌘J command). There is no always-present
// status bar — closed means zero height, no visible strip.
//
// When open, a floating rounded card (mirroring the desktop side panel) slides up
// from the bottom (animated height) with a tab strip on TOP: terminal tabs (+ new
// terminal) on the left and a collapse chevron on the right. The body below hosts
// the active terminal. See docs/terminal.md §6.
//
// Pure/presentational: terminal I/O goes through the injected `TerminalChannel`;
// Electron/local-session gating lives in the wrapper.

type DockView = 'terminal' | null;
type RememberedTerminalSessionState = {
  terminalOpen: boolean;
  activeTerminalId: string | null;
};

// The terminal tab strip's own canvas is already `bg-sidebar` (the floating
// card's fill), unlike `SessionTabBar`/`TAB_PILL_*`, whose pill sits on the
// app's plain `--background` canvas — reusing that treatment here stacked a
// border + shadow on a fill that matched its parent 1:1, so the pill read as
// heavy chrome instead of a lightweight selected state. Flat fill only, no
// border/shadow, and a step down from the card's own tone in dark mode where
// `--background`/`--sidebar` collapse together.
const TERMINAL_TAB_ACTIVE_CLASS =
  'bg-background text-tab-active-foreground dark:bg-muted-foreground/[0.16]';
const TERMINAL_TAB_INACTIVE_CLASS =
  'text-tab-inactive-foreground hover:bg-muted-foreground/[0.08] hover:text-tab-hover-foreground';

// Chrome above the resizable body: the drag zone (h-1.5 = 6px) + the top tab
// strip (h-8 = 32px). Added to `bodyHeight` for the floating card's height.
const RESIZE_HANDLE_HEIGHT = 6;
const HEADER_HEIGHT = 32;
const DOCK_CHROME_HEIGHT = RESIZE_HANDLE_HEIGHT + HEADER_HEIGHT;
// The card floats with mt-1 (4px) + mb-2 (8px) around it, so the animated outer
// wrapper is taller than the card by that much.
const CARD_VERTICAL_MARGIN = 12;
const DOCK_TOTAL_CHROME_HEIGHT = DOCK_CHROME_HEIGHT + CARD_VERTICAL_MARGIN;

const MIN_BODY_HEIGHT = 140;
const MAX_BODY_HEIGHT = 680;
// Never let the terminal exceed this fraction of the viewport, so the main
// content (chat) and the tabbar above it always stay visible.
const MAX_BODY_HEIGHT_RATIO = 0.75;
const DEFAULT_BODY_HEIGHT = 300;
const terminalSessionMemory = new Map<string, RememberedTerminalSessionState>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rememberTerminalSessionState(
  sessionId: string | undefined,
  patch: Partial<RememberedTerminalSessionState>
): void {
  if (!sessionId) return;
  const current = terminalSessionMemory.get(sessionId) ?? {
    terminalOpen: false,
    activeTerminalId: null,
  };
  const next = { ...current, ...patch };
  if (!next.terminalOpen && !next.activeTerminalId) {
    terminalSessionMemory.delete(sessionId);
    return;
  }
  terminalSessionMemory.set(sessionId, next);
}

function formatTerminalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('terminal_limit_exceeded')) {
    return `Terminal limit reached (${TERMINAL_MAX_PER_SESSION} per session).`;
  }
  if (message.includes('session_not_found')) {
    return 'Session is not ready for terminal yet.';
  }
  if (message.includes('session_archived') || message.includes('session_deleted')) {
    return 'Terminal is unavailable for archived or deleted sessions.';
  }
  if (message.includes('session_machine_mismatch')) {
    return 'Terminal is only available on the machine that owns this session.';
  }
  if (message.includes('workdir_unavailable')) {
    return 'Session workdir is unavailable.';
  }
  if (message.includes('daemon_unavailable')) {
    return 'Local terminal daemon is unavailable.';
  }
  return message || 'Terminal unavailable.';
}

export interface TerminalDockProps {
  channel: TerminalChannel;
  /** Active local session. Undefined => out of session: no terminal tabs. */
  sessionId?: string;
  canCreateTerminal?: boolean;
  autoOpenFirstTerminal?: boolean;
  defaultView?: DockView;
  className?: string;
}

export function TerminalDock({
  channel,
  sessionId,
  canCreateTerminal = Boolean(sessionId),
  autoOpenFirstTerminal = false,
  defaultView,
  className,
}: TerminalDockProps) {
  const postHog = usePostHog();
  const [terminals, setTerminals] = useState<TerminalSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<DockView>(() => {
    const remembered = sessionId ? terminalSessionMemory.get(sessionId) : undefined;
    if (remembered?.terminalOpen) return 'terminal';
    if (sessionId && defaultView === 'terminal') {
      rememberTerminalSessionState(sessionId, { terminalOpen: true });
    }
    return defaultView ?? null;
  });
  const [bodyHeight, setBodyHeight] = useState(DEFAULT_BODY_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  const [isOpeningTerminal, setIsOpeningTerminal] = useState(false);
  const [isLoadingTerminals, setIsLoadingTerminals] = useState(false);
  const [loadedTerminalSessionId, setLoadedTerminalSessionId] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 900 : window.innerHeight
  );
  const loadedTerminalSessionIdRef = useRef<string | null>(null);
  const updateLoadedTerminalSessionId = useCallback((nextSessionId: string | null) => {
    loadedTerminalSessionIdRef.current = nextSessionId;
    setLoadedTerminalSessionId(nextSessionId);
  }, []);

  // Publish the open/closed state so the session header's dock toggle button can
  // reflect it. `view !== null` is the single source of truth for "dock is open".
  const isOpen = view !== null;
  const setDockOpen = useSetAtom(terminalDockOpenAtom);
  useEffect(() => {
    setDockOpen(isOpen);
  }, [isOpen, setDockOpen]);
  useEffect(() => () => setDockOpen(false), [setDockOpen]);

  // Opening/closing the dock resizes the chat viewport above it (flex sibling)
  // over a 200ms height transition. Announce the transition so the conversation's
  // sticky-scroll can pump scroll-to-bottom for its duration and keep the latest
  // messages visible instead of getting covered. Fire only on real transitions,
  // not on mount.
  const prevOpenRef = useRef(isOpen);
  useEffect(() => {
    if (prevOpenRef.current === isOpen) return;
    prevOpenRef.current = isOpen;
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('lody:terminal-dock-resize', { detail: { open: isOpen } })
    );
  }, [isOpen]);

  // Publish whether a terminal can be created right now so the header icon can
  // disable itself while the local daemon is still starting (canCreateTerminal
  // is false until it reaches running/degraded).
  const setDockCanCreate = useSetAtom(terminalDockCanCreateAtom);
  useEffect(() => {
    setDockCanCreate(canCreateTerminal);
  }, [canCreateTerminal, setDockCanCreate]);
  useEffect(() => () => setDockCanCreate(false), [setDockCanCreate]);

  // Load / reconcile the active session's terminals.
  useEffect(() => {
    if (!sessionId) {
      setTerminals([]);
      setActiveId(null);
      setTerminalError(null);
      setIsLoadingTerminals(false);
      updateLoadedTerminalSessionId(null);
      setView((prev) => (prev === 'terminal' ? null : prev));
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const remembered = terminalSessionMemory.get(sessionId);
      const isReloadingCurrentSession = loadedTerminalSessionIdRef.current === sessionId;
      setIsLoadingTerminals(true);
      if (!isReloadingCurrentSession) {
        updateLoadedTerminalSessionId(null);
        setTerminals([]);
        setActiveId(null);
        setView((prev) => {
          if (remembered?.terminalOpen) return 'terminal';
          return prev === 'terminal' ? null : prev;
        });
      }
      try {
        const existing = await channel.list(sessionId);
        if (cancelled) return;
        setTerminalError(null);
        if (existing.length > 0) {
          const rememberedActiveId = remembered?.activeTerminalId;
          const nextActiveId =
            existing.find((terminal) => terminal.terminalId === rememberedActiveId)?.terminalId ??
            existing[0]?.terminalId ??
            null;
          setTerminals(existing);
          setActiveId(nextActiveId);
          if (remembered?.terminalOpen) {
            rememberTerminalSessionState(sessionId, { activeTerminalId: nextActiveId });
          }
          updateLoadedTerminalSessionId(sessionId);
          return;
        }
        if (!autoOpenFirstTerminal || !canCreateTerminal) {
          setTerminals([]);
          setActiveId(null);
          updateLoadedTerminalSessionId(sessionId);
          setView((prev) => (prev === 'terminal' ? null : prev));
          rememberTerminalSessionState(sessionId, {
            terminalOpen: false,
            activeTerminalId: null,
          });
          return;
        }
        const { terminalId } = await channel.open({
          sessionId,
          cols: TERMINAL_DEFAULT_COLS,
          rows: TERMINAL_DEFAULT_ROWS,
        });
        if (cancelled) return;
        setTerminalError(null);
        setTerminals([{ terminalId, title: 'shell' }]);
        setActiveId(terminalId);
        updateLoadedTerminalSessionId(sessionId);
        rememberTerminalSessionState(sessionId, {
          terminalOpen: remembered?.terminalOpen ?? defaultView === 'terminal',
          activeTerminalId: terminalId,
        });
      } catch (error) {
        if (cancelled) return;
        setTerminalError(formatTerminalError(error));
        if (!isReloadingCurrentSession) {
          setTerminals([]);
          setActiveId(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingTerminals(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    autoOpenFirstTerminal,
    canCreateTerminal,
    channel,
    defaultView,
    sessionId,
    updateLoadedTerminalSessionId,
  ]);

  // Keep titles fresh and drop exited terminals.
  useEffect(() => {
    const offTitle = channel.onTitle(({ terminalId, title }) => {
      setTerminals((prev) => prev.map((t) => (t.terminalId === terminalId ? { ...t, title } : t)));
    });
    const offExit = channel.onExit(({ terminalId }) => {
      setTerminals((prev) => prev.filter((t) => t.terminalId !== terminalId));
    });
    return () => {
      offTitle();
      offExit();
    };
  }, [channel]);

  // If the active terminal disappears, fall back to the first remaining one.
  useEffect(() => {
    if (activeId && !terminals.some((t) => t.terminalId === activeId)) {
      const nextActiveId = terminals[0]?.terminalId ?? null;
      setActiveId(nextActiveId);
      rememberTerminalSessionState(sessionId, { activeTerminalId: nextActiveId });
    }
  }, [terminals, activeId, sessionId]);

  useEffect(() => {
    if (view !== 'terminal') return;
    if (isLoadingTerminals || isOpeningTerminal || terminalError) return;
    if (loadedTerminalSessionId !== sessionId) return;
    if (terminals.length === 0) {
      setView(null);
      rememberTerminalSessionState(sessionId, {
        terminalOpen: false,
        activeTerminalId: null,
      });
    }
  }, [
    isLoadingTerminals,
    isOpeningTerminal,
    loadedTerminalSessionId,
    sessionId,
    terminalError,
    terminals.length,
    view,
  ]);

  const selectTerminal = useCallback(
    (id: string) => {
      setView((prev) => {
        const nextView = prev === 'terminal' && activeId === id ? null : 'terminal';
        rememberTerminalSessionState(sessionId, {
          terminalOpen: nextView === 'terminal',
          activeTerminalId: id,
        });
        return nextView;
      });
      setActiveId(id);
    },
    [activeId, sessionId]
  );

  const terminalLimitReached = terminals.length >= TERMINAL_MAX_PER_SESSION;
  const canOpenTerminal = canCreateTerminal && !terminalLimitReached;

  const handleNewTerminal = useCallback(async () => {
    if (!sessionId || !canOpenTerminal || isOpeningTerminal) return;
    setIsOpeningTerminal(true);
    setTerminalError(null);
    try {
      const { terminalId } = await channel.open({
        sessionId,
        cols: TERMINAL_DEFAULT_COLS,
        rows: TERMINAL_DEFAULT_ROWS,
      });
      setTerminals((prev) => [...prev, { terminalId, title: 'shell' }]);
      setActiveId(terminalId);
      setView('terminal');
      rememberTerminalSessionState(sessionId, {
        terminalOpen: true,
        activeTerminalId: terminalId,
      });
    } catch (error) {
      setTerminalError(formatTerminalError(error));
    } finally {
      setIsOpeningTerminal(false);
    }
  }, [canOpenTerminal, channel, isOpeningTerminal, sessionId]);

  const handleCloseTerminal = useCallback(
    (id: string) => {
      channel.close(id);
      setTerminals((prev) => prev.filter((t) => t.terminalId !== id));
    },
    [channel]
  );

  // Open the dock: reuse the active terminal, or create one when the session can
  // host terminals. When there are no terminals and none can be created (e.g. the
  // local daemon is down), stay closed rather than opening an empty panel.
  const openDock = useCallback(() => {
    if (terminals.length === 0) {
      if (canOpenTerminal) void handleNewTerminal();
      return;
    }
    const targetId = activeId ?? terminals[0]?.terminalId ?? null;
    setActiveId(targetId);
    setView('terminal');
    rememberTerminalSessionState(sessionId, { terminalOpen: true, activeTerminalId: targetId });
  }, [activeId, canOpenTerminal, handleNewTerminal, sessionId, terminals]);

  // Open the dock if it's closed, close it if it's open. Drives the header dock
  // toggle button and the ⌃` / ⌘J command.
  const toggleDock = useCallback(() => {
    if (view !== null) {
      setView(null);
      rememberTerminalSessionState(sessionId, { terminalOpen: false });
      return;
    }
    openDock();
  }, [openDock, sessionId, view]);

  // Publish the dock controls so app-level handlers (the header dock toggle,
  // ⌃`/⌘J toggle, ⌥N new-terminal-when-focused) can reach them without
  // prop-threading. Only while this dock hosts a terminal-capable local session
  // (`sessionId` set) — otherwise the toggle command / header icon stay hidden.
  const setTerminalController = useSetAtom(terminalControllerAtom);
  useEffect(() => {
    if (!sessionId) return undefined;
    const controller = { toggleOpen: toggleDock, openNewTerminal: handleNewTerminal };
    setTerminalController(controller);
    return () => {
      setTerminalController((current) => (current === controller ? null : current));
    };
  }, [handleNewTerminal, sessionId, setTerminalController, toggleDock]);

  const updateActiveTitle = useCallback(
    (title: string) => {
      setTerminals((prev) => prev.map((t) => (t.terminalId === activeId ? { ...t, title } : t)));
    },
    [activeId]
  );

  // Cap the body to a fraction of the viewport (with an absolute ceiling) so the
  // terminal can never push the chat / tabbar off screen.
  const maxBodyHeight = clamp(
    Math.floor(viewportHeight * MAX_BODY_HEIGHT_RATIO),
    MIN_BODY_HEIGHT,
    MAX_BODY_HEIGHT
  );
  const maxBodyHeightRef = useRef(maxBodyHeight);
  maxBodyHeightRef.current = maxBodyHeight;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Shrink an already-tall body if the viewport got smaller.
  useEffect(() => {
    setBodyHeight((h) => Math.min(h, maxBodyHeight));
  }, [maxBodyHeight]);

  // Drag-to-resize the body height (dragging the top handle up grows the panel,
  // pushing content up via flex layout). Disable the open/close height transition
  // while dragging so the panel tracks the pointer 1:1.
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const onResizeDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      dragRef.current = { startY: event.clientY, startHeight: bodyHeight };
      setIsResizing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [bodyHeight]
  );
  const onResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setBodyHeight(
      clamp(
        drag.startHeight + (drag.startY - event.clientY),
        MIN_BODY_HEIGHT,
        maxBodyHeightRef.current
      )
    );
  }, []);
  const onResizeUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setIsResizing(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // pointer already released
    }
  }, []);

  return (
    <div
      className={cn(
        'flex-none overflow-hidden',
        !isResizing && 'transition-[height] duration-200 ease-out',
        className
      )}
      style={{ height: isOpen ? bodyHeight + DOCK_TOTAL_CHROME_HEIGHT : 0 }}
      aria-hidden={!isOpen}
    >
      {isOpen ? (
        // Floating rounded card, mirroring the desktop side panel (sidebar) look.
        <div
          className="mx-2 mb-2 mt-1 flex min-w-0 flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]"
          style={{ height: bodyHeight + DOCK_CHROME_HEIGHT }}
        >
          {/* Drag-to-resize zone at the very top edge (no visible handle bar). */}
          <div
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            className="h-1.5 flex-none cursor-ns-resize"
          />

          {/* Top tab strip: terminal tabs (+ new) fill the width left of the
              collapse chevron. */}
          <div className="flex h-8 flex-none items-center gap-3 border-b border-sidebar-border/60 px-2 text-[11px] text-muted-foreground">
            <div className="lody-terminal-tab-strip flex h-full min-w-0 flex-1 items-center gap-3 overflow-x-auto">
              {sessionId
                ? terminals.map((term) => {
                    const isActive = term.terminalId === activeId && view === 'terminal';
                    return (
                      <div
                        key={term.terminalId}
                        role="tab"
                        aria-selected={isActive}
                        className={cn(
                          'group flex h-6 max-w-44 min-w-0 shrink-0 items-center gap-1 rounded-md px-2 transition-colors',
                          isActive ? TERMINAL_TAB_ACTIVE_CLASS : TERMINAL_TAB_INACTIVE_CLASS
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => selectTerminal(term.terminalId)}
                          className="flex min-w-0 items-center gap-1"
                        >
                          <TerminalSquare className="h-3 w-3 shrink-0 opacity-70" />
                          <span className="min-w-0 truncate">{term.title || 'shell'}</span>
                        </button>
                        <button
                          type="button"
                          aria-label="Close terminal"
                          onClick={() => handleCloseTerminal(term.terminalId)}
                          className={cn(
                            'shrink-0 rounded-sm p-0.5 transition-opacity',
                            isActive
                              ? 'opacity-70 hover:opacity-100'
                              : 'opacity-0 group-hover:opacity-100'
                          )}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    );
                  })
                : null}
              {sessionId ? (
                <button
                  type="button"
                  aria-label="New terminal"
                  title={
                    terminalLimitReached
                      ? `Limit ${TERMINAL_MAX_PER_SESSION} terminals per session`
                      : undefined
                  }
                  disabled={!canOpenTerminal || isOpeningTerminal}
                  onClick={() => {
                    void handleNewTerminal();
                  }}
                  className="flex h-full shrink-0 items-center justify-center px-0.5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
                >
                  <Plus className="h-3 w-3" />
                </button>
              ) : null}
              {sessionId && terminalError ? (
                <span className="min-w-0 truncate text-destructive" title={terminalError}>
                  {terminalError}
                </span>
              ) : null}
            </div>

            {/* Collapse the whole dock back down. */}
            <button
              type="button"
              aria-label="Hide panel"
              onClick={toggleDock}
              className="flex h-full shrink-0 items-center justify-center px-0.5 hover:text-foreground"
            >
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
          </div>

          {/* Body: the active terminal. */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeId ? (
              <LocalTerminalPanel
                key={activeId}
                channel={channel}
                terminalId={activeId}
                onCommandSubmitted={() => {
                  capturePostHogEvent(postHog, 'session/terminal_command_sent', {
                    session_id: sessionId,
                  });
                }}
                onTitleChange={updateActiveTitle}
                className="px-2 py-1"
              />
            ) : (
              <div
                className={cn(
                  'flex h-full items-center justify-center px-4 text-center text-xs',
                  terminalError ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {terminalError ??
                  (isLoadingTerminals ? 'Loading terminals...' : 'No terminal open')}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
