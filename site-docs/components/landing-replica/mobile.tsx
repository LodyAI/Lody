/**
 * Display-only replicas of the app's mobile chrome for the landing's
 * Mobile-access demo: glass header buttons, the frosted session header, the
 * inline-picker trigger chip and the new-chat sheet's slot stack.
 *
 * Sources (render path the landing shows only):
 * - `mobile/glass-icon-button.tsx`, `mobile/mobile-session-tab-sheet.tsx`
 *   (`MobileSessionTabButton` trigger, no badge)
 * - `page-headers/base-header.tsx` + `sessions/session-detail.tsx`'s mobile
 *   `BaseHeader` / `MobileProjectInfo`
 * - `mobile/mobile-inline-picker.tsx` (closed trigger + `MobileInlinePickerRowSlot`)
 * - `mobile/mobile-new-chat-sheet.tsx` (`MobileNewChatSheetContent`, chat type,
 *   no close button)
 */

import { useEffect, useRef, type ReactNode, type SVGProps } from 'react';
import {
  ChevronLeft,
  Compass,
  Ellipsis,
  Eye,
  Folder,
  Github,
  MessageCircle,
  Monitor,
  PenLine,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import { cn } from './utils';
import * as stylex from '@stylexjs/stylex';
import type { ReplicaLocale, ReplicaPrStatus } from './types';

const styles = stylex.create({
  glassButton: {
    position: 'relative',
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 11)',
    width: 'calc(var(--spacing) * 11)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    color: {
      default: '#1c1c1e',
      ':where(.dark, .dark *)': 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
    },
    transitionProperty: 'transform, translate, scale, rotate',
    transitionTimingFunction: 'var(--ease-out)',
    transitionDuration: '200ms',
  },
  glassCanvas: {
    pointerEvents: 'none',
    position: 'absolute',
    left: '50%',
    top: '50%',
    translate: '-50% -50%',
    borderRadius: 'calc(infinity * 1px)',
  },
  glassGlyph: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'currentColor',
    ':is(*) svg': {
      color: 'currentColor',
    },
  },
  sessionTabsGlyph: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    color: 'currentColor',
  },
  sessionHeader: {
    position: 'absolute',
    insetInline: 'calc(var(--spacing) * 0)',
    top: 'calc(var(--spacing) * 0)',
    zIndex: 30,
    display: 'flex',
    height: 'calc(var(--spacing) * 14)',
    alignItems: 'center',
    backgroundColor: 'color-mix(in oklab, hsl(var(--background)) 55%, transparent)',
    paddingInline: {
      default: 'calc(var(--spacing) * 3)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 4)',
    },
    backdropFilter: 'blur(var(--blur-xl))',
  },
  backButtonSlot: {
    marginRight: 'calc(var(--spacing) * 2)',
    flexShrink: 0,
  },
  backGlyph: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    color: 'currentColor',
  },
  headerTitle: {
    minWidth: 0,
    flex: '1',
    fontSize: 'var(--text-base)',
    lineHeight: 'var(--text-base--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  titleStack: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    lineHeight: '1.25',
  },
  titleLine: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: 'var(--font-weight-semibold)',
    color: 'hsl(var(--foreground))',
  },
  subtitleLine: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  projectGlyphSlot: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
  },
  localProjectGlyph: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
  githubProjectGlyph: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
  subtitleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerActions: {
    marginLeft: 'calc(var(--spacing) * 2)',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: {
      default: 'calc(var(--spacing) * 1)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 2)',
    },
  },
  sessionControls: {
    marginRight: 'calc(var(--spacing) * -2)',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
  },
  overflowGlyph: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    color: 'currentColor',
  },
  pickerTrigger: {
    display: 'flex',
    width: '100%',
    userSelect: 'none',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    textAlign: 'left',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    transitionProperty: 'all',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--input)) 40%, transparent)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 85%, transparent)',
  },
  pickerContent: {
    display: 'flex',
    minWidth: 0,
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  pickerExpansion: {
    width: '100%',
  },
  footerPickers: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
  },
  modelSlot: {
    minWidth: 0,
  },
  modelPicker: {
    width: '100%',
  },
  modelText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  thinkingSlot: {
    marginLeft: 'calc(var(--spacing) * 1)',
    flexShrink: 0,
  },
  thinkingPicker: {
    width: '100%',
  },
  thinkingText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  belowComposer: {
    display: 'flex',
    width: '100%',
    alignItems: 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  agentSlot: {
    minWidth: 0,
  },
  agentText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  permissionSlot: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  permissionPicker: {
    minWidth: 0,
  },
  permissionGlyph: {
    display: 'flex',
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.8,
  },
  permissionText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sheetRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'stretch',
    gap: 'calc(var(--spacing) * 3)',
    borderRadius: 'var(--radius-xl)',
    backgroundColor: 'var(--color-card)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    boxShadow: '0 0 0 1px color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
  },
  sheetRowLabel: {
    width: 'calc(var(--spacing) * 16)',
    flexShrink: 0,
    alignSelf: 'center',
    fontSize: '0.72rem',
    fontWeight: 'var(--font-weight-semibold)',
    letterSpacing: '0.025em',
    color: 'hsl(var(--muted-foreground))',
  },
  sheetRowContent: {
    minWidth: 0,
    flex: '1',
  },
  sheet: {
    display: 'flex',
    minHeight: 0,
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  sheetHeader: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBottom: 'calc(var(--spacing) * 2)',
    paddingTop: 'calc(var(--spacing) * 2)',
  },
  sheetTitle: {
    marginInline: 'auto',
    userSelect: 'none',
    fontSize: '0.95rem',
    fontWeight: 'var(--font-weight-semibold)',
    letterSpacing: '-0.025em',
  },
  accessibleTitle: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  sheetScroll: {
    minHeight: 0,
    flex: '1',
    overflowY: 'auto',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBottom:
      'calc(12px + max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))',
  },
  contextRows: {
    display: 'flex',
    flexDirection: 'column',
    paddingBottom: 'calc(var(--spacing) * 3)',
    paddingTop: 'calc(var(--spacing) * 1)',
  },
  machineRow: {
    paddingTop: {
      default: 'calc(var(--spacing) * 1.5)',
      ':first-child': 0,
    },
  },
  machineLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  machineGlyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  typeRow: {
    paddingTop: {
      default: 'calc(var(--spacing) * 1.5)',
      ':first-child': 0,
    },
  },
  typeLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  typeGlyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  composerSlot: {
    paddingTop: 'calc(var(--spacing) * 1)',
  },
  belowComposerSlot: {
    paddingInline: 'calc(var(--spacing) * 1)',
    paddingTop: 'calc(var(--spacing) * 2)',
  },
  modeGlyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  sheetChip: {
    height: 'calc(var(--spacing) * 8)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  backButtonInset: {
    marginLeft: 'calc(var(--spacing) * -1)',
  },
});

// ---- Copy ----------------------------------------------------------------------

/* Values match the landing's `copy[locale].mobile` / `contextSwitch` / selector
   tables, so ghost-cursor selectors built from either source agree. */
export const MOBILE_LABELS = {
  en: {
    chatTab: 'Chat',
    projectsTab: 'Projects',
    searchConversations: 'Search conversations',
    search: 'Search',
    filters: 'Filters',
    newChat: 'New chat',
    back: 'Back',
    moreActions: 'More actions',
    sessionTabs: 'Session tabs',
    sheetTitle: 'New chat',
    machine: 'Machine',
    contextType: 'Type',
    chatType: 'Chat',
    model: 'Model',
    thinkLevel: 'Think level',
    agent: 'ACP Provider',
    permissionMode: 'Permission mode',
  },
  zh: {
    chatTab: '对话',
    projectsTab: '项目',
    searchConversations: '搜索对话',
    search: '搜索',
    filters: '过滤',
    newChat: '新建对话',
    back: '返回',
    moreActions: '更多操作',
    sessionTabs: '会话标签',
    sheetTitle: '新对话',
    machine: '机器',
    contextType: '类型',
    chatType: '对话',
    model: '模型',
    thinkLevel: '思考强度',
    agent: 'ACP Provider',
    permissionMode: '权限模式',
  },
} as const satisfies Record<ReplicaLocale, Record<string, string>>;

/** aria-label of the home tab bar's new-chat FAB — the ghost script clicks it. */
export const MOBILE_NEW_CHAT_LABEL: Record<ReplicaLocale, string> = {
  en: MOBILE_LABELS.en.newChat,
  zh: MOBILE_LABELS.zh.newChat,
};

// ---- Demo data -------------------------------------------------------------------

/** One row of the home "all chats" list (`ConversationRow`, flat, not pinned). */
export type ReplicaMobileChat = {
  id: string;
  title: string;
  prNumber?: number | null;
  prStatus?: ReplicaPrStatus | null;
  addedLines?: number;
  deletedLines?: number;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  hasUnreadMessages?: boolean;
  /** Draws the faint worktree glyph before the PR icon. */
  isWorktree?: boolean;
};

export type ReplicaPermissionMode = 'default' | 'acceptEdits' | 'read-only' | 'plan' | 'dontAsk';

// ---- Glass buttons -----------------------------------------------------------------

type GlassMode = 'light' | 'dark';

function resolveGlassMode(): GlassMode {
  const root = document.documentElement;
  return root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark'
    ? 'dark'
    : 'light';
}

function resolveRgb(el: HTMLElement): string {
  const m = getComputedStyle(el).color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? `${m[1]},${m[2]},${m[3]}` : '255,255,255';
}

function drawDarkGlass(ctx: CanvasRenderingContext2D, size: number, rgb: string) {
  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${rgb},0.085)`;
  ctx.fill();

  const off = document.createElement('canvas');
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  off.width = off.height = size * dpr;
  const octx = off.getContext('2d');
  if (!octx) return;
  octx.scale(dpr, dpr);

  const rg = octx.createRadialGradient(r, r, r * 0.9, r, r, r - 0.5);
  rg.addColorStop(0, `rgba(${rgb},0)`);
  rg.addColorStop(0.7, `rgba(${rgb},0.28)`);
  rg.addColorStop(1, `rgba(${rgb},0.9)`);
  octx.beginPath();
  octx.arc(r, r, r - 0.5, 0, Math.PI * 2);
  octx.fillStyle = rg;
  octx.fill();

  const lineW = Math.max(1, size * 0.014);
  octx.strokeStyle = `rgba(${rgb},1)`;
  octx.lineWidth = lineW;
  octx.beginPath();
  octx.arc(r, r, r - lineW / 2 - 0.5, 0, Math.PI * 2);
  octx.stroke();

  octx.globalCompositeOperation = 'destination-in';
  const vg = octx.createLinearGradient(0, 0, 0, size);
  vg.addColorStop(0, 'rgba(255,255,255,0.22)');
  vg.addColorStop(0.4, 'rgba(255,255,255,0)');
  vg.addColorStop(0.6, 'rgba(255,255,255,0)');
  vg.addColorStop(1, 'rgba(255,255,255,0.14)');
  octx.fillStyle = vg;
  octx.fillRect(0, 0, size, size);

  ctx.drawImage(off, 0, 0, size, size);
}

function drawLightGlass(ctx: CanvasRenderingContext2D, size: number) {
  const r = size / 2;
  const discR = r - 0.5;
  const disc = () => {
    ctx.beginPath();
    ctx.arc(r, r, discR, 0, Math.PI * 2);
  };

  ctx.save();
  disc();
  ctx.clip();

  const body = ctx.createRadialGradient(r, r, 0, r, r, discR);
  body.addColorStop(0.0, 'rgb(254, 254, 254)');
  body.addColorStop(0.28, 'rgb(253, 253, 253)');
  body.addColorStop(0.5, 'rgb(252, 252, 252)');
  body.addColorStop(0.72, 'rgb(251, 251, 252)');
  body.addColorStop(0.86, 'rgb(250, 250, 251)');
  body.addColorStop(0.94, 'rgb(252, 252, 253)');
  body.addColorStop(1.0, 'rgb(253, 253, 254)');
  disc();
  ctx.fillStyle = body;
  ctx.fill();

  const vertical = ctx.createLinearGradient(0, 0, 0, size);
  vertical.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  vertical.addColorStop(0.2, 'rgba(255, 255, 255, 0)');
  vertical.addColorStop(0.8, 'rgba(255, 255, 255, 0)');
  vertical.addColorStop(1, 'rgba(255, 255, 255, 0.16)');
  disc();
  ctx.fillStyle = vertical;
  ctx.fill();

  const sides = ctx.createLinearGradient(0, 0, size, 0);
  sides.addColorStop(0, 'rgba(150, 154, 164, 0.05)');
  sides.addColorStop(0.18, 'rgba(150, 154, 164, 0.015)');
  sides.addColorStop(0.5, 'rgba(150, 154, 164, 0)');
  sides.addColorStop(0.82, 'rgba(150, 154, 164, 0.015)');
  sides.addColorStop(1, 'rgba(150, 154, 164, 0.05)');
  disc();
  ctx.fillStyle = sides;
  ctx.fill();

  ctx.restore();

  const rimW = Math.max(0.75, size * 0.018);
  ctx.beginPath();
  ctx.arc(r, r, discR - rimW / 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(140, 144, 154, 0.1)';
  ctx.lineWidth = rimW;
  ctx.stroke();
}

/**
 * The app's canvas-drawn liquid-glass disc (36px) inside a 44px target.
 * Redraws when `html` flips theme, like the app.
 */
export function ReplicaGlassIconButton({
  label,
  children,
  className,
  xstyle,
  discSize = 36,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  discSize?: number;
  xstyle?: stylex.StyleXStyles;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const draw = () => {
      const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      canvas.width = discSize * dpr;
      canvas.height = discSize * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, discSize, discSize);
      if (resolveGlassMode() === 'light') {
        drawLightGlass(ctx, discSize);
      } else {
        const host = buttonRef.current;
        drawDarkGlass(ctx, discSize, host ? resolveRgb(host) : '255,255,255');
      }
    };
    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, [discSize]);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      className={cn('group', stylex.props(styles.glassButton, xstyle).className, className)}
      style={stylex.props(styles.glassButton, xstyle).style}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        {...stylex.props(styles.glassCanvas)}
        style={{ width: discSize, height: discSize }}
      />
      <span {...stylex.props(styles.glassGlyph)}>{children}</span>
    </button>
  );
}

/** Phosphor "chats" glyph the app's session-tab button draws. */
function ChatsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 256 256"
      {...props}
    >
      <path
        fill="currentColor"
        d="M232.07 186.76a80 80 0 0 0-62.5-114.17a80 80 0 1 0-145.64 66.17l-7.27 24.71a16 16 0 0 0 19.87 19.87l24.71-7.27a80.4 80.4 0 0 0 25.18 7.35a80 80 0 0 0 108.34 40.65l24.71 7.27a16 16 0 0 0 19.87-19.86ZM62 159.5a8.3 8.3 0 0 0-2.26.32L32 168l8.17-27.76a8 8 0 0 0-.63-6A64 64 0 1 1 65.8 160.5a8 8 0 0 0-3.8-1m153.79 28.73L224 216l-27.76-8.17a8 8 0 0 0-6 .63a64.05 64.05 0 0 1-85.87-24.88a79.93 79.93 0 0 0 70.33-93.87a64 64 0 0 1 41.75 92.48a8 8 0 0 0-.63 6.04Z"
      />
    </svg>
  );
}

/** `MobileSessionTabButton` at rest (no unread / working badge). */
export function ReplicaMobileSessionTabButton({ ariaLabel }: { ariaLabel: string }) {
  return (
    <ReplicaGlassIconButton label={ariaLabel}>
      <ChatsIcon {...stylex.props(styles.sessionTabsGlyph)} aria-hidden="true" />
    </ReplicaGlassIconButton>
  );
}

// ---- Session header -----------------------------------------------------------------

/** Height of the floating header; the conversation pads its top by this. */
export const MOBILE_SESSION_HEADER_INSET = '3rem';

/**
 * The mobile session's floating frosted `BaseHeader`: glass back chevron,
 * `MobileProjectInfo` title (session title + project subtitle), session-tabs
 * and "…" glass buttons. Absolutely positioned — the host is `relative` and
 * sets `--conversation-top-inset` to {@link MOBILE_SESSION_HEADER_INSET}.
 */
export function ReplicaMobileSessionHeader({
  title,
  projectLabel,
  projectKind,
  locale,
}: {
  title: string;
  projectLabel: string | null;
  projectKind: 'local' | 'github' | null;
  locale: ReplicaLocale;
}) {
  const labels = MOBILE_LABELS[locale];
  const primary = title || projectLabel || '';
  const showSubtitle = Boolean(title) && Boolean(projectLabel);
  return (
    <div
      {...stylex.props(styles.sessionHeader)}
      style={{ height: MOBILE_SESSION_HEADER_INSET, paddingTop: 'var(--safe-area-top, 0px)' }}
    >
      <div {...stylex.props(styles.backButtonSlot)}>
        <ReplicaGlassIconButton label={labels.back} xstyle={styles.backButtonInset}>
          <ChevronLeft {...stylex.props(styles.backGlyph)} strokeWidth={1.75} />
        </ReplicaGlassIconButton>
      </div>
      <h2 {...stylex.props(styles.headerTitle)}>
        <span {...stylex.props(styles.titleStack)}>
          <span {...stylex.props(styles.titleLine)}>
            <span {...stylex.props(styles.titleText)}>{primary}</span>
          </span>
          {showSubtitle ? (
            <span {...stylex.props(styles.subtitleLine)}>
              <span {...stylex.props(styles.projectGlyphSlot)}>
                {projectKind === 'local' ? (
                  <Folder {...stylex.props(styles.localProjectGlyph)} />
                ) : (
                  <Github {...stylex.props(styles.githubProjectGlyph)} />
                )}
              </span>
              <span {...stylex.props(styles.subtitleText)}>{projectLabel}</span>
            </span>
          ) : null}
        </span>
      </h2>
      <div {...stylex.props(styles.headerActions)}>
        <div {...stylex.props(styles.sessionControls)}>
          <ReplicaMobileSessionTabButton ariaLabel={labels.sessionTabs} />
          <ReplicaGlassIconButton label={labels.moreActions}>
            <Ellipsis {...stylex.props(styles.overflowGlyph)} strokeWidth={1.75} />
          </ReplicaGlassIconButton>
        </div>
      </div>
    </div>
  );
}

// ---- Inline picker ---------------------------------------------------------------------

/** Closed `MobileInlinePicker` trigger chip (the drawer never opens here). */
export function ReplicaMobilePickerTrigger({
  children,
  ariaLabel,
  className,
  xstyle,
}: {
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  xstyle?: stylex.StyleXStyles;
}) {
  return (
    <button
      type="button"
      aria-haspopup="listbox"
      aria-expanded={false}
      aria-label={ariaLabel}
      className={cn(
        'group/picker-trigger',
        stylex.props(styles.pickerTrigger, xstyle).className,
        className
      )}
      style={stylex.props(styles.pickerTrigger, xstyle).style}
    >
      <span {...stylex.props(styles.pickerContent)}>{children}</span>
    </button>
  );
}

/** `MobileInlinePickerRowSlot`: the row plus its (always empty) expansion slot. */
export function ReplicaMobilePickerRow({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <div {...stylex.props(styles.pickerExpansion)} aria-hidden="true" />
    </>
  );
}

function PermissionModeIcon({ mode }: { mode: ReplicaPermissionMode }) {
  switch (mode) {
    case 'plan':
      return <Compass {...stylex.props(styles.modeGlyph)} strokeWidth={1.5} />;
    case 'acceptEdits':
      return <PenLine {...stylex.props(styles.modeGlyph)} strokeWidth={1.5} />;
    case 'dontAsk':
      return <ShieldOff {...stylex.props(styles.modeGlyph)} strokeWidth={1.5} />;
    case 'read-only':
      return <Eye {...stylex.props(styles.modeGlyph)} strokeWidth={1.5} />;
    default:
      return <ShieldCheck {...stylex.props(styles.modeGlyph)} strokeWidth={1.5} />;
  }
}

/**
 * New-chat sheet COMPOSER FOOTER: model + thinking chips (chat-landing's
 * sheet `footerSelector`). The orchestrator passes this into the composer's
 * footer slot.
 */
export function ReplicaMobileSheetFooterPickers({
  locale,
  modelLabel,
  thinkLabel,
}: {
  locale: ReplicaLocale;
  modelLabel: string;
  thinkLabel: string;
}) {
  const labels = MOBILE_LABELS[locale];
  return (
    <div {...stylex.props(styles.footerPickers)}>
      <div {...stylex.props(styles.modelSlot)}>
        <div {...stylex.props(styles.modelPicker)}>
          <ReplicaMobilePickerTrigger ariaLabel={labels.model} xstyle={styles.sheetChip}>
            <span {...stylex.props(styles.modelText)}>{modelLabel}</span>
          </ReplicaMobilePickerTrigger>
        </div>
      </div>
      <div {...stylex.props(styles.thinkingSlot)}>
        <div {...stylex.props(styles.thinkingPicker)}>
          <ReplicaMobilePickerTrigger ariaLabel={labels.thinkLevel} xstyle={styles.sheetChip}>
            <span {...stylex.props(styles.thinkingText)}>{thinkLabel}</span>
          </ReplicaMobilePickerTrigger>
        </div>
      </div>
    </div>
  );
}

export type ReplicaMobileSheetBelowComposer = {
  /** Agent display name, e.g. `Codex`. */
  agentLabel: string;
  permissionMode: ReplicaPermissionMode;
  /** Permission option label, e.g. `Agent (full access)`. */
  permissionLabel: string;
};

/** Agent chip (left) + permission chip (right) under the sheet composer. */
function SheetBelowComposer({
  locale,
  agentLabel,
  permissionMode,
  permissionLabel,
}: ReplicaMobileSheetBelowComposer & { locale: ReplicaLocale }) {
  const labels = MOBILE_LABELS[locale];
  return (
    <ReplicaMobilePickerRow>
      <div {...stylex.props(styles.belowComposer)}>
        <div {...stylex.props(styles.agentSlot)}>
          <ReplicaMobilePickerTrigger ariaLabel={labels.agent} xstyle={styles.sheetChip}>
            <span {...stylex.props(styles.agentText)}>{agentLabel}</span>
          </ReplicaMobilePickerTrigger>
        </div>
        <div {...stylex.props(styles.permissionSlot)}>
          <div {...stylex.props(styles.permissionPicker)}>
            <ReplicaMobilePickerTrigger ariaLabel={labels.permissionMode} xstyle={styles.sheetChip}>
              <span {...stylex.props(styles.permissionGlyph)}>
                <PermissionModeIcon mode={permissionMode} />
              </span>
              <span {...stylex.props(styles.permissionText)}>{permissionLabel}</span>
            </ReplicaMobilePickerTrigger>
          </div>
        </div>
      </div>
    </ReplicaMobilePickerRow>
  );
}

// ---- New-chat sheet ---------------------------------------------------------------------

function SheetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ReplicaMobilePickerRow>
      <div {...stylex.props(styles.sheetRow)}>
        <span {...stylex.props(styles.sheetRowLabel)}>{label}</span>
        <div {...stylex.props(styles.sheetRowContent)}>{children}</div>
      </div>
    </ReplicaMobilePickerRow>
  );
}

/**
 * `MobileNewChatSheetContent` for the plain-chat context: title, Machine row,
 * Type row, the composer node, then the agent/permission row. No close button
 * (the landing hosts it in its own slide-up).
 */
export function ReplicaMobileNewChatSheetContent({
  locale,
  machineName,
  composer,
  belowComposer,
}: {
  locale: ReplicaLocale;
  machineName: string;
  composer: ReactNode;
  belowComposer: ReplicaMobileSheetBelowComposer;
}) {
  const labels = MOBILE_LABELS[locale];
  return (
    <div {...stylex.props(styles.sheet)}>
      <header {...stylex.props(styles.sheetHeader)}>
        <h2 {...stylex.props(styles.sheetTitle)}>{labels.sheetTitle}</h2>
      </header>
      <p {...stylex.props(styles.accessibleTitle)}>{labels.sheetTitle}</p>
      <div {...stylex.props(styles.sheetScroll)} data-landing-scroll-region="">
        <div {...stylex.props(styles.contextRows)}>
          <div {...stylex.props(styles.machineRow)}>
            <SheetRow label={labels.machine}>
              <ReplicaMobilePickerTrigger ariaLabel={labels.machine}>
                <span {...stylex.props(styles.machineLabel)}>
                  <Monitor {...stylex.props(styles.machineGlyph)} />
                  {machineName}
                </span>
              </ReplicaMobilePickerTrigger>
            </SheetRow>
          </div>
          <div {...stylex.props(styles.typeRow)}>
            <SheetRow label={labels.contextType}>
              <ReplicaMobilePickerTrigger ariaLabel={labels.contextType}>
                <span {...stylex.props(styles.typeLabel)}>
                  <MessageCircle {...stylex.props(styles.typeGlyph)} />
                  {labels.chatType}
                </span>
              </ReplicaMobilePickerTrigger>
            </SheetRow>
          </div>
        </div>
        <div {...stylex.props(styles.composerSlot)}>{composer}</div>
        <div {...stylex.props(styles.belowComposerSlot)}>
          <SheetBelowComposer locale={locale} {...belowComposer} />
        </div>
      </div>
    </div>
  );
}
