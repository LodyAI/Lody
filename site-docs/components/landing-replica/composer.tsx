import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowUp, MousePointer2, Plus, X } from 'lucide-react';
import { Button } from './button';
import type { ReplicaLocale, ReplicaVisualAnnotation } from './types';
import { cn } from './utils';
import { ConversationColumn } from './chat-stream';

/* Display-only replica of the app's chat composer, desktop chat landing and the
   selector triggers around them (triggers live in ./composer-controls).
   Sources: chat/chat-composer.tsx, chat/web-chat-landing-screen.tsx and
   chat/visual-annotation-reference-chip.tsx. Only the closed/resting states the
   landing demos show are carried; menus, hover-only affordances and keyboard
   handling are dropped. */

export type ReplicaComposerVariant = 'landing' | 'session' | 'mobile-session' | 'mobile-sheet';

// ---- Layout shells ------------------------------------------------------------

/** `getSessionChatInputAreaShellClassName()`: the docked composer band. */
const COMPOSER_SHELL_CLASS =
  'relative shrink-0 pt-0 mb-[var(--native-keyboard-height,0px)] transition-[margin-bottom] duration-[250ms] ease-out pb-[calc(0.5rem+max(0px,env(safe-area-inset-bottom,0px)-var(--native-keyboard-height,0px)))] bg-background';

/** Desktop chat landing (`WebChatLandingScreen`, non-Electron path). */
export function ReplicaChatLandingView({
  title,
  composer,
}: {
  title: string;
  composer: ReactNode;
}) {
  return (
    <div className="relative flex h-full w-full flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-auto px-4">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground">{title}</h1>
        </div>
        <div className={COMPOSER_SHELL_CLASS}>
          <ConversationColumn className="@container">{composer}</ConversationColumn>
        </div>
      </div>
    </div>
  );
}

// ---- Composer -----------------------------------------------------------------

/* Per-variant textarea sizing. The desktop chat landing mounts ChatComposer as
   `variant="session"` with 2 rows / max 11; the session reply composer keeps the
   3-row default / max 5; mobile session composers are forced to one row. */
const VARIANT_CONFIG: Record<
  ReplicaComposerVariant,
  { id: string; rows: number; maxRows: number; mobile: boolean }
> = {
  landing: { id: 'chat-prompt', rows: 2, maxRows: 11, mobile: false },
  session: { id: 'landing-session-reply', rows: 3, maxRows: 5, mobile: false },
  'mobile-session': { id: 'landing-mobile-session-reply', rows: 1, maxRows: 5, mobile: true },
  'mobile-sheet': { id: 'landing-mobile-new-chat', rows: 1, maxRows: 6, mobile: true },
};

/* The copy the app resolves for each surface: the landing's command/mention
   hint, the session's base placeholder, and the compact placeholder the app
   switches to when the composer box is ≤440px wide (every phone frame). */
const DEFAULT_PLACEHOLDER: Record<ReplicaComposerVariant, Record<ReplicaLocale, string>> = {
  landing: {
    en: "Press '/' for commands, '@' for mentions.",
    zh: "按 '/' 使用命令，'@' 添加提及。",
  },
  session: { en: 'Message the agent...', zh: '给 Agent 发消息...' },
  'mobile-session': { en: 'Ask anything', zh: '随便问点什么' },
  'mobile-sheet': { en: 'Ask anything', zh: '随便问点什么' },
};

const TEXTAREA_CLASS =
  'input-scrollbar resize-none text-sm leading-6 transition-shadow border-transparent bg-transparent px-1 py-0 focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 text-input-foreground placeholder:text-input-placeholder/40';

const BOX_CLASS =
  '@container/composer-box flex flex-col gap-1 rounded-xl border px-2 py-1.5 transition-colors duration-150 border-foreground/[0.10] bg-[hsl(var(--composer))] shadow-[0_3px_6px_-2px_lch(0%_0_0/0.02),0_1px_1px_lch(0%_0_0/0.04)] dark:shadow-none dark:border-input-border/70 dark:bg-input/90 [--mention-chip-surface:hsl(var(--composer))] dark:[--mention-chip-surface:color-mix(in_srgb,hsl(var(--input))_90%,hsl(var(--background)))] group relative';

export type ReplicaComposerProps = {
  variant: ReplicaComposerVariant;
  /** Controlled prompt text; ghost scripts type by updating this. */
  value: string;
  /** Defaults to the copy the app shows for the variant in `locale`. */
  placeholder?: string;
  /** Row above the box (machine / project / branch pills). Landing only. */
  topSelector?: ReactNode;
  /** Footer controls left of the send chip (run config, permission, …). */
  footer?: ReactNode;
  /** Usually a `ReplicaSendButton` of the same variant. */
  primaryAction: ReactNode;
  /** Staged Browser-preview comments, shown as chips above the textarea. */
  annotations?: ReplicaVisualAnnotation[];
  /** Show the "+" attachment trigger (the landing currently wires none). */
  showAttachmentButton?: boolean;
  locale: ReplicaLocale;
};

export function ReplicaComposer({
  variant,
  value,
  placeholder,
  topSelector,
  footer,
  primaryAction,
  annotations = [],
  showAttachmentButton = false,
  locale,
}: ReplicaComposerProps) {
  const config = VARIANT_CONFIG[variant];
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Same auto-resize rule as ChatComposer: clamp scrollHeight between the row
  // floor and maxRows, ignoring the placeholder while empty.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const style = getComputedStyle(textarea);
    const lineHeight = parseInt(style.lineHeight || '24', 10) || 24;
    const padding =
      (parseInt(style.paddingTop, 10) || 0) + (parseInt(style.paddingBottom, 10) || 0);
    const minHeight = lineHeight * config.rows + padding;
    const maxHeight = lineHeight * config.maxRows + padding;
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const height =
      value.length > 0 ? Math.max(minHeight, Math.min(scrollHeight, maxHeight)) : minHeight;
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [config.maxRows, config.rows, value]);

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-col gap-1">
        {topSelector ? (
          <div className="flex w-full min-w-0 select-none items-center gap-1">{topSelector}</div>
        ) : null}
        <div className={BOX_CLASS}>
          {annotations.length > 0 ? (
            <div className="flex flex-wrap gap-2 pb-1">
              {annotations.map((annotation, index) => (
                <ReplicaVisualAnnotationChip key={index} annotation={annotation} />
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            id={config.id}
            readOnly
            value={value}
            rows={config.rows}
            placeholder={placeholder ?? DEFAULT_PLACEHOLDER[variant][locale]}
            className={cn(TEXTAREA_CLASS, config.mobile ? 'min-h-[24px]' : 'min-h-[48px]')}
            data-keyboard-nav="composer"
          />
          <div className="flex select-none items-center gap-x-1.5 pt-0.5">
            {showAttachmentButton ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Add attachment"
                className={cn(
                  config.mobile ? 'size-9' : 'size-7',
                  'rounded-full text-foreground transition-colors hover:bg-hover hover:text-foreground'
                )}
              >
                <Plus strokeWidth={1.5} className={config.mobile ? 'size-6' : 'size-4'} />
              </Button>
            ) : null}
            <div className="@container/composer-face flex min-w-0 flex-1 flex-nowrap items-center gap-x-1.5 overflow-hidden">
              {footer}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">{primaryAction}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Per-surface send chips as the landing wires them: the chat landing's filled
   disc, the session composer's tinted square, the mobile session's larger disc
   and the new-chat sheet's larger tinted square. */
const SEND_CLASS: Record<ReplicaComposerVariant, string> = {
  landing:
    'h-7 w-7 rounded-full shadow-xs transition-all bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px] focus-visible:ring-ring focus-visible:ring-offset-background',
  session:
    'h-7 w-7 rounded-md border shadow-xs transition-all border-primary/[0.28] bg-primary/[0.14] text-foreground hover:bg-primary/[0.22] hover:text-foreground active:translate-y-[1px]',
  'mobile-session':
    'h-8 w-8 rounded-full shadow-xs transition-all bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]',
  'mobile-sheet':
    'h-8 w-8 rounded-md border shadow-xs transition-all border-primary/[0.25] bg-primary/[0.15] text-foreground hover:bg-primary/[0.25] hover:text-foreground active:translate-y-[1px]',
};

export function ReplicaSendButton({
  variant,
  disabled,
}: {
  variant: ReplicaComposerVariant;
  disabled: boolean;
}) {
  const large = variant === 'mobile-session' || variant === 'mobile-sheet';
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      aria-label="Send"
      className={SEND_CLASS[variant]}
    >
      <ArrowUp className={large ? 'h-5 w-5' : 'h-4 w-4'} />
    </Button>
  );
}

/** `VisualAnnotationReferenceChip` with a remove handler (hover-only X). */
function ReplicaVisualAnnotationChip({ annotation }: { annotation: ReplicaVisualAnnotation }) {
  const firstLine = annotation.body.split('\n')[0] ?? annotation.body;
  const preview = firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 39)}…`;
  return (
    <div
      data-visual-annotation-ref
      className="group/chip relative flex max-w-64 flex-col gap-0.5 rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs"
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <MousePointer2 className="h-3 w-3 shrink-0" />
        {/* The demo annotates the preview's root page, so the app's pathname is `/`. */}
        <span className="truncate font-medium">/ · {annotation.tag.toLowerCase()}</span>
        <button
          type="button"
          aria-label="Remove visual annotation reference"
          className="pointer-events-none ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground/60 opacity-0 transition-opacity"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="truncate text-foreground/70">&ldquo;{preview}&rdquo;</div>
      <div className="truncate font-mono text-[10px] text-muted-foreground">
        {annotation.selector}
      </div>
    </div>
  );
}

export {
  getModeIcon,
  ReplicaBranchWorktreePill,
  ReplicaMachineMenuTrigger,
  ReplicaMobileRunConfigTrigger,
  ReplicaPermissionModeTrigger,
  ReplicaProjectSelectorTrigger,
  ReplicaRunConfigTrigger,
} from './composer-controls';
