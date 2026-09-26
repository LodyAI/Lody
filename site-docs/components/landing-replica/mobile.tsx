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
import type { ReplicaLocale, ReplicaPrStatus } from './types';

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
  discSize = 36,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  discSize?: number;
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
      className={cn(
        'group relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
        'text-[#1c1c1e] dark:text-foreground/90',
        'transition-transform duration-200 ease-out',
        className
      )}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ width: discSize, height: discSize }}
      />
      <span className="relative inline-flex items-center justify-center text-current [&_svg]:text-current">
        {children}
      </span>
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
      <ChatsIcon className="h-5 w-5 text-current" aria-hidden="true" />
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
      className="absolute inset-x-0 top-0 z-30 flex h-14 items-center bg-background/55 px-3 backdrop-blur-xl sm:px-4"
      style={{ height: MOBILE_SESSION_HEADER_INSET, paddingTop: 'var(--safe-area-top, 0px)' }}
    >
      <div className="mr-2 shrink-0">
        <ReplicaGlassIconButton label={labels.back} className="-ml-1">
          <ChevronLeft className="h-5 w-5 text-current" strokeWidth={1.75} />
        </ReplicaGlassIconButton>
      </div>
      <h2 className="min-w-0 flex-1 text-base font-semibold">
        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[0.95rem] font-semibold text-foreground">{primary}</span>
          </span>
          {showSubtitle ? (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span className="inline-flex shrink-0 items-center">
                {projectKind === 'local' ? (
                  <Folder className="h-3 w-3" />
                ) : (
                  <Github className="h-3 w-3" />
                )}
              </span>
              <span className="truncate">{projectLabel}</span>
            </span>
          ) : null}
        </span>
      </h2>
      <div className="ml-2 flex shrink-0 items-center gap-1 sm:gap-2">
        <div className="-mr-2 flex shrink-0 items-center gap-1">
          <ReplicaMobileSessionTabButton ariaLabel={labels.sessionTabs} />
          <ReplicaGlassIconButton label={labels.moreActions}>
            <Ellipsis className="h-5 w-5 text-current" strokeWidth={1.75} />
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
}: {
  children: ReactNode;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-haspopup="listbox"
      aria-expanded={false}
      aria-label={ariaLabel}
      className={cn(
        'group/picker-trigger flex w-full select-none items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm font-medium transition-all',
        'bg-input/40 text-foreground/85',
        className
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </button>
  );
}

/** `MobileInlinePickerRowSlot`: the row plus its (always empty) expansion slot. */
export function ReplicaMobilePickerRow({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <div className="w-full" aria-hidden="true" />
    </>
  );
}

const MODE_ICON_CLASS = 'h-3.5 w-3.5';

function PermissionModeIcon({ mode }: { mode: ReplicaPermissionMode }) {
  switch (mode) {
    case 'plan':
      return <Compass className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    case 'acceptEdits':
      return <PenLine className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    case 'dontAsk':
      return <ShieldOff className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    case 'read-only':
      return <Eye className={MODE_ICON_CLASS} strokeWidth={1.5} />;
    default:
      return <ShieldCheck className={MODE_ICON_CLASS} strokeWidth={1.5} />;
  }
}

const SHEET_CHIP_CLASS = 'h-8 px-2 py-1 text-sm';

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
    <div className="flex w-full min-w-0 items-center">
      <div className="min-w-0">
        <div className="w-full">
          <ReplicaMobilePickerTrigger ariaLabel={labels.model} className={SHEET_CHIP_CLASS}>
            <span className="truncate">{modelLabel}</span>
          </ReplicaMobilePickerTrigger>
        </div>
      </div>
      <div className="ml-1 shrink-0">
        <div className="w-full">
          <ReplicaMobilePickerTrigger ariaLabel={labels.thinkLevel} className={SHEET_CHIP_CLASS}>
            <span className="truncate">{thinkLabel}</span>
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
      <div className="flex w-full items-start gap-2">
        <div className="min-w-0">
          <ReplicaMobilePickerTrigger ariaLabel={labels.agent} className={SHEET_CHIP_CLASS}>
            <span className="truncate">{agentLabel}</span>
          </ReplicaMobilePickerTrigger>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="min-w-0">
            <ReplicaMobilePickerTrigger
              ariaLabel={labels.permissionMode}
              className={SHEET_CHIP_CLASS}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-80">
                <PermissionModeIcon mode={permissionMode} />
              </span>
              <span className="truncate">{permissionLabel}</span>
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
      <div className="flex min-w-0 items-stretch gap-3 rounded-xl bg-card px-3 py-1.5 ring-1 ring-border/60">
        <span className="w-16 shrink-0 self-center text-[0.72rem] font-semibold tracking-wide text-muted-foreground">
          {label}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
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
    <div className="flex min-h-0 flex-col bg-background text-foreground">
      <header className="relative flex items-center px-4 pb-2 pt-2">
        <h2 className="mx-auto select-none text-[0.95rem] font-semibold tracking-tight">
          {labels.sheetTitle}
        </h2>
      </header>
      <p className="sr-only">{labels.sheetTitle}</p>
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-4',
          'pb-[calc(12px+max(0px,var(--safe-area-bottom,0px)-var(--native-keyboard-height,0px)))]'
        )}
      >
        <div className="flex flex-col pb-3 pt-1">
          <div className="pt-1.5 first:pt-0">
            <SheetRow label={labels.machine}>
              <ReplicaMobilePickerTrigger ariaLabel={labels.machine}>
                <span className="flex items-center gap-1.5">
                  <Monitor className="h-3.5 w-3.5" />
                  {machineName}
                </span>
              </ReplicaMobilePickerTrigger>
            </SheetRow>
          </div>
          <div className="pt-1.5 first:pt-0">
            <SheetRow label={labels.contextType}>
              <ReplicaMobilePickerTrigger ariaLabel={labels.contextType}>
                <span className="flex items-center gap-1.5">
                  <MessageCircle className="h-3.5 w-3.5" />
                  {labels.chatType}
                </span>
              </ReplicaMobilePickerTrigger>
            </SheetRow>
          </div>
        </div>
        <div className="pt-1">{composer}</div>
        <div className="px-1 pt-2">
          <SheetBelowComposer locale={locale} {...belowComposer} />
        </div>
      </div>
    </div>
  );
}
