import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Field as UiField } from '@lody/ui/field';
import { Textarea, type TextareaProps } from '@lody/ui/textarea';
import { settingsSurface as surface } from './surface';

const styles = stylex.create({
  field: { display: 'flex', flexDirection: 'column', gap: space[1.5] },
  fieldHead: { display: 'flex', alignItems: 'center', gap: space[1.5] },
  fieldIcon: { display: 'inline-flex', color: colors.secondaryLabel },
  fieldHint: { margin: 0, fontSize: '11px', lineHeight: 1.375, color: colors.secondaryLabel },
  /**
   * A message is a tint and a mark, never a box: the tone mixed into the
   * surface at the strength `@lody/ui` gives a message, no border around it.
   */
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: '12px',
    lineHeight: 1.375,
  },
  messageError: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 10%)`,
    color: colors.destructive,
  },
  messageWarning: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 10%)`,
    color: colors.label,
  },
  mark: { flexShrink: 0, width: '14px', height: '14px', marginTop: '2px' },
  markError: { color: colors.destructive },
  markWarning: { color: colors.warning },
  messageBody: { minWidth: 0 },
});

/**
 * The shared grammar of the settings editors.
 *
 * Every settings form — MCP connection, Agent Role — is the same stack of
 * titled groups holding labelled fields, so the spacing and typography live
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
    <section {...stylex.props(surface.formGroup)}>
      <header>
        <h3 {...stylex.props(surface.formGroupTitle)}>{title}</h3>
        {hint ? <p {...stylex.props(surface.formGroupHint)}>{hint}</p> : null}
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
    <div {...stylex.props(styles.field)}>
      <div {...stylex.props(styles.fieldHead)}>
        {icon ? <span {...stylex.props(styles.fieldIcon)}>{icon}</span> : null}
        <UiField.Label htmlFor={htmlFor}>{label}</UiField.Label>
      </div>
      {children}
      {hint ? <p {...stylex.props(styles.fieldHint)}>{hint}</p> : null}
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
      {...withClassName(
        stylex.props(
          styles.message,
          tone === 'error' ? styles.messageError : styles.messageWarning
        ),
        className
      )}
    >
      <AlertTriangle
        {...stylex.props(styles.mark, tone === 'error' ? styles.markError : styles.markWarning)}
        aria-hidden="true"
      />
      <div {...stylex.props(styles.messageBody)}>{children}</div>
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
    const computed = window.getComputedStyle(element);
    // A layout-less environment (jsdom) reports '' for these; a NaN height would
    // be written to the style attribute and silently dropped.
    const px = (style: string) => (Number.isFinite(parseFloat(style)) ? parseFloat(style) : 0);
    const lineHeight = px(computed.lineHeight) || 16;
    const paddingY = px(computed.paddingTop) + px(computed.paddingBottom);
    const borderY = px(computed.borderTopWidth) + px(computed.borderBottomWidth);
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
    <Textarea ref={ref} rows={1} value={value} resize="none" className={className} {...props} />
  );
}
