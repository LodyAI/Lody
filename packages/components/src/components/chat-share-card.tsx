import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { ensureShareThemeScopes } from '@/components/share-theme-scope';
import lodyLogo from '@/assets/lody-icon.png';

export interface ChatShareCardMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * The card has exactly two forms and the device being shared from picks one;
 * there is no format control and no other appearance switch but light/dark.
 * `phone` is sized to a handset's own content width, so an image opened in a
 * chat thread sets its text at the size the reader's own apps do. `desktop` is
 * wide enough for a ~70-character line of prose and a real line of code, which
 * is what a post or a README needs. They differ in measure and margin only:
 * type sizes are shared, so two cards taken from two devices set the same words
 * at the same size.
 */
export type ChatShareCardFormat = 'phone' | 'desktop';

export interface ChatShareCardMeta {
  /** Runtime/agent display name — the caption's subject. */
  name?: string;
  /** Agent mark for the caption; the Lody mark stands in when absent. */
  icon?: ReactNode;
  /** Model, token estimate, … — the caption's parameter line. */
  params?: string[];
  /** Absolute capture date, printed under the parameters. */
  date?: string;
}

export interface ChatShareCardProps {
  messages: ChatShareCardMessage[];
  title?: string;
  format: ChatShareCardFormat;
  /**
   * Pins the exported palette to a bundled Lody theme rather than following the
   * app: the image must look the way the preview did, whatever the app is
   * themed as by the time the capture runs. Scoped variables come from
   * `ensureShareThemeScopes`; `.light-scope` also opts out of an ancestor
   * `.dark`.
   */
  theme: 'light' | 'dark';
  meta?: ChatShareCardMeta;
  className?: string;
}

interface CardLayout {
  /** Card width in CSS pixels; the backdrop adds `frame` on every side. */
  width: number;
  frame: string;
  radius: string;
  /**
   * The one horizontal inset every band uses — title, conversation and caption
   * share a left edge, and nothing in the card is allowed a private gutter.
   */
  gutter: string;
  /** First band's top inset, whichever band that is. */
  top: string;
  titleSize: string;
  /** Title band to conversation. */
  afterTitle: string;
  /** Conversation to the caption rule. */
  bottom: string;
  /** Between one exchange and the next: the card's largest interior gap. */
  exchangeGap: number;
  /** Between a prompt and the reply it belongs to; half the exchange gap. */
  replyGap: number;
  promptRadius: string;
  promptPad: string;
  captionPad: string;
  /** Card to the sign-off printed on the backdrop below it. */
  signature: string;
}

/**
 * The whole padding system, as two rows rather than values sprinkled through
 * the markup, so "the desktop card breathes more" stays one decision. Every
 * value sits on a 4px grid, and the vertical rhythm is deliberately unequal:
 * the gap that separates two exchanges is twice the gap that binds a prompt to
 * its reply, which is what makes a tall card scannable without speaker labels.
 */
const LAYOUT: Record<ChatShareCardFormat, CardLayout> = {
  phone: {
    width: 360,
    frame: 'p-4',
    radius: 'rounded-[22px]',
    gutter: 'px-5',
    top: 'pt-6',
    titleSize: 'text-[17px]',
    afterTitle: 'pt-4',
    bottom: 'pb-5',
    exchangeGap: 24,
    replyGap: 12,
    promptRadius: 'rounded-[14px]',
    promptPad: 'px-3.5 py-2.5',
    captionPad: 'py-3.5',
    signature: 'mt-4',
  },
  desktop: {
    width: 560,
    frame: 'p-8',
    radius: 'rounded-[26px]',
    gutter: 'px-7',
    top: 'pt-7',
    titleSize: 'text-[20px]',
    afterTitle: 'pt-5',
    bottom: 'pb-6',
    exchangeGap: 28,
    replyGap: 14,
    promptRadius: 'rounded-[16px]',
    promptPad: 'px-4 py-3',
    captionPad: 'py-4',
    signature: 'mt-5',
  },
};

/**
 * The one backdrop. Deep-sea night from the brand mark's palette (#35c8b0 teal,
 * #2f77bf blue, #1f4f7f navy) with a soft horizon glow and a vignette that
 * keeps the edges quiet. It carries both card palettes: a light card reads as
 * paper on it, and a dark one separates on its hairline and shadow.
 */
const BACKDROP: CSSProperties = {
  background:
    'radial-gradient(52% 38% at 18% 12%, rgba(53,200,176,0.45), transparent 70%),' +
    'radial-gradient(48% 36% at 86% 16%, rgba(47,119,191,0.5), transparent 70%),' +
    'radial-gradient(70% 55% at 68% 96%, rgba(31,79,127,0.65), transparent 75%),' +
    'radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(2,10,18,0.55) 100%),' +
    'linear-gradient(165deg, #0a1c2b 0%, #0c2438 55%, #081626 100%)',
};

/** Prose size, fixed for both formats and independent of the app's font-size setting. */
const BODY_FONT_SIZE = 15;

const CODE_SCOPE = 'lody-chat-share-card';

/**
 * Clears the floating language label that the block's own insets do not already
 * account for, plus a little air. Measured against the rendered label rather
 * than derived: it is absolutely positioned against the code block while this
 * padding sits on the `pre` inside the block's and the body's own insets, so the
 * arithmetic is not local to either file. A label that changes height in
 * src/tailwind/index.css changes this.
 */
const CODE_LABEL_CLEARANCE = '1.5rem';

/**
 * Code never overflows a share card: an image has no horizontal scrollbar, so
 * an unwrapped line is simply a line the reader cannot see. Soft-wrapping is a
 * property of the medium, not a preference, so it is not a prop.
 *
 * The language label is an opaque mask parked over the block's top-right corner,
 * which works in the app because a long first line scrolls out from under it. A
 * wrapped line never scrolls, so it would stay masked forever; a labelled block
 * starts its first line below the label instead.
 *
 * The block's copy control goes away: an affordance nobody can press is not
 * something to photograph, and the preview is hoverable, so leaving it in means
 * a captured image can carry a button the reader will try to click.
 *
 * None of these is `!important`: the app's code styles live in
 * `@layer components`, where an important declaration outranks an unlayered one,
 * so the body's important `padding-block` cannot be overridden from here — while
 * its unlayered ordinary declarations win as usual. That is why the wrap and the
 * clearance both land on the `pre`, which carries no important padding.
 */
const CODE_CSS = [
  `.${CODE_SCOPE} .markdown-renderer [data-streamdown=code-block-body] pre` +
    '{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;}',
  `.${CODE_SCOPE} .markdown-renderer [data-streamdown=code-block][data-language]:not([data-language=''])` +
    ` [data-streamdown=code-block-body] pre{padding-block-start:${CODE_LABEL_CLEARANCE};}`,
  `.${CODE_SCOPE} .markdown-renderer [data-streamdown=code-block-actions]{display:none;}`,
].join('');

/**
 * Static, full-height conversation card for capturing a chat as one shareable
 * image. No scrolling container and no virtualization: the card hugs its
 * content, and a long selection simply makes a long image.
 *
 * One fixed template. Every turn is left-aligned against the same gutter — a
 * shared image has no "me" side to hang a bubble from — with the human prompt
 * as a tinted block and the reply as ordinary prose through `MarkdownRenderer`,
 * exactly as a finished turn renders in the app. Provenance is a single caption
 * band at the foot of the card, and the product sign-off prints on the backdrop
 * below it, where it costs the conversation no room.
 */
export function ChatShareCard({
  messages,
  title,
  format,
  theme,
  meta,
  className,
}: ChatShareCardProps) {
  const layout = LAYOUT[format];
  // Injects the scoped theme rules before first paint; idempotent no-op after.
  ensureShareThemeScopes();
  const themeScopeClass = theme === 'light' ? 'light-scope' : 'dark-scope';
  const captionParams = meta?.params?.filter((param) => param.trim().length > 0) ?? [];

  return (
    <div className={cn('w-fit', layout.frame, themeScopeClass, className)} style={BACKDROP}>
      <style>{CODE_CSS}</style>
      <div
        className={cn(
          'relative overflow-hidden bg-card text-card-foreground',
          layout.radius,
          'shadow-[0_28px_70px_-20px_rgba(2,10,18,0.6)]',
          'ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.10]'
        )}
        style={{ width: layout.width }}
      >
        {title ? (
          <div className={cn(layout.gutter, layout.top)}>
            <div
              className={cn(
                layout.titleSize,
                'line-clamp-2 font-semibold leading-snug tracking-tight text-foreground'
              )}
            >
              {title}
            </div>
          </div>
        ) : null}

        <div
          className={cn(
            CODE_SCOPE,
            layout.gutter,
            title ? layout.afterTitle : layout.top,
            layout.bottom
          )}
        >
          {messages.map((message, index) => {
            const previous = index === 0 ? undefined : messages[index - 1];
            // A reply belongs to the prompt above it; anything else opens a new
            // exchange and gets the wider gap.
            const marginTop =
              previous === undefined
                ? 0
                : message.role === 'assistant' && previous.role === 'user'
                  ? layout.replyGap
                  : layout.exchangeGap;
            return (
              <div key={message.id} style={{ marginTop }}>
                {message.role === 'user' ? (
                  <div
                    className={cn(
                      layout.promptRadius,
                      layout.promptPad,
                      'border border-foreground/[0.07] bg-foreground/[0.045]'
                    )}
                  >
                    <div
                      className="whitespace-pre-wrap leading-[1.55] text-foreground [overflow-wrap:anywhere]"
                      style={{ fontSize: BODY_FONT_SIZE }}
                    >
                      {message.text}
                    </div>
                  </div>
                ) : (
                  <MarkdownRenderer text={message.text} size={BODY_FONT_SIZE} isStreaming={false} />
                )}
              </div>
            );
          })}
        </div>

        {/* Caption band, camera-style: the runtime that produced the
            conversation on the left, its parameters and the capture date on the
            right. It carries no brand mark — the backdrop below signs the card. */}
        <div
          className={cn(
            'flex items-center gap-2.5 border-t border-border/70',
            layout.gutter,
            layout.captionPad
          )}
        >
          <div className="shrink-0">
            {meta?.icon ?? <img src={lodyLogo} alt="" className="size-5 scale-[1.64] rounded-md" />}
          </div>
          <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {meta?.name ?? 'Lody'}
          </div>
          {captionParams.length > 0 || meta?.date ? (
            <div className="min-w-0 max-w-[62%] text-right">
              {captionParams.length > 0 ? (
                <div className="truncate text-[12px] font-medium text-foreground">
                  {captionParams.join(' · ')}
                </div>
              ) : null}
              {meta?.date ? (
                <div className="mt-0.5 truncate text-[10.5px] leading-tight text-muted-foreground">
                  {meta.date}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={cn(layout.signature, 'flex items-center justify-center gap-2')}>
        <img src={lodyLogo} alt="" className="size-4 scale-[1.64] rounded" />
        <span className="text-[12px] font-medium tracking-wide text-white/85">lody.ai</span>
      </div>
    </div>
  );
}
