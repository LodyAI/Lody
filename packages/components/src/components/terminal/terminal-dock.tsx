import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_MAX_PER_SESSION,
} from '@lody/shared';
import { ChevronDown, Plus, TerminalSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useSetAtom } from 'jotai';
import { usePostHog } from '@posthog/react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { cn } from '@/lib/utils';
import { LocalTerminalPanel } from './local-terminal-panel';
import {
  terminalControllerAtom,
  terminalDockCanCreateAtom,
  terminalDockOpenAtom,
} from './terminal-controller';
import type { TerminalChannel, TerminalSnapshot } from './terminal-channel';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

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

const styles = stylex.create({
  root: { flex: 'none', overflow: 'hidden' },
  heightTransition: {
    transitionProperty: 'height',
    transitionDuration: themeDuration[200],
    transitionTimingFunction: themeEasing.out,
  },
  panel: {
    position: 'relative',
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    overflow: 'hidden',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--sidebar-border) / 0.8)',
    backgroundColor: themeColors.sidebar,
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    insetInline: 0,
    height: space[1.5],
    zIndex: 1,
    cursor: 'ns-resize',
    touchAction: 'none',
  },
  header: {
    display: 'flex',
    height: themeSpace[8],
    flex: 'none',
    alignItems: 'center',
    gap: themeSpace[3],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--sidebar-border) / 0.6)',
    paddingInline: themeSpace[2],
    fontSize: '11px',
    color: themeColors.mutedForeground,
  },
  tabStrip: {
    display: 'flex',
    height: '100%',
    minWidth: 0,
    flex: '1 1 0%',
    alignItems: 'center',
    gap: themeSpace[3],
    overflowX: 'auto',
  },
  tab: {
    display: 'flex',
    height: themeSpace[6],
    maxWidth: 'calc(var(--spacing) * 44)',
    minWidth: 0,
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  // The tab's canvas is already the sidebar; the selected fill stays flat.
  tabActive: {
    backgroundColor: themeColors.background,
    color: themeColors.tabActiveForeground,
  },
  tabInactive: {
    backgroundColor: {
      default: null,
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.08)' },
    },
    color: {
      default: themeColors.tabInactiveForeground,
      '@media (hover: hover)': { ':hover': themeColors.tabHoverForeground },
    },
  },
  tabButton: { display: 'flex', minWidth: 0, alignItems: 'center', gap: themeSpace[1] },
  terminalGlyph: {
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
    opacity: 0.7,
  },
  title: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  close: {
    flexShrink: 0,
    borderRadius: themeRadius.sm,
    padding: themeSpace[0.5],
    transitionProperty: 'opacity',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  closeActive: { opacity: { default: 0.7, '@media (hover: hover)': { ':hover': 1 } } },
  closeInactive: {
    opacity: {
      default: 0,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-terminal-tab]):hover')]: 1,
      },
    },
  },
  closeGlyph: { width: themeSpace[2.5], height: themeSpace[2.5] },
  action: {
    display: 'flex',
    height: '100%',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: themeSpace[0.5],
  },
  actionHover: {
    color: { default: null, '@media (hover: hover)': { ':hover': themeColors.foreground } },
  },
  createAction: {
    cursor: { default: null, ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.4 },
    color: {
      default: null,
      '@media (hover: hover)': {
        ':hover': themeColors.foreground,
        ':disabled:hover': themeColors.mutedForeground,
      },
    },
  },
  plusGlyph: { width: themeSpace[3], height: themeSpace[3] },
  error: { color: themeColors.destructive },
  collapseGlyph: { width: themeSpace[3.5], height: themeSpace[3.5], opacity: 0.7 },
  body: { minHeight: 0, flex: '1 1 0%', overflow: 'hidden' },
  empty: {
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: themeSpace[4],
    textAlign: 'center',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
});

const HEADER_HEIGHT = 32;
const DOCK_CHROME_HEIGHT = HEADER_HEIGHT + 1;

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
  // is false until this workspace's local runtime and session are ready).
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
        stylex.props(styles.root, !isResizing && styles.heightTransition).className,
        className
      )}
      style={{ height: isOpen ? bodyHeight + DOCK_CHROME_HEIGHT : 0 }}
      aria-hidden={!isOpen}
    >
      {isOpen ? (
        <div {...stylex.props(styles.panel)} style={{ height: bodyHeight + DOCK_CHROME_HEIGHT }}>
          {/* Drag-to-resize zone at the very top edge (no visible handle bar). */}
          <div
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            {...stylex.props(styles.resizeHandle)}
          />

          {/* Top tab strip: terminal tabs (+ new) fill the width left of the
              collapse chevron. */}
          <div {...stylex.props(styles.header)}>
            <div className={cn('lody-terminal-tab-strip', stylex.props(styles.tabStrip).className)}>
              {sessionId
                ? terminals.map((term) => {
                    const isActive = term.terminalId === activeId && view === 'terminal';
                    return (
                      <div
                        key={term.terminalId}
                        role="tab"
                        aria-selected={isActive}
                        data-terminal-tab=""
                        className={cn(
                          stylex.props(
                            stylex.defaultMarker(),
                            styles.tab,
                            isActive ? styles.tabActive : styles.tabInactive
                          ).className,
                          isActive && 'dark:bg-muted-foreground/[0.16]'
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => selectTerminal(term.terminalId)}
                          {...stylex.props(styles.tabButton)}
                        >
                          <TerminalSquare {...stylex.props(styles.terminalGlyph)} />
                          <span {...stylex.props(styles.title)}>{term.title || 'shell'}</span>
                        </button>
                        <button
                          type="button"
                          aria-label="Close terminal"
                          onClick={() => handleCloseTerminal(term.terminalId)}
                          {...stylex.props(
                            styles.close,
                            isActive ? styles.closeActive : styles.closeInactive
                          )}
                        >
                          <X {...stylex.props(styles.closeGlyph)} />
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
                  {...stylex.props(styles.action, styles.createAction)}
                >
                  <Plus {...stylex.props(styles.plusGlyph)} />
                </button>
              ) : null}
              {sessionId && terminalError ? (
                <span {...stylex.props(styles.title, styles.error)} title={terminalError}>
                  {terminalError}
                </span>
              ) : null}
            </div>

            {/* Collapse the whole dock back down. */}
            <button
              type="button"
              aria-label="Hide panel"
              onClick={toggleDock}
              {...stylex.props(styles.action, styles.actionHover)}
            >
              <ChevronDown {...stylex.props(styles.collapseGlyph)} />
            </button>
          </div>

          {/* Body: the active terminal. */}
          <div {...stylex.props(styles.body)}>
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
              />
            ) : (
              <div {...stylex.props(styles.empty, Boolean(terminalError) && styles.error)}>
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
