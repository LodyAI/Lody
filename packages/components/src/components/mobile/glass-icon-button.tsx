import { forwardRef, useEffect, useRef, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';

import {
  themeDuration,
  themeEasing,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

/**
 * Circular "glass" icon button for the mobile floating session header.
 *
 * The glass disc is drawn once on a small canvas (no CSS filters, no SVG
 * displacement, no background capture — cheap and fully cross-browser).
 *
 * Light theme (reference liquid-glass chrome): cool pale-gray filled disc
 * with a soft vertical/radial gradient (lighter top-center → slightly
 * deeper gray toward the rim) and a feathered edge — not a hollow
 * stroke-only ring on white.
 *
 * Dark theme: translucent fill derived from the button's computed
 * foreground color, with a vertical specular rim.
 *
 * A MutationObserver on <html> redraws on theme flips. Touch target stays
 * 44px (a11y); `discSize` is the visible glass circle. No drop shadow.
 */

type GlassMode = 'light' | 'dark';

const styles = stylex.create({
  button: {
    position: 'relative',
    display: 'inline-flex',
    height: themeSpace[11],
    width: themeSpace[11],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    /* Light: one solid near-black for every glyph (matches reference).
       Dark: soft foreground on the translucent glass — the `dark:`
       variant stays a Tailwind class, because StyleX cannot select a
       `.dark` ancestor. */
    color: '#1c1c1e',
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[200],
    transitionTimingFunction: themeEasing.out,
    transform: {
      default: 'none',
      ':hover': 'scale(1.05)',
      ':active': 'scale(1.25)',
    },
  },
  disc: {
    position: 'absolute',
    pointerEvents: 'none',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    borderRadius: themeRadius.full,
  },
  canvas: {
    transitionProperty: 'opacity',
    transitionDuration: themeDuration[200],
    transitionTimingFunction: themeEasing['in-out'],
  },
  pressed: {
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: themeDuration[200],
    transitionTimingFunction: themeEasing['in-out'],
    backgroundColor: '#f3f3f5',
  },
  content: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'currentColor',
  },
});

function resolveMode(): GlassMode {
  if (typeof document === 'undefined') return 'light';
  const root = document.documentElement;
  if (root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark') {
    return 'dark';
  }
  return 'light';
}

/** "r,g,b" from the element's computed color; white fallback for dark glass. */
function resolveRgb(el: HTMLElement): string {
  const m = getComputedStyle(el).color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? `${m[1]},${m[2]},${m[3]}` : '255,255,255';
}

const DARK = { fillA: 0.085, topA: 0.22, botA: 0.14, rim: 0.1, spread: 0.4 };

function drawDarkGlass(ctx: CanvasRenderingContext2D, size: number, rgb: string) {
  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${rgb},${DARK.fillA})`;
  ctx.fill();

  const off = document.createElement('canvas');
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  off.width = off.height = size * dpr;
  const octx = off.getContext('2d');
  if (!octx) return;
  octx.scale(dpr, dpr);

  const rg = octx.createRadialGradient(r, r, r * (1 - DARK.rim), r, r, r - 0.5);
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
  vg.addColorStop(0, `rgba(255,255,255,${DARK.topA})`);
  vg.addColorStop(DARK.spread, 'rgba(255,255,255,0)');
  vg.addColorStop(1 - DARK.spread, 'rgba(255,255,255,0)');
  vg.addColorStop(1, `rgba(255,255,255,${DARK.botA})`);
  octx.fillStyle = vg;
  octx.fillRect(0, 0, size, size);

  ctx.drawImage(off, 0, 0, size, size);
}

/**
 * Light chrome matching the ChatGPT-style circular chips (sampled from
 * the reference screenshot).
 *
 * Measured radial luminance on the reference (0–255, disc ≈ r72):
 *   r0  ≈ 253  (center bright)
 *   r30 ≈ 250  (mid, a hair cooler)
 *   r66 ≈ 247  (near-edge soft gray)
 *   r74 ≈ 253  (outer lip bright again → page)
 * Total swing is only ~5–7 levels. Larger amplitude reads as cheap plastic.
 *
 * Structure: 亮 → 灰 → 亮 as a single absolute-color radial (no stacked
 * alpha washes that over-darken). Soft rim via gradient, not a hard stroke.
 */
function drawLightGlass(ctx: CanvasRenderingContext2D, size: number) {
  const r = size / 2;
  const discR = r - 0.5;

  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, discR, 0, Math.PI * 2);
  ctx.clip();

  /* Absolute radial profile — gray amplitude ~half of prior pass.
     Stops stay very near white (#FB–#FE). */
  const body = ctx.createRadialGradient(r, r, 0, r, r, discR);
  body.addColorStop(0.0, 'rgb(254, 254, 254)'); /* center bright */
  body.addColorStop(0.28, 'rgb(253, 253, 253)');
  body.addColorStop(0.5, 'rgb(252, 252, 252)'); /* mid barely cooler */
  body.addColorStop(0.72, 'rgb(251, 251, 252)');
  body.addColorStop(0.86, 'rgb(250, 250, 251)'); /* soft gray band (halved) */
  body.addColorStop(0.94, 'rgb(252, 252, 253)'); /* brighten toward lip */
  body.addColorStop(1.0, 'rgb(253, 253, 254)'); /* outer bright lip */
  ctx.beginPath();
  ctx.arc(r, r, discR, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();

  /* Extra light at top/bottom (reference bands are slightly wider there). */
  const vertical = ctx.createLinearGradient(0, 0, 0, size);
  vertical.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  vertical.addColorStop(0.2, 'rgba(255, 255, 255, 0)');
  vertical.addColorStop(0.8, 'rgba(255, 255, 255, 0)');
  vertical.addColorStop(1, 'rgba(255, 255, 255, 0.16)');
  ctx.beginPath();
  ctx.arc(r, r, discR, 0, Math.PI * 2);
  ctx.fillStyle = vertical;
  ctx.fill();

  /* Left/right edges — half the prior side vignette strength. */
  const sides = ctx.createLinearGradient(0, 0, size, 0);
  sides.addColorStop(0, 'rgba(150, 154, 164, 0.05)');
  sides.addColorStop(0.18, 'rgba(150, 154, 164, 0.015)');
  sides.addColorStop(0.5, 'rgba(150, 154, 164, 0)');
  sides.addColorStop(0.82, 'rgba(150, 154, 164, 0.015)');
  sides.addColorStop(1, 'rgba(150, 154, 164, 0.05)');
  ctx.beginPath();
  ctx.arc(r, r, discR, 0, Math.PI * 2);
  ctx.fillStyle = sides;
  ctx.fill();

  ctx.restore();

  /* Soft rim — half prior opacity. */
  const rimW = Math.max(0.75, size * 0.018);
  ctx.beginPath();
  ctx.arc(r, r, discR - rimW / 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(140, 144, 154, 0.1)';
  ctx.lineWidth = rimW;
  ctx.stroke();
}

function drawGlassDisc(canvas: HTMLCanvasElement, discSize: number, mode: GlassMode, rgb: string) {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  canvas.width = discSize * dpr;
  canvas.height = discSize * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, discSize, discSize);

  if (mode === 'light') {
    drawLightGlass(ctx, discSize);
  } else {
    drawDarkGlass(ctx, discSize, rgb);
  }
}

export const GlassIconButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    onClick?: () => void;
    children: ReactNode;
    className?: string;
    /** Visible glass circle diameter; the touch target stays 44px. */
    discSize?: number;
  }
>(function GlassIconButton({ label, onClick, children, className, discSize = 36 }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const draw = () => {
      const mode = resolveMode();
      const host = buttonRef.current ?? canvas.parentElement;
      const rgb = host instanceof HTMLElement ? resolveRgb(host) : '255,255,255';
      drawGlassDisc(canvas, discSize, mode, rgb);
      /* No drop shadow — liquid glass rim is enough; extra shadow
         muddies the disc on light chrome. */
      canvas.style.boxShadow = 'none';
    };

    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, [discSize]);

  /* `group` / `group-active:*` and the `dark:` variants stay Tailwind: they
     select a PARENT's state or a `.dark` ancestor, which StyleX cannot
     express. Everything else on the button is StyleX. */
  const buttonClassName = [
    stylex.props(styles.button).className,
    'group',
    'dark:text-foreground/90',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={(node) => {
        buttonRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={buttonClassName}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={`${stylex.props(styles.disc, styles.canvas).className} group-active:opacity-0`}
        style={{
          width: discSize,
          height: discSize,
        }}
      />
      {/* Pressed solid disc — slightly deeper cool gray than rest fill. */}
      <span
        aria-hidden="true"
        className={`${stylex.props(styles.disc, styles.pressed).className} group-active:opacity-100 dark:bg-foreground/15`}
        style={{ width: discSize, height: discSize }}
      />
      <span {...stylex.props(styles.content)}>{children}</span>
    </button>
  );
});
