import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { corner, text } from '../tokens/scales.stylex';
import { kbd } from './kbd.tokens.stylex';

export interface KbdProps extends Omit<ComponentProps<'kbd'>, 'className'> {
  className?: string;
}

export type KbdGroupProps = KbdProps;

const styles = stylex.create({
  /**
   * One key. It is a gray, because the rules name a kbd among the things with
   * no role in this interface: it stands for a piece of hardware rather than
   * for anything on the screen, so none of the semantic colours is about it.
   */
  cap: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    height: kbd.height,
    minWidth: kbd.minWidth,
    paddingInline: kbd.paddingX,
    borderRadius: kbd.radius,
    cornerShape: corner.shape,
    backgroundColor: kbd.background,
    color: kbd.label,
    fontSize: kbd.labelSize,
    lineHeight: kbd.labelLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    // A cap is drawn, not typeset: the browser's default for `<kbd>` is a
    // monospace face, and `⌘` and `⇧` are drawn by the UI font here, so a cap
    // that fell back to the mono stack would render a different glyph beside an
    // identical one in the label next to it.
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    // A key cap is a picture of a key, not a control and not a target: nothing
    // here answers a pointer, takes focus or can be selected with the text
    // around it. A surface that wants a pressable key wants a Button.
    pointerEvents: 'none',
    userSelect: 'none',
  },
  /**
   * A chord: the keys that are pressed together. It is a `<kbd>` around
   * `<kbd>`s, which is what HTML gives this exact shape, so a screen reader is
   * told it is one gesture rather than three keys in a row.
   */
  group: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: kbd.gap,
    // The wrapper carries no appearance of its own; the caps do.
    backgroundColor: 'transparent',
    padding: 0,
    fontFamily: 'inherit',
    verticalAlign: 'middle',
  },
});

/**
 * A key on the keyboard.
 *
 * The word inside it is the caller's, because which key a person presses
 * depends on their platform and their layout, and this package carries no
 * dictionary — the same reason `Pagination` takes its words from the surface.
 *
 * It is not a menu row's shortcut. The rules give that slot plain trailing
 * metadata in `popup.hint`: a menu is already a list of rows carrying a leading
 * box, a label and a chevron, and a column of chips down its right edge turns a
 * quiet list into a keyboard diagram. A cap is for the surfaces where the keys
 * themselves are the subject.
 */
export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd({ className, ...rest }, ref) {
  const sx = stylex.props(styles.cap);
  return (
    <kbd
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * The keys of one chord, pressed together.
 *
 * They sit at `kbd.gap` with nothing between them: a `+` is how a chord is
 * written in prose, and this is not prose — the caps are already side by side,
 * and a separator between them is a fourth thing to read in a row that is
 * usually eleven pixels tall.
 */
export const KbdGroup = forwardRef<HTMLElement, KbdGroupProps>(function KbdGroup(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(styles.group);
  return (
    <kbd
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});
