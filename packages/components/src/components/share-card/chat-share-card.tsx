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
 * The card's own size, which is a content decision: it sets the measure, so it
 * decides how much prose fits on a line and whether a line of code survives
 * without wrapping. It is discrete because the useful answers are, and because
 * a measure is not something to nudge.
 *
 * `chat` is 360pt — a handset's own content width, so an image opened in a
 * message thread sets its text at the size the reader's other apps set theirs.
 * `post` is 560pt — room for a ~70-character line of prose and a real line of
 * code, which is what a feed, a README or a slide wants.
 *
 * Named for where the image is going rather than for a number, because the
 * width is chosen by how the image will be read, and the person exporting knows
 * that. It also seeds the mat, which is then free.
 *
 * The device doing the exporting decides nothing here. It used to, as a proxy
 * for the destination, which was wrong in both directions: a desktop user
 * sending a card into a group chat got a wide card, and a phone user posting to
 * a feed got a narrow one.
 *
 * The two differ in measure and interior scale only — type sizes are shared —
 * so a chat card and a post card set the same words at the same size.
 */
export type ChatShareCardDestination = 'chat' | 'post';

/**
 * How much ground shows around the card, in CSS pixels, and the one dimension of
 * this template that is continuous. It is not a taste the card can guess: a
 * 560pt card flush in a README wants none of it and the same card on a feed
 * wants a lot, and both are the same destination. `mat` is what the preview's
 * slider writes.
 */
export const MIN_MAT = 0;
export const MAX_MAT = 96;
/** The slider lands on the same 4px grid every other dimension sits on. */
export const MAT_STEP = 4;

/**
 * Below this the ground is a hairline rather than a margin, and a sign-off
 * printed on it would sit on the image's own edge. The card signs itself in the
 * caption instead — the same fallback a card with no ground at all takes.
 */
export const MIN_SIGN_OFF_MAT = 12;

/** Where the slider starts for each size; both are a deliberate, ordinary look. */
export const DEFAULT_MAT: Record<ChatShareCardDestination, number> = {
  chat: 16,
  post: 56,
};

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
  /** The card's own size; also what the caller seeded `mat` from. */
  destination: ChatShareCardDestination;
  /** Ground showing around the card, in px. Ignored when `backdrop` is `none`. */
  mat: number;
  /**
   * Pins the exported palette to a bundled Lody theme rather than following the
   * app: the image must look the way the preview did, whatever the app is
   * themed as by the time the capture runs. Scoped variables come from
   * `ensureShareThemeScopes`; `.light-scope` also opts out of an ancestor
   * `.dark`.
   */
  theme: 'light' | 'dark';
  /** Canvas printed behind the card; `none` exports the card on its own corners. */
  backdrop: ChatShareCardBackdrop;
  meta?: ChatShareCardMeta;
  className?: string;
}

interface CardLayout {
  /** Card width in CSS pixels; the mat adds to it on every side. */
  width: number;
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
 * Every interior dimension of both cards, as two rows rather than values
 * sprinkled through the markup, so "a post breathes more than a message" stays
 * one decision instead of a dozen. The mat is deliberately not in here: it is
 * the one continuous dimension and the caller owns it.
 *
 * Every value sits on a 4px grid, and the vertical rhythm is deliberately
 * unequal: the gap that separates two exchanges is twice the gap that binds a
 * prompt to its reply, which is what makes a tall card scannable without
 * speaker labels.
 */
const LAYOUT: Record<ChatShareCardDestination, CardLayout> = {
  chat: {
    width: 360,
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
  post: {
    width: 560,
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
 * The canvas the card is printed on. It is part of the exported image, not a
 * border added around it, and it is the one thing about the card the user still
 * picks: the rest of the template is fixed, so this choice cannot make a card
 * that reads differently, only one that reads against a different ground.
 * `none` prints the card alone, on its own corners.
 */
export type ChatShareCardBackdrop = 'none' | 'lody' | 'aurora' | 'ocean' | 'sunset' | 'welcome';

export const CHAT_SHARE_BACKDROPS: ChatShareCardBackdrop[] = [
  'none',
  'lody',
  'welcome',
  'aurora',
  'ocean',
  'sunset',
];

export const CHAT_SHARE_BACKDROP_STYLES: Record<
  Exclude<ChatShareCardBackdrop, 'none'>,
  CSSProperties
> = {
  // Signature: deep-sea night base with teal/blue aurora blooms from the brand
  // mark's palette (#35c8b0 teal, #2f77bf blue, #1f4f7f navy), a soft horizon
  // glow at the bottom, and a vignette to keep the edges quiet.
  lody: {
    background:
      'radial-gradient(52% 38% at 18% 12%, rgba(53,200,176,0.45), transparent 70%),' +
      'radial-gradient(48% 36% at 86% 16%, rgba(47,119,191,0.5), transparent 70%),' +
      'radial-gradient(70% 55% at 68% 96%, rgba(31,79,127,0.65), transparent 75%),' +
      'radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(2,10,18,0.55) 100%),' +
      'linear-gradient(165deg, #0a1c2b 0%, #0c2438 55%, #081626 100%)',
  },
  // Export-safe still of the opening ceremony's shallow-water field, and the one
  // light ground in the set. The live onboarding scene is a WebGL shader, which
  // a DOM PNG capture cannot faithfully serialize, so this is hand-built rather
  // than sampled and has no other home in the product.
  welcome: {
    background:
      'linear-gradient(90deg, rgba(25,58,68,.14) 1px, transparent 1px),' +
      'radial-gradient(ellipse at 18% 18%, rgba(255,255,255,.58), transparent 46%),' +
      'radial-gradient(ellipse at 82% 72%, rgba(42,93,111,.13), transparent 56%),' +
      'linear-gradient(180deg, rgba(255,255,255,.2), rgba(33,68,79,.06)),' +
      '#dce5e7',
    backgroundSize: '88px 100%, auto, auto, auto, auto',
  },
  aurora: { background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 45%, #db2777 100%)' },
  ocean: { background: 'linear-gradient(135deg, #0369a1 0%, #0891b2 50%, #34d399 100%)' },
  sunset: { background: 'linear-gradient(135deg, #9a3412 0%, #ea580c 45%, #f59e0b 100%)' },
};

/**
 * The sign-off prints white on every gradient because all five are dark enough
 * to carry it — except `welcome`, which is a pale shallow-water ground and needs
 * the ink the other way round.
 */
const LIGHT_BACKDROPS = new Set<ChatShareCardBackdrop>(['welcome']);

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
 * Wrapping needs `width` reset as well as `min-width`, because of one block that
 * sets both. A fenced `diff` renders through `MarkdownDiffBlock`, whose `pre`
 * takes `width: max-content` so a wide patch can scroll inside the app. Relaxing
 * only `min-width` leaves that `width` intact, and `max-content` under
 * `pre-wrap` is still the widest line — so the block kept its full unwrapped
 * width, pushed past the card's fixed edge, and was clipped by the card's own
 * `overflow-hidden` rather than wrapping. Found in review, not in a screenshot:
 * none of the stories had a `diff` fence.
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
    '{width:auto;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;}',
  `.${CODE_SCOPE} .markdown-renderer [data-streamdown=code-block][data-language]:not([data-language=''])` +
    ` [data-streamdown=code-block-body] pre{padding-block-start:${CODE_LABEL_CLEARANCE};}`,
  `.${CODE_SCOPE} .markdown-renderer [data-streamdown=code-block-actions]{display:none;}`,
].join('');

/**
 * Static, full-height conversation card for capturing a chat as one shareable
 * image. No scrolling container and no virtualization: the card hugs its
 * content, and a long selection simply makes a long image.
 *
 * One fixed template in two sizes, chosen by where the image is going. Every
 * turn is left-aligned against the same gutter — a
 * shared image has no "me" side to hang a bubble from — with the human prompt
 * as a tinted block and the reply as ordinary prose through `MarkdownRenderer`,
 * exactly as a finished turn renders in the app. Provenance is a single caption
 * band at the foot of the card; the product sign-off prints on the backdrop
 * below it, where it costs the conversation no room, and falls back into the
 * caption when the user exports without one.
 */
export function ChatShareCard({
  messages,
  title,
  destination,
  mat,
  theme,
  backdrop,
  meta,
  className,
}: ChatShareCardProps) {
  const layout = LAYOUT[destination];
  const matPx = backdrop === 'none' ? 0 : Math.max(MIN_MAT, mat);
  // The sign-off needs a margin to sign in. Without a ground, or with one too
  // thin to hold a line of type off the image's edge, it moves into the caption.
  const signOffOnMat = backdrop !== 'none' && matPx >= MIN_SIGN_OFF_MAT;
  // Injects the scoped theme rules before first paint; idempotent no-op after.
  ensureShareThemeScopes();
  const themeScopeClass = theme === 'light' ? 'light-scope' : 'dark-scope';
  const captionParams = meta?.params?.filter((param) => param.trim().length > 0) ?? [];

  const card = (
    <>
      <style>{CODE_CSS}</style>
      <div
        className={cn(
          'relative overflow-hidden bg-card text-card-foreground',
          layout.radius,
          // A drop shadow needs a ground to fall on. Without one — or with a mat
          // too thin to catch it — it would only darken the image's own edge.
          matPx >= MIN_SIGN_OFF_MAT && 'shadow-[0_28px_70px_-20px_rgba(2,10,18,0.6)]',
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
            right. The brand mark is normally the ground's job; a card with no
            ground, or too thin a one to sign, takes the sign-off onto the second
            line of the left column rather than a band of its own. */}
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
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              {meta?.name ?? 'Lody'}
            </div>
            {signOffOnMat ? null : (
              <div className="mt-0.5 truncate text-[10.5px] leading-tight text-muted-foreground">
                lody.ai
              </div>
            )}
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
    </>
  );

  // Without a ground there is nothing to inset from and nothing to sign on: the
  // card itself is the whole exported image. Its width still follows the
  // destination.
  if (backdrop === 'none') {
    return <div className={cn('w-fit', themeScopeClass, className)}>{card}</div>;
  }

  return (
    <div
      className={cn('w-fit', themeScopeClass, className)}
      style={{ ...CHAT_SHARE_BACKDROP_STYLES[backdrop], padding: matPx }}
    >
      {card}
      {!signOffOnMat ? null : (
        <div className={cn(layout.signature, 'flex items-center justify-center gap-2')}>
          <img src={lodyLogo} alt="" className="size-4 scale-[1.64] rounded" />
          <span
            className={cn(
              'text-[12px] font-medium tracking-wide',
              LIGHT_BACKDROPS.has(backdrop) ? 'text-[rgba(32,66,76,0.78)]' : 'text-white/85'
            )}
          >
            lody.ai
          </span>
        </div>
      )}
    </div>
  );
}
