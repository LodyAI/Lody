import { useEffect, useMemo, useState } from 'react';

import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';

import type { FabricRecipe } from './fabric-recipe';
import { FabricSimulator, type FabricLight } from './fabric-simulator';

const styles = stylex.create({
  /**
   * The cloth sits behind the panel it decorates: it covers the whole box and
   * never takes the pointer.
   */
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    pointerEvents: 'none',
    zIndex: -10,
  },
});

/**
 * Theme-derived fabric decor for the sidebar: a low-amplitude woven backdrop
 * behind the whole panel plus a clearer worsted-twill band for the footer.
 * Both derive their yarn colours from `--sidebar-background` so they follow
 * VS Code themes, and render statically (no animation loop); the band's
 * light follows the pointer while hovering the footer.
 */

type Hsl = [number, number, number];

/** Parse the `--sidebar-background` HSL channel triplet, e.g. "222 55% 9.6%". */
function readSidebarHsl(): Hsl | null {
  if (typeof window === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-background');
  const m = raw.trim().match(/^([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = Math.min(Math.max(s, 0), 100) / 100;
  const ln = Math.min(Math.max(l, 0), 100) / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Live sidebar background colour; tracks theme swaps on <html>. */
function useSidebarBackgroundHsl(): Hsl | null {
  const [hsl, setHsl] = useState<Hsl | null>(readSidebarHsl);
  useEffect(() => {
    const update = () =>
      setHsl((prev) => {
        const next = readSidebarHsl();
        if (prev && next && prev[0] === next[0] && prev[1] === next[1] && prev[2] === next[2]) {
          return prev;
        }
        return next;
      });
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return hsl;
}

/**
 * Both layers are the same cloth at different finish levels: the backdrop is
 * the flannel-ised (raised, blurred) version, the footer band the
 * clear-finished worsted version. `d` flips the tint direction so threads
 * stay slightly-light-on-dark for dark themes and vice versa.
 */
function backdropRecipe([h, s, l]: Hsl): FabricRecipe {
  // Light themes get compressed by the shader tonemap and perceive darker
  // threads much more strongly, so the tint deltas shrink there.
  const d = l < 50 ? 1 : -0.55;
  return {
    fiber: {
      alignment: 0.9,
      melangeColors: [hslToHex(h, s, l + d * 4.5), hslToHex(h, s, l - d * 1.5)],
      melange: 0.4,
    },
    yarn: {
      twist: 0.55,
      twistDirection: 'Z',
      radiusWarp: 0.48,
      radiusWeft: 0.48,
      slub: 0.08,
      hairiness: 0.1,
      yarnVariation: 0.12,
    },
    weave: {
      pattern: 'twill-2-2',
      threadPx: 4,
      crimp: 0.3,
      flatten: 0.6,
      warpColors: [hslToHex(h, s, l + d * 2.2)],
      weftColors: [hslToHex(h, s, l - d * 1)],
    },
    finish: { milling: 0.25, raising: 0.45, pressing: 0.5 },
  };
}

function bandRecipe([h, s, l]: Hsl): FabricRecipe {
  const d = l < 50 ? 1 : -0.55;
  return {
    fiber: {
      alignment: 0.92,
      melangeColors: [hslToHex(h, s, l + d * 6), hslToHex(h, s, l - d * 2)],
      melange: 0.2,
    },
    yarn: {
      twist: 0.6,
      twistDirection: 'Z',
      radiusWarp: 0.48,
      radiusWeft: 0.48,
      slub: 0.06,
      hairiness: 0.08,
      yarnVariation: 0.1,
    },
    weave: {
      pattern: 'twill-2-2',
      threadPx: 5,
      crimp: 0.5,
      flatten: 0.5,
      warpColors: [hslToHex(h, s, l + d * 4)],
      weftColors: [hslToHex(h, s, l - d * 1.8)],
    },
    finish: { milling: 0.1, raising: 0.05, pressing: 0.7 },
  };
}

/**
 * The shader tonemap (col/(1+0.6col)) compresses bright outputs, so light
 * themes need proportionally more light to keep the panel at its token
 * lightness; dark themes use the base values unchanged.
 */
function lightnessBoost(l: number): number {
  return 1 + (l / 100) ** 1.5 * 1.7;
}

function backdropLight(l: number): FabricLight {
  const k = lightnessBoost(l);
  return { x: 0, y: 0.4, z: 1.1, intensity: 0.4 * k, size: 0.8, ambient: 0.95 * k };
}

function bandLight(l: number): FabricLight {
  const k = lightnessBoost(l);
  return { x: 0, y: 0.15, z: 0.65, intensity: 1.3 * k, size: 0.35, ambient: 0.7 * k };
}

function usePrefersReducedMotion(): boolean {
  return useMemo(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false),
    []
  );
}

/** Whisper-plus woven texture behind the whole sidebar. */
export function SidebarFabricBackdrop({ className }: { className?: string }) {
  const hsl = useSidebarBackgroundHsl();
  const recipe = useMemo(() => (hsl ? backdropRecipe(hsl) : null), [hsl]);
  const light = useMemo(() => (hsl ? backdropLight(hsl[2]) : null), [hsl]);
  if (!recipe || !light) return null;
  const layerProps = stylex.props(styles.layer);
  return (
    <div aria-hidden {...layerProps} className={clsx(layerProps.className, className)}>
      <FabricSimulator recipe={recipe} light={light} className="pointer-events-none" />
    </div>
  );
}

/**
 * Clear-finished worsted band for the sidebar footer. The parent element
 * should be `relative` and carry `data-fabric-pointer-scope` so the sheen
 * follows the pointer across the footer (skipped under reduced motion).
 */
export function SidebarFabricBand({ className }: { className?: string }) {
  const hsl = useSidebarBackgroundHsl();
  const reducedMotion = usePrefersReducedMotion();
  const recipe = useMemo(() => (hsl ? bandRecipe(hsl) : null), [hsl]);
  const light = useMemo(() => (hsl ? bandLight(hsl[2]) : null), [hsl]);
  if (!recipe || !light) return null;
  const layerProps = stylex.props(styles.layer);
  return (
    <div aria-hidden {...layerProps} className={clsx(layerProps.className, className)}>
      <FabricSimulator
        recipe={recipe}
        light={light}
        followPointer={!reducedMotion}
        className="pointer-events-none"
      />
    </div>
  );
}
