'use client';

/**
 * The landing's product stage: a DISPLAY-ONLY replica of the Lody app driven by
 * scripted "ghost user" demos (one per feature tab). Every component comes from
 * `landing-replica/` and takes demo data as props — nothing here imports the app,
 * so app refactors cannot break the public landing. The frame is `inert`, so only
 * the states these scripts reach need to exist.
 */

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type LandingDemo, WORKTREE_DEMO_DURATION_MS } from './landing-demo-durations';
import type { LandingLocale } from './landing';
import { LandingMobilePreview, type MobileDemoScreen } from './landing-mobile-preview';
import {
  INITIAL_LANDING_PREVIEW_STATE,
  LandingPreviewPanel,
  type LandingPreviewDemoState,
} from './landing-preview-panel';
import {
  buildDemoIntroHistory,
  buildDemoTask,
  buildDesignAnnotation,
  buildDesignDemoHistory,
  buildJellyfishHistory,
  buildLocalSession,
  buildLodyPrHistory,
  buildTasks,
  DEMO_COPY,
  DEMO_PROJECT_NAME,
  DEMO_TASK_ID,
  DESIGN_DEMO_COPY,
  DIFF_DEMO_TASK_ID,
  GITHUB_OWNER_AVATAR,
  GITHUB_REPO,
  INITIAL_DESIGN_TURNS,
  JELLYFISH_TASK_ID,
  MOCK_CHANGE_FILES,
  PREVIEW_COPY,
  WORKSPACE_LOGO,
  type DesignDemoTurns,
} from './landing-preview-data';
import {
  ReplicaChangesList,
  ReplicaDiffSkeleton,
  ReplicaDiffViewer,
} from './landing-replica/changes';
import { ConversationColumn, ReplicaChatStream } from './landing-replica/chat-stream';
import {
  ReplicaBranchWorktreePill,
  ReplicaChatLandingView,
  ReplicaComposer,
  ReplicaMachineMenuTrigger,
  ReplicaMobileRunConfigTrigger,
  ReplicaPermissionModeTrigger,
  ReplicaProjectSelectorTrigger,
  ReplicaRunConfigTrigger,
  ReplicaSendButton,
} from './landing-replica/composer';
import {
  MOBILE_NEW_CHAT_LABEL,
  MOBILE_SESSION_HEADER_INSET,
  ReplicaMobileSessionHeader,
  ReplicaMobileSheetFooterPickers,
  type ReplicaMobileChat,
} from './landing-replica/mobile';
import {
  ReplicaPanelToggle,
  ReplicaSessionInfoBar,
  ReplicaSessionLayout,
  ReplicaSessionTabBar,
  ReplicaSessionToolbar,
  ReplicaSidePanelTabBar,
  type ReplicaSidePanelTab,
} from './landing-replica/session-shell';
import { ReplicaSidebar } from './landing-replica/sidebar';
import type { ReplicaChatUser, ReplicaMessage, ReplicaSessionRow } from './landing-replica/types';
import { cn } from './landing-replica/utils';

/* Heavy images the LATER feature tabs need. Warm them on idle after the preview
   mounts so the phone frame does not materialise piece by piece, without
   competing with the WebGL scene's first paint. */
const DEMO_IMAGE_WARMUP = [
  '/landing/iphone-17-pro-silver.webp',
  '/landing/jellyfish.webp',
  WORKSPACE_LOGO,
];

function warmDemoImages(): () => void {
  const images: HTMLImageElement[] = [];
  const run = () => {
    for (const src of DEMO_IMAGE_WARMUP) {
      const image = new Image();
      image.src = src;
      void image.decode?.().catch(() => undefined);
      images.push(image);
    }
  };
  // Safari only shipped requestIdleCallback recently; fall back to a timeout.
  const hasIdle = typeof window.requestIdleCallback === 'function';
  const handle = hasIdle
    ? window.requestIdleCallback(run, { timeout: 4000 })
    : window.setTimeout(run, 1200);
  return () => {
    if (hasIdle) window.cancelIdleCallback(handle);
    else window.clearTimeout(handle);
    for (const image of images) image.src = '';
  };
}

const CHAT_USER: ReplicaChatUser = {
  name: 'You',
  avatarUrl: 'https://avatars.githubusercontent.com/u/30241095?v=4&size=64',
};

/* The info bar's Browser chip and the browser toolbar's annotate toggle keep
   English aria-labels in both locales, so the scripts aim at one selector. */
const PREVIEW_ACTION_SELECTOR = 'button[aria-label="Browser"]';
const ANNOTATE_ACTION_SELECTOR = 'button[aria-label="Annotate page"]';
// Brief flash only — a long skeleton made the tab read as "diff never loaded".
const DIFF_SKELETON_MS = 90;

// ---- Ghost-cursor plumbing ------------------------------------------------------

/** Module gate read by clickQuiet / drag helpers without prop-drilling timers. */
const ghostGateRef = { current: true };

/**
 * While ghost demos run, swallow programmatic scrollIntoView and force
 * preventScroll on focus. User wheel/touch scroll is unaffected — only the
 * APIs that pull the viewport to a focused/clicked node are blocked.
 */
function installDemoScrollGuards(): () => void {
  const proto = Element.prototype;
  const origScrollIntoView = proto.scrollIntoView;
  proto.scrollIntoView = function scrollIntoViewNoop(this: Element) {
    // no-op: ghost clicks must not yank the landing page
  };

  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focusNoScroll(
    this: HTMLElement,
    options?: FocusOptions | boolean
  ) {
    if (typeof options === 'boolean') {
      return origFocus.call(this, { preventScroll: true });
    }
    return origFocus.call(this, { ...options, preventScroll: true });
  };

  return () => {
    proto.scrollIntoView = origScrollIntoView;
    HTMLElement.prototype.focus = origFocus;
  };
}

/**
 * Ghost demos never call real focus()/click() — browsers scroll focused nodes
 * into view and that yanks the landing page mid-scroll. Synthetic pointer +
 * MouseEvent only; the state `action` is what actually advances the demo.
 */
function clickQuiet(el: HTMLElement | null, action?: () => void) {
  if (!ghostGateRef.current) {
    // Off-stage: apply state only, no DOM pointer work.
    action?.();
    return;
  }
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  try {
    if (el) {
      const init: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      el.dispatchEvent(new PointerEvent('pointerup', init));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  } catch {
    // demo theater — state fallbacks keep the flow going
  }
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
    window.scrollTo(scrollX, scrollY);
  }
  action?.();
}

/** Ghost-composer typing: snappy so the feature, not keystrokes, is the point. */
const DEMO_TYPE_MS_EN = 20;
const DEMO_TYPE_MS_ZH = 30;
/** Long prompts type a few chars per tick so walls of text don't eat the budget. */
function demoTypeChunk(textLength: number): number {
  if (textLength > 48) return 3;
  if (textLength > 22) return 2;
  return 1;
}
function demoTypeStepMs(locale: LandingLocale, textLength: number): number {
  const base = locale === 'zh' ? DEMO_TYPE_MS_ZH : DEMO_TYPE_MS_EN;
  return textLength > 40 ? Math.max(14, base - 4) : base;
}
/** Schedule progressive text into `apply(slice)`. Returns the end timestamp (ms). */
function scheduleTypedText(
  at: (ms: number, fn: () => void) => void,
  startMs: number,
  text: string,
  locale: LandingLocale,
  apply: (slice: string) => void
): number {
  const step = demoTypeStepMs(locale, text.length);
  const chunk = demoTypeChunk(text.length);
  let i = 0;
  let tick = 0;
  while (i < text.length) {
    i = Math.min(text.length, i + chunk);
    const end = i;
    at(startMs + tick * step, () => apply(text.slice(0, end)));
    tick += 1;
  }
  return startMs + Math.max(1, tick) * step;
}

/** Visible node matching `selector` (and `text`), shell first, then body portals. */
function findTarget(
  shell: HTMLElement | null,
  selector: string,
  text?: string
): HTMLElement | null {
  const scopes: ParentNode[] = shell ? [shell, document] : [document];
  for (const scope of scopes) {
    const nodes = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(
      (node) => node.getBoundingClientRect().width > 0
    );
    const match = text ? nodes.find((node) => (node.textContent ?? '').includes(text)) : nodes[0];
    if (match) return match;
  }
  return null;
}

/** Smallest visible element in the shell whose text contains `text`. */
function findByText(shell: HTMLElement | null, text: string): HTMLElement | null {
  if (!shell) return null;
  const nodes = Array.from(shell.querySelectorAll<HTMLElement>('*')).filter(
    (el) => (el.textContent ?? '').includes(text) && el.getBoundingClientRect().width > 0
  );
  nodes.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
  return nodes[0] ?? null;
}

/**
 * Drag the layout's resize handle left: `pointerdown` on the handle, then
 * `pointermove`/`pointerup` on `document.body`, which the replica layout
 * listens for on `window`.
 */
function dragHandleLeft(
  shell: HTMLElement | null,
  totalDx: number,
  steps: number,
  stepMs: number,
  schedule: (ms: number, fn: () => void) => void,
  isCancelled: () => boolean,
  onMove: (handle: HTMLElement, pulse: boolean) => void
) {
  if (!ghostGateRef.current) return;
  const handle = findTarget(shell, '[data-slot="resizable-handle"]');
  if (!handle) return;
  const rect = handle.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  let x = rect.left + rect.width / 2;
  const init = (buttons: number): PointerEventInit => ({
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
  });
  onMove(handle, true);
  handle.dispatchEvent(new PointerEvent('pointerdown', init(1)));
  const dx = totalDx / steps;
  for (let i = 1; i <= steps; i++) {
    schedule(i * stepMs, () => {
      if (isCancelled() || !ghostGateRef.current) {
        // Abort mid-drag cleanly so we never leave a dangling drag.
        document.body.dispatchEvent(new PointerEvent('pointerup', init(0)));
        return;
      }
      x += dx;
      document.body.dispatchEvent(new PointerEvent('pointermove', init(1)));
      onMove(handle, false);
      if (i === steps) document.body.dispatchEvent(new PointerEvent('pointerup', init(0)));
    });
  }
}

/** Per-activation timeline: `at` schedules unless the activation was torn down. */
function createTimeline() {
  const flag = { cancelled: false };
  const timers: number[] = [];
  const intervals: number[] = [];
  const at = (ms: number, fn: () => void) => {
    timers.push(
      window.setTimeout(() => {
        if (!flag.cancelled) fn();
      }, ms)
    );
  };
  /** Reveal `target` in `ticks` of `tickMs`, calling `apply(slice, done)`. */
  const stream = (
    target: string,
    durationMs: number,
    tickMs: number,
    minChunk: number,
    apply: (slice: string, done: boolean) => void
  ) => {
    const ticks = Math.max(1, Math.floor(durationMs / tickMs));
    const perTick = Math.max(minChunk, Math.ceil(target.length / ticks));
    let offset = 0;
    const id = window.setInterval(() => {
      if (flag.cancelled) {
        window.clearInterval(id);
        return;
      }
      offset = Math.min(target.length, offset + perTick);
      const done = offset >= target.length;
      apply(target.slice(0, offset), done);
      if (done) window.clearInterval(id);
    }, tickMs);
    intervals.push(id);
  };
  const cancel = () => {
    flag.cancelled = true;
    timers.forEach((id) => window.clearTimeout(id));
    intervals.forEach((id) => window.clearInterval(id));
  };
  return { at, stream, cancel, isCancelled: () => flag.cancelled };
}

type CursorState = {
  x: number;
  y: number;
  visible: boolean;
  pulse: number;
  /** Skip the glide for tiny corrections so they don't look like a second hop. */
  instant?: boolean;
};

const CURSOR_HIDDEN: CursorState = { x: 0, y: 0, visible: false, pulse: 0 };

// ---- Session surfaces --------------------------------------------------------------

type DiffDemoState = {
  panelOpen: boolean;
  viewer: 'hidden' | 'skeleton' | 'shown';
};

type DesignDemoState = {
  previewAvailable: boolean;
  previewOpen: boolean;
  preview: LandingPreviewDemoState;
};

/** The desktop session: tab row, conversation + info bar + composer, right panel. */
function DesktopSession({
  locale,
  task,
  messages,
  composer,
  dark,
  diffDemo,
  designDemo,
  onOpenDiffFile,
}: {
  locale: LandingLocale;
  task: ReplicaSessionRow;
  messages: ReplicaMessage[];
  composer: React.ReactNode;
  dark: boolean;
  diffDemo: DiffDemoState | null;
  designDemo: DesignDemoState | null;
  onOpenDiffFile: () => void;
}) {
  const t = PREVIEW_COPY[locale];
  const isLocalSession = task.id.startsWith('local-');
  const hasChanges = Boolean(task.repoFullName && (task.addedLines || task.deletedLines));
  // Production opens a session with the right panel CLOSED; only demos open it.
  const panelOpen = designDemo ? designDemo.previewOpen : Boolean(diffDemo?.panelOpen);
  const viewer = diffDemo?.viewer ?? 'hidden';
  const pr = task.prNumber ? { number: task.prNumber, status: task.prStatus ?? 'open' } : null;
  const diffStat = {
    add: MOCK_CHANGE_FILES.reduce((sum, file) => sum + file.add, 0),
    del: MOCK_CHANGE_FILES.reduce((sum, file) => sum + file.del, 0),
  };
  const actions = !hasChanges
    ? []
    : pr
      ? [{ id: 'commit-and-push', label: t.commitAndPush }]
      : [
          { id: 'create-pr', label: t.createPr },
          { id: 'commit-and-push', label: t.commitAndPush },
        ];

  const activeTab = designDemo ? 'browser' : viewer !== 'hidden' ? 'diff:all-changes' : 'changes';
  const panelTabs: ReplicaSidePanelTab[] = [
    { id: 'files', label: t.files, kind: 'files' },
    { id: 'changes', label: t.allChanges, kind: 'changes' },
    ...(pr ? [{ id: 'pr', label: 'PR', kind: 'pr' as const }] : []),
    ...(designDemo?.previewAvailable
      ? [{ id: 'browser', label: t.browser, kind: 'browser' as const }]
      : []),
    ...(viewer !== 'hidden'
      ? [
          {
            id: 'diff:all-changes',
            label: t.allChanges,
            kind: 'diff' as const,
            closeable: true,
          },
        ]
      : []),
  ];
  const panelBody =
    activeTab === 'browser' && designDemo ? (
      <LandingPreviewPanel state={designDemo.preview} />
    ) : viewer === 'skeleton' ? (
      <ReplicaDiffSkeleton />
    ) : viewer === 'shown' ? (
      <div className="h-full space-y-3 overflow-y-auto bg-background p-3">
        {MOCK_CHANGE_FILES.map((file) => (
          <ReplicaDiffViewer key={file.path} file={file} dark={dark} />
        ))}
      </div>
    ) : (
      <ReplicaChangesList
        files={hasChanges ? MOCK_CHANGE_FILES : []}
        locale={locale}
        onOpenFile={onOpenDiffFile}
      />
    );

  return (
    <ReplicaSessionLayout
      topBar={
        <ReplicaSessionTabBar
          tabs={[{ id: task.id, title: task.title, agent: 'codex' }]}
          activeTabId={task.id}
          rightSlot={<ReplicaSessionToolbar locale={locale} panelOpen={panelOpen} />}
          locale={locale}
        />
      }
      chat={
        <div className="flex h-full min-h-0 flex-col bg-background">
          <div className="min-h-0 flex-1">
            <ReplicaChatStream
              messages={messages}
              user={CHAT_USER}
              variant="desktop"
              locale={locale}
            />
          </div>
          <ReplicaSessionInfoBar
            projectName={task.repoFullName ?? task.title}
            projectKind={isLocalSession ? 'local' : task.repoFullName ? 'github' : 'chat'}
            branch={task.branchName || null}
            worktree={isLocalSession}
            pr={pr}
            diffStat={hasChanges ? diffStat : null}
            actions={actions}
            showBrowserAction={Boolean(designDemo?.previewAvailable)}
            locale={locale}
            variant="desktop"
          />
          <div className="relative shrink-0 bg-background pb-3 pt-0">
            <ConversationColumn>{composer}</ConversationColumn>
          </div>
        </div>
      }
      panel={
        <>
          <ReplicaSidePanelTabBar
            tabs={panelTabs}
            activeTabId={activeTab}
            endSlot={<ReplicaPanelToggle locale={locale} panelOpen />}
            locale={locale}
          />
          <div className="min-h-0 flex-1 overflow-hidden">{panelBody}</div>
        </>
      }
      panelOpen={panelOpen}
      defaultPanelPercent={viewer !== 'hidden' ? 40 : 25}
    />
  );
}

/** The phone session: floating frosted header over the conversation. */
function MobileSession({
  locale,
  task,
  messages,
  composer,
}: {
  locale: LandingLocale;
  task: ReplicaSessionRow;
  messages: ReplicaMessage[];
  composer: React.ReactNode;
}) {
  const isLocalSession = task.id.startsWith('local-');
  const isPlainChat = !task.repoFullName;
  const pr = task.prNumber ? { number: task.prNumber, status: task.prStatus ?? 'open' } : null;
  return (
    <div
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
      style={{ '--conversation-top-inset': MOBILE_SESSION_HEADER_INSET } as CSSProperties}
    >
      <ReplicaMobileSessionHeader
        title={task.title}
        projectLabel={isPlainChat ? null : task.repoFullName}
        projectKind={isPlainChat ? null : isLocalSession ? 'local' : 'github'}
        locale={locale}
      />
      <div className="min-h-0 flex-1">
        <ReplicaChatStream messages={messages} user={CHAT_USER} variant="mobile" locale={locale} />
      </div>
      <ReplicaSessionInfoBar
        projectName={isPlainChat ? null : task.repoFullName}
        projectKind={isPlainChat ? 'chat' : isLocalSession ? 'local' : 'github'}
        branch={null}
        worktree={isLocalSession}
        pr={pr}
        diffStat={null}
        actions={[]}
        showBrowserAction={false}
        locale={locale}
        variant="mobile"
      />
      {/* Home-indicator inset is simulated inside the device frame via
          `--landing-phone-safe-bottom`. No px-* here: ConversationColumn owns
          the gutter, so the composer lines up with the info bar. */}
      <div className="relative z-40 shrink-0 bg-background pb-[calc(0.5rem+var(--landing-phone-safe-bottom,34px))] pt-0">
        <ConversationColumn>{composer}</ConversationColumn>
      </div>
    </div>
  );
}

function toMobileChat(task: ReplicaSessionRow): ReplicaMobileChat {
  const isLocal = task.id.startsWith('local-');
  const isPlainChat = !task.repoFullName;
  return {
    id: task.id,
    title: task.title,
    prNumber: task.prNumber ?? null,
    prStatus: task.prStatus ?? null,
    addedLines: task.addedLines,
    deletedLines: task.deletedLines,
    isWorking: task.isWorking,
    isWaitingPermission: task.isWaitingPermission,
    hasUnreadMessages: task.hasUnreadMessages,
    // GitHub sessions are always worktrees; the worktree demo's local session
    // also shows the marker.
    isWorktree: !isPlainChat && (!isLocal || task.id === DEMO_TASK_ID),
  };
}

// ---- The stage -----------------------------------------------------------------------

export function LandingAppPreview({
  locale,
  demo = null,
  ghostEnabled = true,
}: {
  locale: LandingLocale;
  /** Scripted scenario for the active feature tab; null = static chat landing. */
  demo?: LandingDemo;
  /**
   * When false, ghost cursor clicks/drags are suppressed (stage mostly off-screen).
   * Demo state may still advance via fallbacks; the page scroll is never yanked.
   */
  ghostEnabled?: boolean;
}) {
  const t = PREVIEW_COPY[locale];
  const isWorktreeDemo = demo === 'worktree';
  const isDiffDemo = demo === 'diff';
  const isDesignDemo = demo === 'design';
  const isMobileDemo = demo === 'mobile';
  const isDemo = demo !== null;
  ghostGateRef.current = Boolean(ghostEnabled && isDemo);

  const [isMounted, setIsMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);
  // Boot on the chat landing — the frame tab-0's worktree demo opens on.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState('');
  const [worktreeChecked, setWorktreeChecked] = useState(false);
  const [demoTask, setDemoTask] = useState<ReplicaSessionRow | null>(null);
  const [demoStream, setDemoStream] = useState<{ text: string; done: boolean } | null>(null);
  const [cursor, setCursor] = useState<CursorState>(CURSOR_HIDDEN);
  const [diffDemo, setDiffDemo] = useState<DiffDemoState>({ panelOpen: false, viewer: 'hidden' });
  const [designTurns, setDesignTurns] = useState<DesignDemoTurns>(INITIAL_DESIGN_TURNS);
  const [designPreview, setDesignPreview] = useState<LandingPreviewDemoState>(
    INITIAL_LANDING_PREVIEW_STATE
  );
  const [designPreviewAvailable, setDesignPreviewAvailable] = useState(false);
  const [designPreviewOpen, setDesignPreviewOpen] = useState(false);
  // The saved preview comment is staged in the composer as a reference chip.
  const [designStagedRef, setDesignStagedRef] = useState(false);
  const [mobileScreen, setMobileScreen] = useState<MobileDemoScreen>('home');
  const [mobileTurn, setMobileTurn] = useState<{
    text: string;
    image: boolean;
    done: boolean;
  } | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const tasks = useMemo(() => buildTasks(locale), [locale]);
  const localSession = useMemo(() => buildLocalSession(locale), [locale]);
  const chatTasks = useMemo(() => tasks.filter((task) => !task.repoFullName), [tasks]);
  const githubTasks = useMemo(() => tasks.filter((task) => task.repoFullName), [tasks]);
  const selectedTask =
    [...(demoTask ? [demoTask] : []), ...tasks, localSession].find(
      (task) => task.id === selectedTaskId
    ) ?? null;

  // Opening a changed file reveals the viewer: a tiny skeleton, then the diff.
  const diffSkeletonTimer = useRef<number | null>(null);
  const openDiffFile = useCallback(() => {
    setDiffDemo((state) => ({ ...state, viewer: 'skeleton' }));
    if (diffSkeletonTimer.current) window.clearTimeout(diffSkeletonTimer.current);
    diffSkeletonTimer.current = window.setTimeout(() => {
      setDiffDemo((state) => ({ ...state, viewer: 'shown' }));
      diffSkeletonTimer.current = null;
    }, DIFF_SKELETON_MS);
  }, []);

  useEffect(() => {
    if (!isDemo) return undefined;
    return installDemoScrollGuards();
  }, [isDemo]);

  useEffect(() => {
    if (ghostEnabled) return;
    setCursor((c) => (c.visible ? { ...c, visible: false } : c));
  }, [ghostEnabled]);

  // Follow the site theme toggle (`.dark` on <html>) for the diff's highlighter;
  // everything else themes through `dark:` variants and the scoped tokens.
  useEffect(() => {
    setIsMounted(true);
    const root = document.documentElement;
    const sync = () => setIsDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    const cancelWarm = warmDemoImages();
    return () => {
      observer.disconnect();
      cancelWarm();
    };
  }, []);

  /** Glide the ghost cursor onto `el` using its live rect. */
  const moveCursorToEl = useCallback(
    (el: HTMLElement | null | undefined, opts?: { pulse?: boolean; visible?: boolean }) => {
      if (!ghostGateRef.current || !el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return;
      setCursor((c) => ({
        ...c,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        visible: opts?.visible ?? true,
        pulse: opts?.pulse ? c.pulse + 1 : c.pulse,
        instant: false,
      }));
    },
    []
  );

  // ---- Tab 1: worktree — pick Worktree, type, send, the reply streams in. ----
  useEffect(() => {
    if (!isWorktreeDemo || !isMounted) return undefined;
    const { at, stream, cancel } = createTimeline();
    const shell = shellRef.current;
    const d = DEMO_COPY[locale];
    const moveTo = (selector: string) => moveCursorToEl(findTarget(shell, selector));
    const clickTarget = (selector: string, action?: () => void) => {
      const el = findTarget(shell, selector);
      moveCursorToEl(el, { pulse: true });
      clickQuiet(el, action);
    };

    setSelectedTaskId(null);
    setWorktreeChecked(false);
    setPrompt('');
    setDemoTask(null);
    setDemoStream(null);

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setWorktreeChecked(true);
      setDemoTask(buildDemoTask(locale, false));
      setDemoStream({ text: d.reply, done: true });
      setSelectedTaskId(DEMO_TASK_ID);
      return cancel;
    }

    at(350, () => moveTo('[data-demo="workdir"] label'));
    at(1000, () => clickTarget('[data-demo="workdir"] label', () => setWorktreeChecked(true)));
    at(1450, () => moveTo('textarea'));
    const typeEnd = scheduleTypedText(at, 1800, d.promptText, locale, setPrompt);
    at(typeEnd + 220, () => moveTo('button[aria-label="Send"]'));
    const sendAt = typeEnd + 700;
    at(sendAt, () =>
      clickTarget('button[aria-label="Send"]', () => {
        setPrompt('');
        setDemoTask(buildDemoTask(locale, true));
        setDemoStream({ text: '', done: false });
        setSelectedTaskId(DEMO_TASK_ID);
        setCursor((c) => ({ ...c, visible: false }));
      })
    );
    const streamStart = sendAt + 350;
    const streamEnd = Math.min(WORKTREE_DEMO_DURATION_MS - 1200, streamStart + 1600);
    at(streamStart, () =>
      stream(d.reply, streamEnd - streamStart, 28, 6, (text, done) => {
        setDemoStream({ text, done });
        if (done) setDemoTask(buildDemoTask(locale, false));
      })
    );

    return () => {
      cancel();
      setCursor(CURSOR_HIDDEN);
      setDemoTask(null);
      setDemoStream(null);
      setWorktreeChecked(false);
      setPrompt('');
      setSelectedTaskId(null);
    };
  }, [isWorktreeDemo, isMounted, locale, moveCursorToEl]);

  // ---- Tab 2: live diff — GitHub session with Changes open; widen, open a file. ----
  useEffect(() => {
    if (!isDiffDemo || !isMounted) return undefined;
    const { at, cancel, isCancelled } = createTimeline();
    const shell = shellRef.current;

    // Keep tab 1's end state in the sidebar, and open straight onto Changes.
    setWorktreeChecked(true);
    setDemoTask(buildDemoTask(locale, false));
    setDemoStream({ text: DEMO_COPY[locale].reply, done: true });
    setSelectedTaskId(DIFF_DEMO_TASK_ID);
    setDiffDemo({ panelOpen: true, viewer: 'hidden' });

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDiffDemo({ panelOpen: true, viewer: 'shown' });
      return cancel;
    }

    const fileBasename = 'view.tsx';
    at(120, () => moveCursorToEl(findTarget(shell, '[data-slot="resizable-handle"]')));
    at(380, () =>
      dragHandleLeft(shell, -300, 14, 32, at, isCancelled, (handle, pulse) =>
        moveCursorToEl(handle, { pulse })
      )
    );
    at(1000, () => moveCursorToEl(findByText(shell, fileBasename)));
    at(1750, () => {
      const el = findByText(shell, fileBasename);
      moveCursorToEl(el, { pulse: true });
      clickQuiet(el, openDiffFile);
      at(700, () => setCursor((c) => ({ ...c, visible: false })));
    });

    return () => {
      cancel();
      if (diffSkeletonTimer.current) {
        window.clearTimeout(diffSkeletonTimer.current);
        diffSkeletonTimer.current = null;
      }
      setCursor(CURSOR_HIDDEN);
      setDemoTask(null);
      setDemoStream(null);
      setWorktreeChecked(false);
      setDiffDemo({ panelOpen: false, viewer: 'hidden' });
      setSelectedTaskId(null);
    };
  }, [isDiffDemo, isMounted, locale, openDiffFile, moveCursorToEl]);

  // ---- Tab 3: design mode — dev server → Browser → annotate → send → hot reload. ----
  useEffect(() => {
    if (!isDesignDemo || !isMounted) return undefined;
    const { at, stream, cancel, isCancelled } = createTimeline();
    const shell = shellRef.current;
    const d = DESIGN_DEMO_COPY[locale];

    // Opening state: the "Introduce Lody" session with its completed reply.
    setSelectedTaskId(DEMO_TASK_ID);
    setWorktreeChecked(true);
    setDemoTask(buildDemoTask(locale, false));
    setDemoStream({ text: DEMO_COPY[locale].reply, done: true });
    setDesignTurns(INITIAL_DESIGN_TURNS);
    setDesignPreview(INITIAL_LANDING_PREVIEW_STATE);
    setDesignPreviewAvailable(false);
    setDesignPreviewOpen(false);
    setDesignStagedRef(false);
    setReply('');

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDesignTurns({
        turn2User: true,
        turn2: { devDone: true, reportDone: true, text: d.turn2Text, done: true },
        turn3User: true,
        turn3: { editDone: true, text: d.turn3Text, done: true },
      });
      setDesignPreviewAvailable(true);
      setDesignPreviewOpen(true);
      setDesignPreview({
        loading: false,
        annotating: true,
        hoverLine: null,
        draft: null,
        savedComment: { line: 2, text: d.comment, staged: true },
        edited: true,
      });
      return cancel;
    }

    const moveTo = (selector: string) => moveCursorToEl(findTarget(shell, selector));
    const click = (selector: string, action?: () => void) => {
      const el = findTarget(shell, selector);
      moveCursorToEl(el, { pulse: true });
      clickQuiet(el, action);
    };

    at(60, () => moveTo('textarea'));
    const typeEnd = scheduleTypedText(at, 200, d.prompt, locale, setReply);
    at(typeEnd + 80, () =>
      moveCursorToEl(findTarget(shell, 'button[aria-label="Send"]'), { visible: false })
    );
    at(typeEnd + 140, () => setCursor((c) => ({ ...c, visible: true, pulse: c.pulse + 1 })));
    at(typeEnd + 400, () =>
      click('button[aria-label="Send"]', () => {
        setReply('');
        setDesignTurns((turns) => ({ ...turns, turn2User: true }));
        setDemoTask(buildDemoTask(locale, true));
        setCursor((c) => ({ ...c, visible: false }));
      })
    );
    // Reply: pnpm dev → report preview candidate → the info bar gains Browser.
    const toolsAt = typeEnd + 900;
    at(toolsAt, () =>
      setDesignTurns((turns) => ({
        ...turns,
        turn2: { devDone: false, reportDone: false, text: '', done: false },
      }))
    );
    at(toolsAt + 900, () =>
      setDesignTurns((turns) =>
        turns.turn2 ? { ...turns, turn2: { ...turns.turn2, devDone: true } } : turns
      )
    );
    at(toolsAt + 1400, () => {
      setDesignTurns((turns) =>
        turns.turn2 ? { ...turns, turn2: { ...turns.turn2, reportDone: true } } : turns
      );
      setDesignPreviewAvailable(true);
    });
    at(toolsAt + 1700, () =>
      stream(d.turn2Text, 700, 24, 6, (text, done) => {
        setDesignTurns((turns) =>
          turns.turn2 ? { ...turns, turn2: { ...turns.turn2, text, done } } : turns
        );
        if (done) setDemoTask(buildDemoTask(locale, false));
      })
    );
    // Open the Browser panel from the info bar, then widen it for the hero copy.
    const openPreviewAt = toolsAt + 3200;
    at(openPreviewAt - 80, () => moveTo(PREVIEW_ACTION_SELECTOR));
    at(openPreviewAt + 450, () => click(PREVIEW_ACTION_SELECTOR, () => setDesignPreviewOpen(true)));
    at(openPreviewAt + 900, () => setDesignPreview((state) => ({ ...state, loading: false })));
    at(openPreviewAt + 1200, () => moveTo('[data-slot="resizable-handle"]'));
    at(openPreviewAt + 1500, () =>
      dragHandleLeft(shell, -150, 8, 40, at, isCancelled, (handle, pulse) =>
        moveCursorToEl(handle, { pulse })
      )
    );
    // Annotation mode on, inspect the three copy lines.
    const annotateAt = openPreviewAt + 2200;
    at(annotateAt, () => moveTo(ANNOTATE_ACTION_SELECTOR));
    at(annotateAt + 400, () =>
      click(ANNOTATE_ACTION_SELECTOR, () =>
        setDesignPreview((state) => ({ ...state, annotating: true }))
      )
    );
    for (const [offset, line] of [
      [800, 0],
      [1400, 1],
      [2000, 2],
    ] as const) {
      at(annotateAt + offset, () => {
        moveTo(`[data-demo="pv-line-${line}"]`);
        setDesignPreview((state) => ({ ...state, hoverLine: line }));
      });
    }
    // Click the last line → draft comment card → type the comment.
    at(annotateAt + 2500, () =>
      click('[data-demo="pv-line-2"]', () =>
        setDesignPreview((state) => ({ ...state, draft: { line: 2, text: '' } }))
      )
    );
    at(annotateAt + 2900, () => moveTo('[data-demo="pv-draft"] textarea'));
    const commentEnd = scheduleTypedText(at, annotateAt + 3100, d.comment, locale, (slice) =>
      setDesignPreview((state) =>
        state.draft ? { ...state, draft: { ...state.draft, text: slice } } : state
      )
    );
    /* Adding the comment stages its reference in the composer in the same step
       (the app's submitDraft → onAddVisualAnnotationToChat), so the saved pin
       appears already staged. */
    at(commentEnd + 250, () => moveTo('[data-demo="pv-draft-send"]'));
    at(commentEnd + 600, () =>
      click('[data-demo="pv-draft-send"]', () => {
        setDesignPreview((state) => ({
          ...state,
          draft: null,
          hoverLine: null,
          savedComment: { line: 2, text: d.comment, staged: true },
        }));
        setDesignStagedRef(true);
      })
    );
    // Send from the session composer; the agent edits and the page hot-reloads.
    at(commentEnd + 1100, () => moveTo('button[aria-label="Send"]'));
    at(commentEnd + 1600, () =>
      click('button[aria-label="Send"]', () => {
        setReply('');
        setDesignStagedRef(false);
        setDesignTurns((turns) => ({ ...turns, turn3User: true }));
        setDemoTask(buildDemoTask(locale, true));
      })
    );
    at(commentEnd + 2000, () =>
      setDesignTurns((turns) => ({ ...turns, turn3: { editDone: false, text: '', done: false } }))
    );
    at(commentEnd + 2600, () => {
      setDesignTurns((turns) =>
        turns.turn3 ? { ...turns, turn3: { ...turns.turn3, editDone: true } } : turns
      );
      setDesignPreview((state) => ({ ...state, edited: true }));
      setCursor((c) => ({ ...c, visible: false }));
    });
    at(commentEnd + 2800, () =>
      stream(d.turn3Text, 500, 24, 6, (text, done) => {
        setDesignTurns((turns) =>
          turns.turn3 ? { ...turns, turn3: { ...turns.turn3, text, done } } : turns
        );
        if (done) setDemoTask(buildDemoTask(locale, false));
      })
    );

    return () => {
      cancel();
      setCursor(CURSOR_HIDDEN);
      setDemoTask(null);
      setDemoStream(null);
      setDesignTurns(INITIAL_DESIGN_TURNS);
      setDesignPreview(INITIAL_LANDING_PREVIEW_STATE);
      setDesignPreviewAvailable(false);
      setDesignPreviewOpen(false);
      setDesignStagedRef(false);
      setReply('');
      setWorktreeChecked(false);
      setSelectedTaskId(null);
    };
  }, [isDesignDemo, isMounted, locale, moveCursorToEl]);

  // ---- Tab 4: mobile — home → new chat → type → send → the image streams in. ----
  useEffect(() => {
    if (!isMobileDemo || !isMounted) return undefined;
    const { at, cancel } = createTimeline();
    const shell = shellRef.current;
    const jellyfish = PREVIEW_COPY[locale].jellyfish;
    const newChatSelector = `button[aria-label="${MOBILE_NEW_CHAT_LABEL[locale]}"]`;

    setSelectedTaskId(JELLYFISH_TASK_ID);
    setMobileScreen('home');
    setMobileTurn(null);
    setPrompt('');

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMobileScreen('session');
      setMobileTurn({ text: jellyfish.intro, image: true, done: true });
      return cancel;
    }

    // The phone cursor moves without a glide target check (the device is scaled).
    const moveTo = (selector: string) => {
      const el = findTarget(shell, selector);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCursor((c) => ({
        ...c,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        visible: true,
      }));
    };
    const click = (selector: string, action?: () => void) => {
      setCursor((c) => ({ ...c, pulse: c.pulse + 1, visible: true }));
      clickQuiet(findTarget(shell, selector), action);
    };

    at(350, () => moveTo(newChatSelector));
    at(800, () => click(newChatSelector, () => setMobileScreen('compose')));
    at(1200, () => moveTo('textarea'));
    const typeEnd = scheduleTypedText(at, 1350, jellyfish.user, locale, setPrompt);
    at(typeEnd + 200, () => moveTo('button[aria-label="Send"]'));
    const sendAt = typeEnd + 650;
    at(sendAt, () =>
      click('button[aria-label="Send"]', () => {
        setPrompt('');
        setMobileScreen('session');
        setMobileTurn({ text: '', image: false, done: false });
        setCursor((c) => ({ ...c, visible: false }));
      })
    );
    at(sendAt + 300, () => {
      const target = jellyfish.intro;
      const perTick = Math.max(2, Math.ceil(target.length / 6));
      let offset = 0;
      const tick = () => {
        offset = Math.min(target.length, offset + perTick);
        setMobileTurn((turn) => (turn ? { ...turn, text: target.slice(0, offset) } : turn));
        if (offset < target.length) at(22, tick);
      };
      tick();
    });
    at(sendAt + 800, () => setMobileTurn((turn) => (turn ? { ...turn, image: true } : turn)));
    at(sendAt + 1000, () => setMobileTurn((turn) => (turn ? { ...turn, done: true } : turn)));

    return () => {
      cancel();
      setCursor(CURSOR_HIDDEN);
      setMobileScreen('home');
      setMobileTurn(null);
      setPrompt('');
      setSelectedTaskId(null);
    };
  }, [isMobileDemo, isMounted, locale]);

  const messages = useMemo<ReplicaMessage[]>(() => {
    if (selectedTaskId === DEMO_TASK_ID) {
      return isDesignDemo
        ? buildDesignDemoHistory(locale, designTurns)
        : buildDemoIntroHistory(locale, demoStream);
    }
    if (selectedTaskId === JELLYFISH_TASK_ID) return buildJellyfishHistory(locale, mobileTurn);
    if (selectedTaskId === DIFF_DEMO_TASK_ID) return buildLodyPrHistory(locale);
    return [];
  }, [demoStream, designTurns, isDesignDemo, locale, mobileTurn, selectedTaskId]);

  // Ghost touch indicator, portaled to <body> in viewport space.
  const cursorNode =
    isDemo && isMounted
      ? createPortal(
          <div
            aria-hidden="true"
            className="lody-demo-cursor"
            data-visible={cursor.visible ? 'true' : 'false'}
            data-instant={cursor.instant ? 'true' : 'false'}
            style={{ transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)` }}
          >
            {cursor.pulse > 0 ? (
              <span key={cursor.pulse} className="lody-demo-cursor__pulse" />
            ) : null}
            <span className="lody-demo-cursor__dot" />
          </div>,
          document.body
        )
      : null;

  // On the underwater stage the card plate is dropped for the phone demo so
  // switching tabs never flashes a full-size background rect over the scene.
  const shellClassName = cn(
    'lody-app-preview relative overflow-hidden text-foreground',
    isMobileDemo
      ? 'rounded-none border-0 bg-transparent shadow-none'
      : 'landing-app-preview--stage-demo rounded-lg border border-slate-200/80 bg-background shadow-2xl shadow-slate-400/25 dark:border-white/10 dark:shadow-cyan-950/30'
  );

  if (!isMounted) {
    return (
      <div
        className={cn(
          'lody-app-preview landing-app-preview--stage-demo overflow-hidden border-0 bg-transparent text-foreground shadow-none'
        )}
      >
        <div className="landing-app-preview-stage flex min-h-0 flex-1 items-center justify-center">
          <div className="h-28 w-full max-w-xl rounded-2xl border border-border/40 bg-card/40" />
        </div>
      </div>
    );
  }

  const runConfigFooter = (
    <div className="contents">
      <ReplicaRunConfigTrigger agent="codex" modelLabel={t.modelLabel} thinkLabel={t.thinkLabel} />
      <ReplicaPermissionModeTrigger label={t.permissionLabel} />
    </div>
  );
  const designAnnotations = isDesignDemo && designStagedRef ? [buildDesignAnnotation(locale)] : [];

  let content: React.ReactNode;
  if (isMobileDemo) {
    const mobileTasks = [
      ...(demoTask ? [demoTask] : []),
      ...chatTasks,
      localSession,
      ...githubTasks,
    ]
      .sort((a, b) => b.latestMessageAt - a.latestMessageAt)
      .map(toMobileChat);
    content = (
      <LandingMobilePreview
        locale={locale}
        screen={mobileScreen}
        chats={mobileTasks}
        machineName={t.machineName}
        sheetComposer={
          <ReplicaComposer
            variant="mobile-sheet"
            value={prompt}
            footer={
              <ReplicaMobileSheetFooterPickers
                locale={locale}
                modelLabel={t.modelLabel}
                thinkLabel={t.thinkLabel}
              />
            }
            primaryAction={
              <ReplicaSendButton variant="mobile-sheet" disabled={prompt.trim().length === 0} />
            }
            locale={locale}
          />
        }
        sheetBelowComposer={{
          agentLabel: t.agentName,
          permissionMode: 'default',
          permissionLabel: t.permissionLabel,
        }}
        sessionNode={
          selectedTask ? (
            <MobileSession
              locale={locale}
              task={selectedTask}
              messages={messages}
              composer={
                <ReplicaComposer
                  variant="mobile-session"
                  value={reply}
                  footer={
                    <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <ReplicaMobileRunConfigTrigger
                          agent="codex"
                          modelLabel={t.modelLabel}
                          thinkLabel={t.thinkLabel}
                        />
                      </div>
                    </div>
                  }
                  primaryAction={
                    <ReplicaSendButton
                      variant="mobile-session"
                      disabled={reply.trim().length === 0}
                    />
                  }
                  locale={locale}
                />
              }
            />
          ) : null
        }
      />
    );
  } else {
    content = (
      /* Worktree / diff / design always use the DESKTOP shell, even on phone
         viewports: CSS contain-scales it into the reveal frame. */
      <div className="landing-app-preview-stage min-h-0 w-full flex-1">
        <div className="landing-desktop-demo-shell flex h-full min-h-0">
          <ReplicaSidebar
            locale={locale}
            workspace={{ name: 'Lody', logoUrl: WORKSPACE_LOGO }}
            demoProject={demoTask ? { name: DEMO_PROJECT_NAME, sessions: [demoTask] } : null}
            localProjects={[{ name: t.localProjectName, sessions: [localSession] }]}
            chats={chatTasks}
            github={[
              {
                repoFullName: GITHUB_REPO,
                ownerAvatarUrl: GITHUB_OWNER_AVATAR,
                sessions: githubTasks,
              },
            ]}
            selectedSessionId={selectedTaskId}
            homeActive={!selectedTask}
          />
          <div className="min-w-0 flex-1">
            {selectedTask ? (
              <DesktopSession
                // Each demo starts from the default split.
                key={demo ?? 'static'}
                locale={locale}
                task={selectedTask}
                messages={messages}
                dark={isDark}
                diffDemo={isDiffDemo ? diffDemo : null}
                designDemo={
                  isDesignDemo && selectedTask.id === DEMO_TASK_ID
                    ? {
                        previewAvailable: designPreviewAvailable,
                        previewOpen: designPreviewOpen,
                        preview: designPreview,
                      }
                    : null
                }
                onOpenDiffFile={openDiffFile}
                composer={
                  <ReplicaComposer
                    variant="session"
                    value={reply}
                    footer={runConfigFooter}
                    annotations={designAnnotations}
                    primaryAction={
                      <ReplicaSendButton
                        variant="session"
                        disabled={reply.trim().length === 0 && designAnnotations.length === 0}
                      />
                    }
                    locale={locale}
                  />
                }
              />
            ) : (
              <ReplicaChatLandingView
                title={t.landing.title}
                composer={
                  <ReplicaComposer
                    variant="landing"
                    value={prompt}
                    placeholder={t.landing.placeholder}
                    topSelector={
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <ReplicaMachineMenuTrigger label={t.machineName} />
                        <ReplicaProjectSelectorTrigger
                          label={DEMO_PROJECT_NAME}
                          kind="local"
                          locale={locale}
                        />
                        <ReplicaBranchWorktreePill
                          branch="main"
                          worktree={worktreeChecked}
                          showWorktree
                          locale={locale}
                        />
                      </div>
                    }
                    footer={runConfigFooter}
                    primaryAction={
                      <ReplicaSendButton variant="landing" disabled={prompt.trim().length === 0} />
                    }
                    locale={locale}
                  />
                }
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={shellClassName} ref={shellRef}>
      {cursorNode}
      {content}
    </div>
  );
}
