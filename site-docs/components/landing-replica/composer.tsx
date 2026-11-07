import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowUp, MousePointer2, Plus, X } from 'lucide-react';
import { Button } from './button';
import type { ReplicaLocale, ReplicaVisualAnnotation } from './types';
import { ConversationColumn } from './chat-stream';
const previewStyles = stylex.create({
  stack: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flex: '1',
    'flex-direction': 'column',
    overflow: 'hidden',
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  stack2: {
    position: 'relative',
    display: 'flex',
    'min-height': '0px',
    flex: '1',
    'flex-direction': 'column',
  },
  stack3: {
    display: 'flex',
    'min-height': '0px',
    flex: '1',
    'flex-direction': 'column',
    'align-items': 'center',
    'justify-content': 'center',
    gap: 'calc(var(--spacing) * 5)',
    overflow: 'auto',
    'padding-inline': 'calc(var(--spacing) * 4)',
  },
  text: {
    'font-size': 'var(--text-4xl)',
    'line-height': 'var(--text-4xl--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-tight)',
    color: 'hsl(var(--foreground))',
  },
  section: {
    position: 'relative',
    'margin-bottom': 'var(--native-keyboard-height,0px)',
    'flex-shrink': '0',
    'background-color': 'hsl(var(--background))',
    'padding-top': '0px',
    'padding-bottom':
      'calc(0.5rem + max(0px, env(safe-area-inset-bottom,0px) - var(--native-keyboard-height,0px)))',
    'transition-property': 'margin-bottom',
    'transition-timing-function': 'var(--ease-out)',
    'transition-duration': '250ms',
  },
  section2: {
    containerType: 'inline-size',
  },
  stack4: {
    display: 'flex',
    width: '100%',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  stack5: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
  },
  row: {
    display: 'flex',
    width: '100%',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'var(--spacing)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  stack6: {
    'container-type': 'inline-size',
    'container-name': 'composer-box',
    position: 'relative',
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    'background-color': 'hsl(var(--composer))',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 3px 6px -2px lch(0% 0 0/0.02), 0 1px 1px lch(0% 0 0/0.04)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '150ms',
    '--mention-chip-surface': 'hsl(var(--composer))',
    ':where(.dark, .dark *)': {
      'border-color': 'color-mix(in oklab, hsl(var(--input-border)) 70%, transparent)',
      'background-color': 'color-mix(in oklab, hsl(var(--input)) 90%, transparent)',
      'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000',
      '--mention-chip-surface': 'color-mix(in srgb,hsl(var(--input)) 90%,hsl(var(--background)))',
    },
  },
  row2: {
    display: 'flex',
    'flex-wrap': 'wrap',
    gap: 'calc(var(--spacing) * 2)',
    'padding-bottom': 'var(--spacing)',
  },
  text2: {
    resize: 'none',
    'border-color': 'transparent',
    'background-color': 'transparent',
    'padding-inline': 'var(--spacing)',
    'padding-block': '0px',
    'font-size': 'var(--text-sm)',
    'line-height': 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--input-foreground))',
    'transition-property': 'box-shadow',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '::placeholder': {
      color: 'color-mix(in oklab, hsl(var(--input-placeholder)) 40%, transparent)',
    },
    ':focus-visible': {
      'box-shadow':
        '0 0 #0000, 0 0 #0000, 0 0 0 0px #fff, 0 0 0 calc(0px + 0px) currentcolor, 0 0 #0000',
      'outline-style': 'none',
    },
  },
  section3: {
    'min-height': '24px',
  },
  section4: {
    'min-height': '48px',
  },
  row3: {
    display: 'flex',
    'align-items': 'center',
    'column-gap': 'calc(var(--spacing) * 1.5)',
    'padding-top': 'calc(var(--spacing) * 0.5)',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  row4: {
    'container-type': 'inline-size',
    'container-name': 'composer-face',
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'flex-wrap': 'nowrap',
    'align-items': 'center',
    'column-gap': 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
  },
  row5: {
    'margin-left': 'auto',
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  stack7: {
    position: 'relative',
    display: 'flex',
    'max-width': 'calc(var(--spacing) * 64)',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 0.5)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 50%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  row6: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    color: 'hsl(var(--muted-foreground))',
  },
  frame: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    'flex-shrink': '0',
  },
  section5: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-weight': 'var(--font-weight-medium)',
  },
  row7: {
    'pointer-events': 'none',
    'margin-left': 'auto',
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-xs)',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 60%, transparent)',
    opacity: '0%',
    'transition-property': 'opacity',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  frame2: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
  text3: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 70%, transparent)',
  },
  text4: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-family': 'var(--font-mono)',
    'font-size': '10px',
    color: 'hsl(var(--muted-foreground))',
  },
});

const buttonStyles = stylex.create({
  attachment: {
    borderRadius: 'calc(infinity * 1px)',
    color: {
      default: 'hsl(var(--foreground))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--foreground))' },
    },
    backgroundColor: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--hover))' },
    },
  },
  desktopAttach: { height: 'calc(var(--spacing) * 7)', width: 'calc(var(--spacing) * 7)' },
  mobileAttach: { height: 'calc(var(--spacing) * 9)', width: 'calc(var(--spacing) * 9)' },
  send: { transitionProperty: 'all', translate: { default: null, ':active': '0 1px' } },
});

/* Display-only replica of the app's chat composer, desktop chat landing and the
   selector triggers around them (triggers live in ./composer-controls).
   Sources: chat/chat-composer.tsx, chat/web-chat-landing-screen.tsx and
   chat/visual-annotation-reference-chip.tsx. Only the closed/resting states the
   landing demos show are carried; menus, hover-only affordances and keyboard
   handling are dropped. */

export type ReplicaComposerVariant = 'landing' | 'session' | 'mobile-session' | 'mobile-sheet';

// ---- Layout shells ------------------------------------------------------------

/** `getSessionChatInputAreaShellClassName()`: the docked composer band. */

/** Desktop chat landing (`WebChatLandingScreen`, non-Electron path). */
export function ReplicaChatLandingView({
  title,
  composer,
}: {
  title: string;
  composer: ReactNode;
}) {
  return (
    <div data-power-demo-layout="fill" {...stylex.props(previewStyles.stack)}>
      <div {...stylex.props(previewStyles.stack2)}>
        <div data-landing-scroll-region {...stylex.props(previewStyles.stack3)}>
          <h2 {...stylex.props(previewStyles.text)}>{title}</h2>
        </div>
        <div {...stylex.props(previewStyles.section)}>
          <ConversationColumn xstyle={previewStyles.section2}>{composer}</ConversationColumn>
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
    <div {...stylex.props(previewStyles.stack4)}>
      <div {...stylex.props(previewStyles.stack5)}>
        {topSelector ? <div {...stylex.props(previewStyles.row)}>{topSelector}</div> : null}
        <div className={['group', stylex.props(previewStyles.stack6).className].join(' ')}>
          {annotations.length > 0 ? (
            <div {...stylex.props(previewStyles.row2)}>
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
            className={[
              'input-scrollbar',
              stylex.props(
                previewStyles.text2,
                config.mobile ? previewStyles.section3 : previewStyles.section4
              ).className,
            ].join(' ')}
            data-keyboard-nav="composer"
          />
          <div {...stylex.props(previewStyles.row3)}>
            {showAttachmentButton ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Add attachment"
                xstyle={[
                  buttonStyles.attachment,
                  config.mobile ? buttonStyles.mobileAttach : buttonStyles.desktopAttach,
                ]}
                iconSize={config.mobile ? 'calc(var(--spacing) * 6)' : 'calc(var(--spacing) * 4)'}
              >
                <Plus strokeWidth={1.5} />
              </Button>
            ) : null}
            <div {...stylex.props(previewStyles.row4)}>{footer}</div>
            <div {...stylex.props(previewStyles.row5)}>{primaryAction}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Per-surface send chips as the landing wires them: the chat landing's filled
   disc, the session composer's tinted square, the mobile session's larger disc
   and the new-chat sheet's larger tinted square. */
const sendStyles = stylex.create({
  landing: {
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: {
      default: 'hsl(var(--foreground))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab,hsl(var(--foreground)) 90%,transparent)',
      },
    },
    color: {
      default: 'hsl(var(--background))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--background))' },
    },
  },
  session: {
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    borderRadius: 'var(--radius-md)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab,hsl(var(--primary)) 28%,transparent)',
    backgroundColor: {
      default: 'color-mix(in oklab,hsl(var(--primary)) 14%,transparent)',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab,hsl(var(--primary)) 22%,transparent)',
      },
    },
    color: {
      default: 'hsl(var(--foreground))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--foreground))' },
    },
  },
  'mobile-session': {
    height: 'calc(var(--spacing) * 8)',
    width: 'calc(var(--spacing) * 8)',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: {
      default: 'hsl(var(--foreground))',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab,hsl(var(--foreground)) 90%,transparent)',
      },
    },
    color: {
      default: 'hsl(var(--background))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--background))' },
    },
  },
  'mobile-sheet': {
    height: 'calc(var(--spacing) * 8)',
    width: 'calc(var(--spacing) * 8)',
    borderRadius: 'var(--radius-md)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab,hsl(var(--primary)) 25%,transparent)',
    backgroundColor: {
      default: 'color-mix(in oklab,hsl(var(--primary)) 15%,transparent)',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab,hsl(var(--primary)) 25%,transparent)',
      },
    },
    color: {
      default: 'hsl(var(--foreground))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--foreground))' },
    },
  },
});

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
      xstyle={[buttonStyles.send, sendStyles[variant]]}
      iconSize={large ? 'calc(var(--spacing) * 5)' : 'calc(var(--spacing) * 4)'}
      shadow="xs"
    >
      <ArrowUp />
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
      className={['group/chip', stylex.props(previewStyles.stack7).className].join(' ')}
    >
      <div {...stylex.props(previewStyles.row6)}>
        <MousePointer2 {...stylex.props(previewStyles.frame)} />
        {/* The demo annotates the preview's root page, so the app's pathname is `/`. */}
        <span {...stylex.props(previewStyles.section5)}>/ · {annotation.tag.toLowerCase()}</span>
        <button
          type="button"
          aria-label="Remove visual annotation reference"
          {...stylex.props(previewStyles.row7)}
        >
          <X {...stylex.props(previewStyles.frame2)} />
        </button>
      </div>
      <div {...stylex.props(previewStyles.text3)}>&ldquo;{preview}&rdquo;</div>
      <div {...stylex.props(previewStyles.text4)}>{annotation.selector}</div>
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
