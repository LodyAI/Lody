import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { ensureChatShareThemeScopes } from '@/components/chat-share-theme-scope';
import lodyLogo from '@/assets/lody-icon.png';

export interface ChatShareCardMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatShareCardCodeOptions {
  /** Soft-wrap long code lines instead of letting them overflow horizontally. */
  wrap?: boolean;
  /** Collapse code blocks taller than this many rendered lines; 0/undefined keeps full height. */
  collapseAfter?: number;
}

/** Gradient canvas presets behind the card. `none` removes only the canvas. */
export type ChatShareCardBackdrop = 'none' | 'lody' | 'aurora' | 'ocean' | 'sunset';

/** Footer layout: centered stack, single row with QR at the end, or minimal line with the QR floating in the card corner. */
export type ChatShareCardFooterVariant = 'stacked' | 'row' | 'minimal' | 'canvas' | 'exif';

export interface ChatShareCardProps {
  messages: ChatShareCardMessage[];
  title?: string;
  /** URL encoded into the footer QR code. */
  shareUrl?: string;
  code?: ChatShareCardCodeOptions;
  /** Gradient frame around the card; becomes part of the exported image. */
  backdrop?: ChatShareCardBackdrop;
  /** Breathing room between card and frame edge; `regular` when unset. */
  framePadding?: 'compact' | 'regular' | 'spacious';
  footerVariant?: ChatShareCardFooterVariant;
  /** Renders the footer QR code where the variant has one (`stacked`/`row`/`canvas`). */
  showQr?: boolean;
  /**
   * Pins the card to one of the bundled Lody palettes (lody-light / vesper)
   * instead of following the app theme — the exported image should look the
   * way the user picked, not the way the app happens to be themed right now.
   * Scoped variables come from `ensureChatShareThemeScopes`; `.light-scope`
   * also opts out of any ancestor `.dark`.
   */
  theme?: 'light' | 'dark';
  /** EXIF-style caption for the `exif` footer: a bold device/model line and a
      mono parameter line (turns, tokens, date, …), camera-frame style. `icon`
      replaces the Lody mark — e.g. pass an `AgentIcon` for the driving agent. */
  meta?: { title?: string; params?: string[]; sub?: string; icon?: ReactNode };
  className?: string;
}

const DEFAULT_SHARE_URL = 'https://lody.ai';
/** Matches the markdown code block metrics in src/tailwind/index.css (0.75rem × 1.4). */
const CODE_LINE_HEIGHT_PX = 16.8;

const FRAME_PADDING_CLASSES: Record<NonNullable<ChatShareCardProps['framePadding']>, string> = {
  compact: 'p-8',
  regular: 'p-14 sm:p-16',
  spacious: 'p-20 sm:p-24',
};

const BACKDROP_STYLES: Record<Exclude<ChatShareCardBackdrop, 'none'>, CSSProperties> = {
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
  aurora: {
    background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 45%, #db2777 100%)',
  },
  ocean: {
    background: 'linear-gradient(135deg, #0369a1 0%, #0891b2 50%, #34d399 100%)',
  },
  sunset: {
    background: 'linear-gradient(135deg, #9a3412 0%, #ea580c 45%, #f59e0b 100%)',
  },
};

/**
 * Static, full-height conversation card for capturing a chat as one shareable
 * image. No scrolling container, no virtualization: the card hugs its content.
 * Turns are avatar-free; user bubbles reuse the exact `UserPlainTextBlock`
 * chrome from `ai-gui/view.tsx`, assistant prose renders through
 * `MarkdownRenderer` exactly like a finished turn.
 *
 * The card uses an opaque theme surface so its text remains readable without
 * a backdrop. The footer carries the Lody brand and an optional QR code.
 */
export function ChatShareCard({
  messages,
  title,
  shareUrl = DEFAULT_SHARE_URL,
  code,
  backdrop = 'none',
  framePadding = 'regular',
  footerVariant = 'stacked',
  showQr = true,
  theme,
  meta,
  className,
}: ChatShareCardProps) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!showQr || footerVariant === 'minimal' || footerVariant === 'exif') {
      setQrDataUrl(null);
      return undefined;
    }
    let cancelled = false;
    QRCode.toDataURL(shareUrl, {
      margin: 0,
      width: 160,
      errorCorrectionLevel: 'M',
      color: { dark: '#101828', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shareUrl, footerVariant, showQr]);

  const wrap = code?.wrap ?? false;
  const collapseAfter = code?.collapseAfter ?? 0;

  // Collapse over-tall code blocks post-render: MarkdownRenderer owns the code
  // DOM and Shiki re-renders the lines in async passes, and Storybook arg
  // changes re-render the whole block — either one can wipe styles/nodes we
  // injected. So every observed mutation re-derives the collapsed state from
  // scratch: restore all bodies first, then clip those still over the limit.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = contentRef.current;
    if (!root || collapseAfter <= 0) return undefined;

    let applying = false;
    let raf = 0;

    const resetBody = (body: HTMLElement) => {
      body.style.maxHeight = '';
      body.style.overflow = '';
      body.style.position = '';
      body.querySelectorAll('[data-share-collapse-ui]').forEach((node) => node.remove());
    };

    const applyCollapse = () => {
      if (applying) return;
      applying = true;
      try {
        root
          .querySelectorAll<HTMLElement>("[data-streamdown='code-block-body']")
          .forEach((body) => {
            resetBody(body);
            const lines = body.querySelectorAll('pre > code > span').length;
            if (lines <= collapseAfter) return; // 0 = highlight not painted yet; observer revisits

            body.style.maxHeight = `${Math.round(collapseAfter * CODE_LINE_HEIGHT_PX)}px`;
            body.style.overflow = 'hidden';
            body.style.position = 'relative';

            const fade = document.createElement('div');
            fade.dataset.shareCollapseUi = 'true';
            fade.style.cssText =
              'position:absolute;inset-inline:0;bottom:0;height:44px;pointer-events:none;' +
              'background:linear-gradient(to bottom, transparent, var(--markdown-code-block-bg, rgba(16,24,40,0.04)) 75%);';
            const pill = document.createElement('div');
            pill.dataset.shareCollapseUi = 'true';
            pill.style.cssText =
              'position:absolute;inset-inline:0;bottom:6px;display:flex;justify-content:center;pointer-events:none;';
            const label = document.createElement('span');
            label.style.cssText =
              'font-size:11px;line-height:1;padding:4px 10px;border-radius:9999px;' +
              'background:hsl(var(--muted));color:hsl(var(--muted-foreground));';
            label.textContent = t('chatShareCard.collapsedLines', { count: lines - collapseAfter });
            pill.appendChild(label);
            body.appendChild(fade);
            body.appendChild(pill);
          });
      } finally {
        applying = false;
      }
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(applyCollapse);
    };

    schedule();
    const observer = new MutationObserver(() => {
      if (!applying) schedule();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      root.querySelectorAll<HTMLElement>("[data-streamdown='code-block-body']").forEach(resetBody);
    };
  }, [collapseAfter, messages, t]);

  const framed = backdrop !== 'none';
  // Injects the scoped theme rules before first paint; idempotent no-op after.
  ensureChatShareThemeScopes();
  const themeScopeClass =
    theme === 'light' ? 'light-scope' : theme === 'dark' ? 'dark-scope' : undefined;

  const card = (
    <div
      className={cn(
        'relative w-[420px] overflow-hidden',
        themeScopeClass,
        framed
          ? // Solid card on a gradient canvas, ray.so-style: big soft shadow, no glass.
            'rounded-2xl border border-black/[0.06] bg-card text-card-foreground shadow-[0_24px_64px_-16px_rgba(0,0,0,0.45)] dark:border-white/10'
          : // Keep the theme surface opaque even without a surrounding canvas.
            cn(
              'rounded-[20px] border border-black/[0.08] bg-card',
              'shadow-[0_16px_48px_-12px_rgba(16,24,40,0.18),inset_0_1px_0_rgba(255,255,255,0.7)]',
              'dark:border-white/[0.09] dark:shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)]',
              'text-card-foreground'
            ),
        className
      )}
    >
      {wrap ? (
        <style>
          {
            '.lody-chat-share-card-wrap .markdown-renderer [data-streamdown=code-block-body] pre { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }'
          }
        </style>
      ) : null}

      {/* Header: small brand row on top, then the session title as a real
          document-style headline so it carries the image. */}
      <div className="px-6 pt-5">
        <div className="flex items-center gap-2">
          <img src={lodyLogo} alt="" className="size-3.5 scale-[1.64] rounded-md" />
          <span className="text-sm font-semibold">Lody</span>
        </div>
        {title ? (
          <div className="mt-3 text-lg font-semibold leading-snug tracking-tight text-foreground">
            {title}
          </div>
        ) : null}
      </div>

      <div
        ref={contentRef}
        className={cn('px-6 pt-4 pb-5 space-y-4', wrap && 'lody-chat-share-card-wrap')}
      >
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="flex max-w-full justify-end">
              <div className="min-w-0 max-w-full rounded-[1.15rem] border border-foreground/[0.08] bg-foreground/[0.05] px-3.5 py-2">
                <div className="min-w-0 max-w-full whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">
                  {message.text}
                </div>
              </div>
            </div>
          ) : (
            <MarkdownRenderer key={message.id} text={message.text} isStreaming={false} />
          )
        )}
      </div>

      {/* Footer: three layouts — centered stack, single row, or minimal line
          with the QR floating at the card's bottom-right corner. */}
      {footerVariant === 'stacked' && (
        <div
          className={cn(
            'flex flex-col items-center gap-2.5 px-5 pt-5 pb-6 text-center',
            framed
              ? 'border-t border-border'
              : 'border-t border-black/[0.05] bg-white/35 backdrop-blur-xl dark:border-white/[0.07] dark:bg-white/[0.04]'
          )}
        >
          <img src={lodyLogo} alt="" className="size-7 scale-[1.64] rounded-md" />
          <div className="text-[13px] font-medium text-muted-foreground">lody.ai</div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('chatShareCard.qrAlt')}
              className="mt-0.5 size-10 rounded-md bg-white p-1 dark:bg-white/90"
            />
          ) : null}
        </div>
      )}

      {footerVariant === 'row' && (
        <div
          className={cn(
            'flex items-center gap-3 px-5 py-2.5',
            framed
              ? 'border-t border-border'
              : 'border-t border-black/[0.05] bg-white/35 backdrop-blur-xl dark:border-white/[0.07] dark:bg-white/[0.04]'
          )}
        >
          <img src={lodyLogo} alt="" className="size-5 scale-[1.64] rounded-md" />
          <div className="min-w-0 flex-1 -mt-0.5 text-[13px] font-medium text-muted-foreground">
            lody.ai
          </div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('chatShareCard.qrAlt')}
              className="size-9 rounded-md bg-white p-1 dark:bg-white/90"
            />
          ) : null}
        </div>
      )}

      {/* EXIF caption, camera-style: brand + device left, bold spec line and
          muted sub-line right. No QR — the caption band stays clean. */}
      {footerVariant === 'exif' && (
        <div
          style={{
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
          }}
          className={cn(
            'flex items-center gap-2.5 px-6 py-3.5',
            // Camera-caption band: brighter than the conversation surface.
            framed
              ? 'border-t border-border bg-white dark:bg-white/[0.04]'
              : 'border-t border-black/[0.05] bg-white/70 backdrop-blur-xl dark:border-white/[0.07] dark:bg-white/[0.04]'
          )}
        >
          {meta?.icon ?? <img src={lodyLogo} alt="" className="size-5 scale-[1.64] rounded-md" />}
          <div className="min-w-0 truncate text-[13px] font-semibold text-foreground">
            {meta?.title ?? 'Lody'}
          </div>
          <div className="ml-auto min-w-0 text-right">
            {meta?.params && meta.params.length > 0 ? (
              <div className="flex items-baseline justify-end gap-2.5 truncate text-[12px] font-medium text-foreground">
                {meta.params.map((param) => (
                  <span key={param} className="shrink-0">
                    {param}
                  </span>
                ))}
              </div>
            ) : null}
            {meta?.sub ? (
              <div className="mt-0.5 truncate text-[10.5px] leading-tight text-muted-foreground">
                {meta.sub}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* `canvas` moves branding onto the gradient frame (see below); inside
          the card it falls back to the minimal line when there is no frame. */}
      {(footerVariant === 'minimal' || (footerVariant === 'canvas' && !framed)) && (
        <div
          className={cn(
            'flex items-center justify-center gap-1.5 px-5 py-3',
            framed
              ? 'border-t border-border'
              : 'border-t border-black/[0.05] dark:border-white/[0.07]'
          )}
        >
          <img src={lodyLogo} alt="" className="size-3.5 scale-[1.64] rounded-md" />
          <span className="text-[11px] text-muted-foreground">lody.ai</span>
        </div>
      )}
    </div>
  );

  if (!framed) return card;

  return (
    <div
      className={cn(FRAME_PADDING_CLASSES[framePadding], themeScopeClass)}
      style={BACKDROP_STYLES[backdrop]}
    >
      {card}
      {footerVariant === 'canvas' ? (
        <div className="mt-8 flex items-center justify-center gap-2.5">
          <img src={lodyLogo} alt="" className="size-5 scale-[1.64] rounded-md" />
          <span className="text-[13px] font-medium tracking-wide text-white/85">lody.ai</span>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('chatShareCard.qrAlt')}
              className="ml-2 size-9 rounded-md bg-white p-1 shadow-[0_2px_10px_rgba(0,0,0,0.25)]"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
