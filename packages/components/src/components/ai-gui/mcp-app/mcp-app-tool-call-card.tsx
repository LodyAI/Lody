import { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { ChevronRight, Maximize2 } from 'lucide-react';
import type { McpAppToolCall, MessageContent } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Collapsible } from '@lody/ui/collapsible';
import { Dialog } from '@lody/ui/dialog';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { collectClientBuildInfo } from '@/lib/client-build-info';
import { openExternalUrl } from '@/lib/native-browser';
import { useResolvedTheme } from '../../../theme-provider';
import { SessionReadonlyContext } from '../session-readonly-context';
import {
  createMcpAppBridge,
  type McpAppBridge,
  type McpAppContainerDimensions,
  type McpAppDisplayMode,
} from './mcp-app-bridge';
import { buildMcpAppDocument, selectMcpAppHtml } from './mcp-app-document';
import {
  humanizeMcpServerName,
  McpAppHostContext,
  type McpAppHost,
  type McpAppLoadResult,
} from './mcp-app-host';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

const INLINE_MIN_HEIGHT = 120;
const INLINE_MAX_HEIGHT = 900;
const INLINE_DEFAULT_HEIGHT = 320;
const FRAME_PERMISSIONS =
  "accelerometer 'none'; autoplay 'none'; camera 'none'; clipboard-read 'none'; " +
  "clipboard-write 'none'; display-capture 'none'; encrypted-media 'none'; " +
  "fullscreen 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; midi 'none'";

/** The conversation's shared text rail (`ai-gui/AGENTS.md`): the title and the app surface start on it. */
const RAIL_INSET = '4px';

const styles = stylex.create({
  card: { minWidth: 0, paddingBlock: space[1] },
  header: { display: 'flex', minWidth: 0, alignItems: 'center', gap: space[1] },
  trigger: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: space[2],
    paddingInline: RAIL_INSET,
    paddingBlock: '2px',
    border: 'none',
    backgroundColor: 'transparent',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
  },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // The activity-group disclosure chevron (`view.tsx` `ProcessDisclosureButton`).
  chevron: {
    flexShrink: 0,
    width: '1em',
    height: '1em',
    color: colors.secondaryLabel,
    // Desktop disclosure chevrons appear only with the pointer or keyboard focus.
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus-within')]: 1,
    },
    transitionProperty: 'transform, opacity',
    transitionDuration: '200ms',
    transitionTimingFunction: 'ease-out',
  },
  chevronOpen: { transform: 'rotate(90deg)' },
  surface: {
    marginTop: space[1],
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: 'hsl(var(--composer))',
    boxShadow: shadow.card,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  frameSurface: { marginInline: RAIL_INSET },
  placeholder: { paddingInline: space[3], paddingBlock: space[2], color: colors.tertiaryLabel },
  frame: { display: 'block', width: '100%', border: 'none', backgroundColor: 'white' },
  fullscreenSlot: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
});

type LoadState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | ({ status: 'ready'; documentHtml: string } & McpAppLoadResult);

/**
 * The frame fills its slot's width in both modes; inline height follows the
 * app's reported size up to a cap, while full screen fixes it to the dialog.
 */
const measureContainer = (
  slot: HTMLElement,
  mode: McpAppDisplayMode
): McpAppContainerDimensions => {
  const rect = slot.getBoundingClientRect();
  const width = Math.round(rect.width);
  return mode === 'fullscreen'
    ? { width, height: Math.round(rect.height) }
    : { width, maxHeight: INLINE_MAX_HEIGHT };
};

/** Moving keeps the app's browsing context; a plain re-append reloads it (the bridge re-handshakes). */
const placeFrame = (parent: HTMLElement, iframe: HTMLIFrameElement) => {
  if (iframe.parentElement === parent) return;
  const movable = parent as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
  if (iframe.isConnected && typeof movable.moveBefore === 'function') {
    try {
      movable.moveBefore(iframe, null);
      return;
    } catch {
      // Fall through to a reloading append.
    }
  }
  parent.appendChild(iframe);
};

function McpAppFrame({
  host,
  toolCallId,
  app,
  name,
  displayMode,
  onDisplayModeChange,
  onReadyChange,
}: {
  host: McpAppHost;
  toolCallId: string;
  app: McpAppToolCall;
  name: string;
  displayMode: McpAppDisplayMode;
  onDisplayModeChange: (mode: McpAppDisplayMode) => void;
  /** Whether the app is running in this frame, i.e. whether full screen has anything to show. */
  onReadyChange: (ready: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useResolvedTheme();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [height, setHeight] = useState(INLINE_DEFAULT_HEIGHT);
  const inlineSlotRef = useRef<HTMLDivElement>(null);
  const [fullscreenSlot, setFullscreenSlot] = useState<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<McpAppBridge | null>(null);
  const contextRef = useRef({ theme, locale: i18n.language });
  contextRef.current = { theme, locale: i18n.language };
  // The bridge outlives renders; recreating it for a new callback would reload the app.
  const onDisplayModeChangeRef = useRef(onDisplayModeChange);
  onDisplayModeChangeRef.current = onDisplayModeChange;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const loaded = await host.load(toolCallId);
        const resource = await host.readResource(toolCallId, app.resourceUri);
        const selected = selectMcpAppHtml(resource.contents);
        if (!selected) throw new Error('The app resource has no HTML document');
        const documentHtml = buildMcpAppDocument(selected.html, selected.csp);
        if (!cancelled) setState({ status: 'ready', documentHtml, ...loaded });
      } catch {
        if (!cancelled) setState({ status: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, toolCallId, app.resourceUri]);

  useLayoutEffect(() => {
    const slot = inlineSlotRef.current;
    if (state.status !== 'ready' || !slot) return undefined;
    const iframe = document.createElement('iframe');
    // Opaque origin: no forms, popups, top navigation or preload, and no browser storage;
    // the proxy gives each load in-memory Web Storage and cookies instead. Never add
    // `allow-same-origin`: that persists storage in the default session (see the proxy).
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('credentialless', '');
    iframe.setAttribute('allow', FRAME_PERMISSIONS);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.title = name;
    iframe.setAttribute('data-testid', 'mcp-app-frame');
    iframe.className = stylex.props(styles.frame).className ?? '';
    iframe.src = host.sandboxUrl;
    iframeRef.current = iframe;
    slot.appendChild(iframe);
    const bridge = createMcpAppBridge({
      listenTarget: window,
      frame: () => iframe.contentWindow,
      documentHtml: state.documentHtml,
      toolInput: state.toolInput,
      toolResult: state.toolResult,
      hostVersion: collectClientBuildInfo().appVersion ?? '0.0.0',
      hostContext: {
        ...contextRef.current,
        displayMode: 'inline',
        containerDimensions: measureContainer(slot, 'inline'),
      },
      handlers: {
        readResource: (uri) => host.readResource(toolCallId, uri),
        callTool: (toolName, args) => host.callTool(toolCallId, toolName, args),
        openLink: (url) => void openExternalUrl(url),
        requestDisplayMode: (mode) => {
          onDisplayModeChangeRef.current(mode);
          return mode;
        },
        sizeChanged: ({ height: next }) => {
          if (next === undefined) return;
          setHeight(Math.min(INLINE_MAX_HEIGHT, Math.max(INLINE_MIN_HEIGHT, Math.ceil(next))));
        },
      },
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.teardown('unmount');
      iframe.remove();
      iframeRef.current = null;
      bridgeRef.current = null;
    };
  }, [state, host, toolCallId, name]);

  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    const target = displayMode === 'fullscreen' ? fullscreenSlot : inlineSlotRef.current;
    if (!iframe || !target) return;
    placeFrame(target, iframe);
    iframe.style.height = displayMode === 'fullscreen' ? '100%' : `${height}px`;
    iframe.style.flex = displayMode === 'fullscreen' ? '1' : '';
  }, [state, displayMode, fullscreenSlot, height]);

  // Mode and dimensions change together, so the app never sees a mode with the other mode's size.
  useLayoutEffect(() => {
    const bridge = bridgeRef.current;
    const slot = displayMode === 'fullscreen' ? fullscreenSlot : inlineSlotRef.current;
    if (!bridge || !slot) return undefined;
    const report = () =>
      bridge.updateHostContext({
        displayMode,
        containerDimensions: measureContainer(slot, displayMode),
      });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [state, host, toolCallId, name, displayMode, fullscreenSlot]);

  const ready = state.status === 'ready';
  useEffect(() => {
    if (!ready) return undefined;
    onReadyChange(true);
    return () => onReadyChange(false);
  }, [ready, onReadyChange]);

  useEffect(() => bridgeRef.current?.updateHostContext({ theme }), [theme]);

  if (state.status === 'unavailable') {
    return <McpAppUnavailable />;
  }
  return (
    <>
      <div {...stylex.props(styles.surface, styles.frameSurface)}>
        {state.status === 'loading' ? (
          <div {...stylex.props(styles.placeholder)}>
            <Spinner size="small" />
          </div>
        ) : null}
        <div ref={inlineSlotRef} />
      </div>
      <Dialog.Root
        open={displayMode === 'fullscreen'}
        onOpenChange={(open) => {
          if (!open) onDisplayModeChange('inline');
        }}
      >
        <Dialog.Content
          width="96vw"
          style={{ height: '92vh', display: 'flex', flexDirection: 'column' }}
          closeLabel={t('sessions.mcpApp.exitFullscreen', 'Exit full screen')}
        >
          <Dialog.Title>{name}</Dialog.Title>
          <div ref={setFullscreenSlot} {...stylex.props(styles.fullscreenSlot)} />
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

function McpAppUnavailable() {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.surface, styles.placeholder)}>
      {t('sessions.mcpApp.unavailable', 'App unavailable')}
    </div>
  );
}

/**
 * "Opened <app>": a tool call whose tool declares an MCP Apps UI. The app loads
 * only once the call completed, from the live agent, and never in read-only
 * replay, which has no agent to answer the app.
 */
export const McpAppToolCallCard = memo(function McpAppToolCallCard({
  toolCall,
  app,
}: {
  toolCall: ToolCallMessage;
  app: McpAppToolCall;
}) {
  const { t } = useTranslation();
  const host = useContext(McpAppHostContext);
  const readonly = useContext(SessionReadonlyContext);
  const [open, setOpen] = useState(true);
  const [displayMode, setDisplayMode] = useState<McpAppDisplayMode>('inline');
  const [frameReady, setFrameReady] = useState(false);
  const name = app.appName ?? humanizeMcpServerName(app.server);
  const isRunning = toolCall.status === 'pending' || toolCall.status === 'in_progress';
  const handleFrameReady = useCallback((ready: boolean) => {
    setFrameReady(ready);
    // A frame that left the page cannot still be full screen when it returns.
    if (!ready) setDisplayMode('inline');
  }, []);

  return (
    <div data-testid="mcp-app-tool-call" {...stylex.props(styles.card)}>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div {...stylex.props(stylex.defaultMarker(), styles.header)}>
          <Collapsible.Trigger {...stylex.props(styles.trigger)}>
            <span {...stylex.props(styles.title)}>
              {t('sessions.mcpApp.opened', 'Opened {{name}}', { name })}
            </span>
            {isRunning ? (
              <Spinner size="small" />
            ) : (
              <ChevronRight
                aria-hidden
                {...stylex.props(styles.chevron, open && styles.chevronOpen)}
              />
            )}
          </Collapsible.Trigger>
          {!isRunning && open && frameReady ? (
            <Button
              variant="ghost"
              size="mini"
              icon
              aria-label={t('sessions.mcpApp.enterFullscreen', 'Open full screen')}
              onClick={() => setDisplayMode('fullscreen')}
            >
              <Maximize2 />
            </Button>
          ) : null}
        </div>
        {isRunning ? null : (
          <Collapsible.Panel>
            {host && !readonly ? (
              <McpAppFrame
                host={host}
                toolCallId={toolCall.toolCallId}
                app={app}
                name={name}
                displayMode={displayMode}
                onDisplayModeChange={setDisplayMode}
                onReadyChange={handleFrameReady}
              />
            ) : (
              <McpAppUnavailable />
            )}
          </Collapsible.Panel>
        )}
      </Collapsible.Root>
    </div>
  );
});
