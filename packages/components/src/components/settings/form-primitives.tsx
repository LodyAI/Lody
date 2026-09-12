import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';
import { Label } from '@/ui/label';
import { Textarea, type TextareaProps } from '@/ui/textarea';

/**
 * The shared grammar of the settings editors.
 *
 * Every settings form — MCP connection, Agent Role — is the same stack of
 * bordered sections holding labelled fields, so the spacing and typography live
 * here once. A local copy per editor is how three dialogs that are supposed to
 * look like one surface drift apart one padding value at a time.
 */

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/70 bg-card/60 p-3">
      <header>
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {hint ? (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/90">{hint}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export function Field({
  htmlFor,
  label,
  hint,
  icon,
  children,
}: {
  /** Associates the label with a control that owns an id; omit for a group. */
  htmlFor?: string;
  label: string;
  hint?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <Label htmlFor={htmlFor} className="text-xs font-medium">
          {label}
        </Label>
      </div>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * An inline message inside a settings editor.
 *
 * `error` blocks the save that is about to be attempted; `warning` states a
 * consequence the author should read before saving. Both carry the icon, so a
 * reader who cannot see the tint still gets the signal.
 */
export function FormMessage({
  tone,
  children,
  className,
}: {
  tone: 'error' | 'warning';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-snug',
        tone === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-status-warning/30 bg-status-warning/10 text-foreground/90',
        className
      )}
    >
      <AlertTriangle
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          tone === 'error' ? 'text-destructive' : 'text-status-warning'
        )}
        aria-hidden="true"
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * A one-line field that becomes as tall as the text put in it.
 *
 * Multi-line values are allowed but rare — a variable default is usually a few
 * words — so the field starts at a single row and grows with the content
 * instead of reserving space for lines nobody wrote. It scrolls once it reaches
 * `maxRows`, and never shows a resize handle: the height is the content's.
 */
export function AutoGrowTextarea({
  value,
  maxRows = 8,
  className,
  ...props
}: Omit<TextareaProps, 'rows' | 'value'> & { value: string; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    const styles = window.getComputedStyle(element);
    // A layout-less environment (jsdom) reports '' for these; a NaN height would
    // be written to the style attribute and silently dropped.
    const px = (style: string) => (Number.isFinite(parseFloat(style)) ? parseFloat(style) : 0);
    const lineHeight = px(styles.lineHeight) || 16;
    const paddingY = px(styles.paddingTop) + px(styles.paddingBottom);
    const borderY = px(styles.borderTopWidth) + px(styles.borderBottomWidth);
    const maxHeight = lineHeight * maxRows + paddingY + borderY;
    const content = element.scrollHeight + borderY;
    if (content <= 0) return;
    element.style.height = `${Math.min(content, maxHeight)}px`;
    element.style.overflowY = content > maxHeight ? 'auto' : 'hidden';
  }, [maxRows]);

  // Layout effect: a saved multi-line value must render at its full height,
  // not flash one row and then jump.
  useLayoutEffect(resize, [resize, value]);
  // Re-measure on width changes; wrapping is what decides the row count, and a
  // field inside a dialog can be measured before the dialog has its width.
  const lastWidth = useRef(-1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    lastWidth.current = element.clientWidth;
    return observeResizeOnAnimationFrame(element, () => {
      if (element.clientWidth === lastWidth.current) return;
      lastWidth.current = element.clientWidth;
      resize();
    });
  }, [resize]);

  return (
    <Textarea
      ref={ref}
      rows={1}
      value={value}
      className={cn('resize-none', className)}
      {...props}
    />
  );
}
