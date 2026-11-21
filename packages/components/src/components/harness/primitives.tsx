/*
 * Small building blocks shared by every harness panel. The design draws these
 * itself; the styles are `parts.ts` and the tokens are the sheet's own, so a
 * row, a tag or a mark looks the same wherever it appears.
 *
 * The product's actions, keys, switches, spinners and inputs are the design
 * system's: a control it already owns is not redrawn here.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy } from 'lucide-react';
import { SiXiaomi } from 'react-icons/si';

import { AnthropicIcon } from '@/components/icons/anthropic-icon';
import { DeepSeekIcon } from '@/components/icons/deepseek-icon';
import { GlmIcon } from '@/components/icons/glm-icon';
import { MinimaxIcon } from '@/components/icons/minimax-icon';
import { OpenAIIcon } from '@/components/icons/openai-icon';
import {
  Button as AtomButton,
  Kbd as AtomKbd,
  Spinner as AtomSpinner,
  Switch as AtomSwitch,
  type ButtonProps as AtomButtonProps,
} from '@lody/ui';

import type { DeviceKind, DeviceStatus, Provider } from './catalog';
import { parts } from './parts';

export const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;
export const soft = { type: 'spring', stiffness: 260, damping: 30 } as const;

/**
 * The actions are the product's own button: the sheet owns its layout, spacing
 * and material, but a control the design system already has is not redrawn.
 */
type ButtonProps = Omit<AtomButtonProps, 'variant' | 'size'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger';
  size?: 'sm' | 'md' | 'lg';
};

const BUTTON_VARIANT = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  accent: 'primary',
  danger: 'destructive',
} as const;

const BUTTON_SIZE = { sm: 'small', md: 'medium', lg: 'large' } as const;

export function Button({ variant = 'secondary', size = 'md', ...rest }: ButtonProps) {
  return (
    <AtomButton
      variant={BUTTON_VARIANT[variant]}
      size={BUTTON_SIZE[size]}
      {...(rest as AtomButtonProps)}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <AtomKbd>{children}</AtomKbd>;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <AtomSwitch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next)}
      />
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  disabled = false,
}: {
  /** `null` selects nothing: no option is checked and the thumb hides. */
  value: T | null;
  options: { id: T; label: ReactNode }[];
  onChange: (next: T) => void;
  label: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  const { containerRef, register, box } = useSlidingSelection(value);
  return (
    <div
      ref={containerRef}
      {...stylex.props(parts.seg, disabled && parts.segDisabled)}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      <SelectionIndicator box={disabled ? null : box} variant="thumb" radius={6} />
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            ref={register(option.id)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            {...stylex.props(
              parts.segItem,
              size === 'sm' && parts.segItemSm,
              active && parts.segItemActive
            )}
            onClick={() => onChange(option.id)}
          >
            <span {...stylex.props(parts.segLabel)}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A group's selection indicator.
 *
 * The indicator belongs to the *container*, not to the selected item: one
 * absolutely-positioned layer that measures the active item and travels there.
 * A shared-layout element would be re-parented into each item instead, which
 * puts it inside that item's stacking context and clipping box — the reason a
 * ring could disappear under its neighbours when the selection moved backwards.
 */
export function useSlidingSelection(active: string | null) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef(new Map<string, HTMLElement>());
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null
  );

  const measure = useCallback(() => {
    const container = containerRef.current;
    const item = active ? itemsRef.current.get(active) : null;
    if (!container || !item) {
      setBox(null);
      return;
    }
    const outer = container.getBoundingClientRect();
    const inner = item.getBoundingClientRect();
    setBox({
      x: inner.left - outer.left,
      y: inner.top - outer.top,
      width: inner.width,
      height: inner.height,
    });
  }, [active]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    for (const item of itemsRef.current.values()) observer.observe(item);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  const register = useCallback(
    (id: string) => (element: HTMLElement | null) => {
      if (element) itemsRef.current.set(id, element);
      else itemsRef.current.delete(id);
    },
    []
  );

  return { containerRef, register, box };
}

export function SelectionIndicator({
  box,
  variant = 'pill',
  radius,
}: {
  box: { x: number; y: number; width: number; height: number } | null;
  /**
   * `pill` is a tab's selection: a tint on the page. `thumb` is a segmented
   * control's: a raised chip on a sunken track. `ring` is a card's: accent.
   */
  variant?: 'pill' | 'thumb' | 'ring';
  radius?: number | string;
}) {
  return (
    <motion.span
      {...stylex.props(
        variant === 'ring' ? parts.ring : variant === 'thumb' ? parts.thumb : parts.pill
      )}
      aria-hidden="true"
      initial={false}
      animate={
        box
          ? { x: box.x, y: box.y, width: box.width, height: box.height, opacity: 1 }
          : { opacity: 0 }
      }
      transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.7 }}
      style={{ borderRadius: radius }}
    />
  );
}

export function StatusDot({ status }: { status: DeviceStatus | 'live' }) {
  return (
    <span
      aria-hidden="true"
      {...stylex.props(
        parts.dot,
        status === 'online'
          ? parts.dotOnline
          : status === 'idle'
            ? parts.dotIdle
            : status === 'live'
              ? parts.dotLive
              : null
      )}
    />
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  // The atom sizes itself by step; the sheet only ever asked for two of them.
  return <AtomSpinner size={size >= 16 ? 'medium' : 'small'} />;
}

/** A check that draws itself in; used for every "done" moment. */
export function DrawnCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <motion.path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.35, ease: [0.65, 0, 0.35, 1], delay: 0.05 }}
      />
    </svg>
  );
}

/**
 * The provider's own mark where the product has one — the same glyph the agent
 * picker and every session avatar draw — and the tinted letter for a provider
 * that has none (a custom endpoint, a local runtime).
 */
const PROVIDER_GLYPHS: Record<string, (props: { className?: string }) => ReactNode> = {
  deepseek: DeepSeekIcon,
  mimo: ({ className }) => <SiXiaomi className={className} aria-hidden="true" />,
  minimax: MinimaxIcon,
  glm: GlmIcon,
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
};

export function ProviderMark({ provider, size = 28 }: { provider: Provider; size?: number }) {
  const Glyph = PROVIDER_GLYPHS[provider.id];
  const glyph = stylex.props(parts.markGlyph);
  return (
    <span
      aria-hidden="true"
      {...stylex.props(parts.mark)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.44,
        ['--tint' as string]: provider.tint,
      }}
    >
      {Glyph ? <Glyph className={glyph.className} /> : provider.mark}
    </span>
  );
}

/** Line drawings of each device kind, drawn on a 48-unit grid. */
export function DeviceGlyph({ kind, size = 20 }: { kind: DeviceKind; size?: number }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const fill = stylex.props(parts.glyphFill).className;
  return (
    <svg
      {...stylex.props(parts.glyph)}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
    >
      {kind === 'laptop' && (
        <>
          <rect x="9" y="11" width="30" height="20" rx="3" className={fill} {...common} />
          <path d="M5 36h38l-2.5 3.5h-33z" className={fill} {...common} />
          <path d="M21 34.5h6" {...common} />
        </>
      )}
      {kind === 'desktop' && (
        <>
          <rect x="7" y="9" width="34" height="23" rx="3" className={fill} {...common} />
          <path d="M20 32l-1.5 6h11L28 32M16 38.5h16" {...common} />
        </>
      )}
      {kind === 'server' && (
        <>
          <rect x="8" y="9" width="32" height="12" rx="3" className={fill} {...common} />
          <rect x="8" y="27" width="32" height="12" rx="3" className={fill} {...common} />
          <path d="M14 15h6M14 33h6" {...common} />
          <circle cx="33" cy="15" r="1.2" fill="currentColor" />
          <circle cx="33" cy="33" r="1.2" fill="currentColor" />
        </>
      )}
      {kind === 'cloud' && (
        <path
          d="M14.5 36.5h20a8 8 0 0 0 1-15.9 11 11 0 0 0-21.2 2.6A6.7 6.7 0 0 0 14.5 36.5z"
          className={fill}
          {...common}
        />
      )}
    </svg>
  );
}

export function useCopy(timeout = 1600) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), timeout);
    return () => window.clearTimeout(timer);
  }, [copied, timeout]);
  return {
    copied,
    copy: (text: string) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      setCopied(true);
    },
  };
}

export function CopyIcon({ copied }: { copied: boolean }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={copied ? 'y' : 'n'}
        {...stylex.props(parts.copyIcon)}
        initial={{ opacity: 0, scale: 0.6, filter: 'blur(2px)' }}
        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, scale: 0.6, filter: 'blur(2px)' }}
        transition={{ duration: 0.16 }}
      >
        {copied ? <Check size={13} strokeWidth={2.4} /> : <Copy size={13} />}
      </motion.span>
    </AnimatePresence>
  );
}

/** Copies what it is given, and shows that it did for a moment. */
export function CopyButton({
  text,
  label,
  onCopied,
}: {
  text: string;
  label: string;
  onCopied?: () => void;
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      aria-label={label}
      {...stylex.props(parts.iconBtn)}
      onClick={() => {
        copy(text);
        onCopied?.();
      }}
    >
      <CopyIcon copied={copied} />
    </button>
  );
}

/** Label + hint on the left, control on the right. */
export function Row({
  title,
  hint,
  children,
  badge,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div {...stylex.props(parts.row)}>
      <div>
        <div {...stylex.props(parts.rowTitle)}>
          {title}
          {badge}
        </div>
        {hint ? <div {...stylex.props(parts.rowHint)}>{hint}</div> : null}
      </div>
      <div {...stylex.props(parts.rowControl)}>{children}</div>
    </div>
  );
}
