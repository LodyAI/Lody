import { Toast as BaseToast } from '@base-ui/react/toast';
import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { Button } from '../button/button';
import { appendClassName } from '../internal/class-name';
import { CrossGlyph } from '../internal/glyphs';
import { useForcedThemeClassNames } from '../theme/theme';
import { feedbackSurface as surface, isHidden } from './surface';
import { TOAST_TONES, TONE_GLYPHS, TONE_MARKS, type FeedbackTone } from './tone';

export interface ToastProviderProps {
  children?: ReactNode;
  /**
   * The manager a surface outside React adds toasts through; make one with
   * `Toast.createManager()` and keep it beside the code that reports.
   */
  manager?: ReturnType<typeof BaseToast.createToastManager>;
  /** How long a toast stays. `0` keeps it until it is answered or closed. */
  timeout?: number;
  /** How many are shown at once before the oldest are held back. */
  limit?: number;
  /** What the close button is called; the product's word, in its language. */
  closeLabel?: string;
  /**
   * What the region holding the toasts is called to a screen reader. Base UI's
   * default is the English "Notifications", which a translated product has to
   * replace.
   */
  label?: string;
}

export interface ToastViewportProps {
  className?: string;
  closeLabel?: string;
  label?: string;
}

/** A tone a toast was added with, read off the `type` the manager carries. */
function toneOf(type: string | undefined): FeedbackTone {
  return type === 'success' || type === 'warning' || type === 'danger' ? type : 'neutral';
}

/**
 * The list itself. Base UI keeps the toasts, and this turns each one into the
 * same block an Alert is: the tone's mark, a title, the sentence under it, and
 * whatever answers it.
 */
function ToastList({ closeLabel = 'Close' }: { closeLabel?: string }) {
  const { toasts } = BaseToast.useToastManager();
  return (
    <>
      {toasts.map((toast) => {
        const tone = toneOf(toast.type);
        const Mark = TONE_GLYPHS[tone];
        const mark = stylex.props(surface.mark, TONE_MARKS[tone]);
        const body = stylex.props(surface.body);
        const title = stylex.props(surface.title);
        const description = stylex.props(surface.description);
        const actions = stylex.props(surface.actions);
        return (
          <BaseToast.Root
            key={toast.id}
            toast={toast}
            className={(state) =>
              stylex.props(
                surface.message,
                surface.toast,
                TOAST_TONES[tone],
                // StyleX cannot express `[data-starting-style]`, so which end of
                // the arrival a toast is at is read off Base UI's status here,
                // the way a popover's rise and an accordion's reveal are.
                state.swiping && surface.toastSwiping,
                isHidden(state.transitionStatus) &&
                  (state.swipeDirection == null ? surface.toastHidden : surface.toastFading)
              ).className
            }
          >
            <span className={mark.className} style={mark.style}>
              <Mark />
            </span>
            <div className={body.className} style={body.style}>
              {toast.title != null ? (
                <BaseToast.Title className={title.className} style={title.style} />
              ) : null}
              {toast.description != null ? (
                <BaseToast.Description
                  className={description.className}
                  style={description.style}
                />
              ) : null}
              {toast.actionProps ? (
                <div className={actions.className} style={actions.style}>
                  <BaseToast.Action render={<Button variant="secondary" size="small" />} />
                </div>
              ) : null}
            </div>
            <BaseToast.Close
              render={
                <Button variant="ghost" size="small" icon aria-label={closeLabel}>
                  <CrossGlyph />
                </Button>
              }
            />
          </BaseToast.Root>
        );
      })}
    </>
  );
}

/**
 * Where the toasts land: one column at the top of the window, clear of the safe
 * area, above every popup. It takes no pointer, so the page under it stays
 * usable while a message is showing, and each toast takes its own back.
 */
export function ToastViewport({ className, closeLabel, label }: ToastViewportProps) {
  // A portalled viewport leaves the subtree whose palette it should be using,
  // so the classes that declare that palette travel with it.
  const palette = useForcedThemeClassNames();
  const sx = stylex.props(surface.viewport);
  return (
    <BaseToast.Portal>
      <BaseToast.Viewport
        aria-label={label}
        className={[appendClassName(sx.className, className), ...palette].filter(Boolean).join(' ')}
        style={sx.style}
      >
        <ToastList closeLabel={closeLabel} />
      </BaseToast.Viewport>
    </BaseToast.Portal>
  );
}

/**
 * The provider, with the viewport already in it: a surface wraps its app once
 * and reports from anywhere, rather than assembling a provider, a portal, a
 * viewport and a list that must agree with each other.
 */
export function ToastProvider({
  children,
  manager,
  timeout,
  limit,
  closeLabel,
  label,
}: ToastProviderProps) {
  return (
    <BaseToast.Provider toastManager={manager} timeout={timeout} limit={limit}>
      {children}
      <ToastViewport closeLabel={closeLabel} label={label} />
    </BaseToast.Provider>
  );
}

/**
 * A message that arrives over the page rather than staying on it.
 *
 * It is the same block an `Alert` is — a tone's mark, a title, a sentence, an
 * answer — on the floating rung instead of the card one. It is deliberately not
 * on the modal rung: a toast does not have to be answered, so nothing behind it
 * recedes and nothing about it holds the keyboard.
 *
 * The tone travels as the manager's `type`, because that is the field Base UI
 * already carries from the call that reported to the toast that shows it:
 * `toast.add({ title: 'Sync failed', type: 'danger' })`.
 */
export const Toast = {
  Provider: ToastProvider,
  Viewport: ToastViewport,
  /** A handle for code that reports from outside React. */
  createManager: BaseToast.createToastManager,
  /** The same handle inside it, plus the list a surface may read. */
  useToast: BaseToast.useToastManager,
};
