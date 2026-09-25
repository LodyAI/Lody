import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@xterm/xterm/css/xterm.css';
import './terminal-scrollbars.css';

import { terminalFontFamilyAtom, terminalFontSizeAtom } from '@/atoms';
import { formatKeyBinding } from '@/lib/commands';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';
import { ContextMenu } from '@lody/ui/context-menu';
import { useActiveVSCodeThemeId, useResolvedTheme } from '../../theme-provider';
import {
  copyShortcutBinding,
  isCopyShortcut,
  isPasteShortcut,
  pasteShortcutBinding,
  usesWindowsCopyPasteRightClick,
} from './terminal-clipboard-shortcuts';
import type { TerminalChannel } from './terminal-channel';
import {
  applyKeyboardSelection,
  isKeyboardSelectionKey,
  isKeyboardSelectionShortcut,
  keyboardSelectionMatchesExisting,
  selectionUnitForEvent,
  type CellPos,
} from './terminal-keyboard-selection';
import {
  buildTerminalFontLoadSpec,
  buildTerminalTheme,
  resolveTerminalFontFamily,
} from './terminal-theme';

// A single interactive terminal: one xterm.js instance bound to one PTY via the
// channel. Pure/presentational — all I/O goes through the injected `TerminalChannel`,
// so it renders identically against the mock and (later) the real Electron-IPC channel.
// Colors/font come from the shared theme (the `--terminal-*` CSS fields, see
// `terminal-theme.ts`) so it matches the app surface in light/dark + VS Code themes.

export interface LocalTerminalPanelProps {
  channel: TerminalChannel;
  terminalId: string;
  /** Called once per submitted shell line. Command text is never exposed. */
  onCommandSubmitted?: () => void;
  onTitleChange?: (title: string) => void;
  onExit?: (exitCode: number) => void;
  className?: string;
}

function readExistingSelection(term: Terminal): { start: CellPos; end: CellPos } | null {
  const range = term.getSelectionPosition();
  if (!range) return null;
  return {
    start: { x: range.start.x, y: range.start.y },
    end: { x: range.end.x, y: range.end.y },
  };
}

function waitForTerminalFont(fontFamily: string, fontSize: number): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts?.load) {
    return Promise.resolve();
  }

  const requestedFont = document.fonts.load(buildTerminalFontLoadSpec(fontFamily, fontSize));
  const fallbackFont = fontFamily
    ? document.fonts.load(buildTerminalFontLoadSpec('', fontSize))
    : Promise.resolve();
  return Promise.all([requestedFont, fallbackFont]).catch(() => undefined);
}

export function LocalTerminalPanel({
  channel,
  terminalId,
  onCommandSubmitted,
  onTitleChange,
  onExit,
  className,
}: LocalTerminalPanelProps) {
  const { t: translate } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const copyShortcutLabel = formatKeyBinding(copyShortcutBinding());
  const pasteShortcutLabel = formatKeyBinding(pasteShortcutBinding());
  const windowsRightClick = usesWindowsCopyPasteRightClick();
  const terminalFontFamily = useAtomValue(terminalFontFamilyAtom);
  const terminalFontSize = useAtomValue(terminalFontSizeAtom);
  const terminalFontFamilyRef = useRef(terminalFontFamily);
  const terminalFontSizeRef = useRef(terminalFontSize);
  terminalFontFamilyRef.current = terminalFontFamily;
  terminalFontSizeRef.current = terminalFontSize;
  // Keep the latest callbacks in refs so the main effect can depend only on
  // [channel, terminalId] and not tear down xterm when a parent re-renders.
  const onTitleChangeRef = useRef(onTitleChange);
  const onExitRef = useRef(onExit);
  const onCommandSubmittedRef = useRef(onCommandSubmitted);
  onTitleChangeRef.current = onTitleChange;
  onExitRef.current = onExit;
  onCommandSubmittedRef.current = onCommandSubmitted;
  // Drive a re-theme (without tearing down xterm) when the mode or VS Code theme
  // changes; these come from the same ThemeProvider that paints the rest of the UI.
  const resolvedTheme = useResolvedTheme();
  const activeVSCodeThemeId = useActiveVSCodeThemeId();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let disposed = false;
    let cleanupResizeObserver: (() => void) | null = null;
    let offData: (() => void) | undefined;
    let offTitle: (() => void) | undefined;
    let offExit: (() => void) | undefined;
    const disposers: Array<() => void> = [];

    const start = () => {
      if (disposed) return;

      const t = new Terminal({
        fontFamily: resolveTerminalFontFamily(host, terminalFontFamilyRef.current),
        fontSize: terminalFontSizeRef.current,
        lineHeight: 1.2,
        cursorBlink: true,
        theme: buildTerminalTheme(host),
        allowProposedApi: true,
        scrollback: 5000,
      });
      termRef.current = t;
      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      t.loadAddon(fitAddon);
      t.open(host);
      let selectionAnchor: CellPos | null = null;
      let selectionHead: CellPos | null = null;
      const syncKeyboardSelectionCache = () => {
        if (
          !keyboardSelectionMatchesExisting(
            selectionAnchor,
            selectionHead,
            readExistingSelection(t),
            t.cols
          )
        ) {
          selectionAnchor = null;
          selectionHead = null;
        }
      };
      t.attachCustomKeyEventHandler((event) => {
        // xterm sends unmatched chords to the PTY. Without this, Ctrl+V on
        // Windows becomes \x16, and Shift+arrows become CSI sequences instead
        // of buffer selection (Windows console / VS Code behavior).
        if (isCopyShortcut(event, t.hasSelection())) {
          event.preventDefault();
          event.stopPropagation();
          channel.writeClipboardText(t.getSelection());
          return false;
        }
        if (isPasteShortcut(event)) {
          event.preventDefault();
          event.stopPropagation();
          void Promise.resolve(channel.readClipboardText()).then((text) => {
            if (text) t.paste(text);
          });
          return false;
        }
        if (isKeyboardSelectionShortcut(event) && isKeyboardSelectionKey(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          syncKeyboardSelectionCache();
          const next = applyKeyboardSelection({
            key: event.key,
            cols: t.cols,
            lineCount: t.buffer.active.length,
            cursor: {
              x: t.buffer.active.cursorX,
              y: t.buffer.active.baseY + t.buffer.active.cursorY,
            },
            anchor: selectionAnchor,
            head: selectionHead,
            existing: readExistingSelection(t),
            unit: selectionUnitForEvent(event),
            readLine: (y) => t.buffer.active.getLine(y)?.translateToString(false) ?? '',
          });
          selectionAnchor = next.anchor;
          selectionHead = next.head;
          if (next.length === 0) t.clearSelection();
          else t.select(next.start.x, next.start.y, next.length);
          return false;
        }
        if (event.type === 'keydown' && event.key !== 'Shift') {
          selectionAnchor = null;
          selectionHead = null;
        }
        return true;
      });

      const safeFit = () => {
        try {
          fitAddon.fit();
        } catch {
          // container not laid out yet (e.g. hidden) — ignore
        }
      };
      safeFit();

      let replayWrites = 0;
      disposers.push(
        t.onData((data) => {
          if (replayWrites > 0) return;
          channel.input(terminalId, data);
          for (const char of data) {
            if (char === '\r') onCommandSubmittedRef.current?.();
          }
        }).dispose
      );
      disposers.push(
        t.onResize(({ cols, rows }) => channel.resize(terminalId, cols, rows)).dispose
      );
      disposers.push(t.onTitleChange((title) => onTitleChangeRef.current?.(title)).dispose);
      disposers.push(t.onSelectionChange(syncKeyboardSelectionCache).dispose);

      offData = channel.onData((event) => {
        if (event.terminalId !== terminalId) return;
        if (!event.replay) {
          t.write(event.data);
          return;
        }
        replayWrites += 1;
        t.write(event.data, () => {
          replayWrites = Math.max(0, replayWrites - 1);
        });
      });
      offTitle = channel.onTitle((event) => {
        if (event.terminalId === terminalId) onTitleChangeRef.current?.(event.title);
      });
      offExit = channel.onExit((event) => {
        if (event.terminalId === terminalId) onExitRef.current?.(event.exitCode);
      });

      cleanupResizeObserver = observeResizeOnAnimationFrame(host, () => {
        safeFit();
      });

      // Attach after the first fit so the daemon gets accurate dimensions.
      channel.attach(terminalId, t.cols, t.rows);
      t.focus();
    };

    // The terminal font stack includes self-hosted JetBrains Mono (@fontsource). If
    // xterm measures the cell size before that web font loads (cold start on a
    // platform without SF Mono), its initial fit can report the wrong cols/rows to
    // the PTY. Wait for the selected face and bundled fallback, then open. Feature-
    // detected + fail-open so environments without the Font Loading API still open.
    const prepareAndStart = async () => {
      const fontFamily = terminalFontFamilyRef.current;
      const fontSize = terminalFontSizeRef.current;
      await waitForTerminalFont(fontFamily, fontSize);
      if (disposed) return;
      if (
        fontFamily !== terminalFontFamilyRef.current ||
        fontSize !== terminalFontSizeRef.current
      ) {
        void prepareAndStart();
        return;
      }
      start();
    };
    void prepareAndStart();

    return () => {
      disposed = true;
      cleanupResizeObserver?.();
      offData?.();
      offTitle?.();
      offExit?.();
      for (const dispose of disposers) dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [channel, terminalId]);

  useEffect(() => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return undefined;

    let cancelled = false;
    const fontReady = waitForTerminalFont(terminalFontFamily, terminalFontSize);

    void fontReady.then(() => {
      if (cancelled || termRef.current !== term) return;
      term.options.fontFamily = resolveTerminalFontFamily(host, terminalFontFamily);
      term.options.fontSize = terminalFontSize;
      requestAnimationFrame(() => {
        if (!cancelled && termRef.current === term) {
          try {
            fitAddonRef.current?.fit();
          } catch {
            // The dock can be hidden while a preference changes.
          }
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [terminalFontFamily, terminalFontSize]);

  // Re-theme in place when the resolved mode or active VS Code theme changes. The
  // ThemeProvider applies the new --terminal-*/--vscode-* values in a layout effect,
  // which runs before this passive effect, so the re-read sees the updated tokens.
  useEffect(() => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;
    term.options.theme = buildTerminalTheme(host);
  }, [resolvedTheme, activeVSCodeThemeId]);

  const copySelection = () => {
    const term = termRef.current;
    if (term?.hasSelection() !== true) return;
    channel.writeClipboardText(term.getSelection());
    queueMicrotask(() => term.focus());
  };

  const pasteClipboard = () => {
    const term = termRef.current;
    if (!term) return;
    void Promise.resolve(channel.readClipboardText()).then((text) => {
      if (text) term.paste(text);
      queueMicrotask(() => term.focus());
    });
  };

  const handleWindowsRightClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!windowsRightClick) return;
    event.preventDefault();
    event.stopPropagation();
    const term = termRef.current;
    if (!term) return;
    if (term.hasSelection()) {
      channel.writeClipboardText(term.getSelection());
      term.clearSelection();
      return;
    }
    void Promise.resolve(channel.readClipboardText()).then((text) => {
      if (text) term.paste(text);
    });
  };

  const host = (
    <div
      ref={hostRef}
      className={cn('lody-terminal-panel h-full w-full overflow-hidden', className)}
      onContextMenu={windowsRightClick ? handleWindowsRightClick : undefined}
    />
  );

  if (windowsRightClick) return host;

  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) setHasSelection(termRef.current?.hasSelection() ?? false);
      }}
    >
      <ContextMenu.Trigger >{host}</ContextMenu.Trigger>
      <ContextMenu.Content className="min-w-40">
        <ContextMenu.Item
          disabled={!hasSelection}
          onClick={copySelection}
          shortcut={copyShortcutLabel}
        >
          {translate('common.copy', 'Copy')}
        </ContextMenu.Item>
        <ContextMenu.Item onClick={pasteClipboard} shortcut={pasteShortcutLabel}>
          {translate('common.paste', 'Paste')}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
