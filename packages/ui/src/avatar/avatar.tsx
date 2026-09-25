import { Avatar as BaseAvatar } from '@base-ui/react/avatar';
import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  forwardRef,
  useContext,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { appendClassName } from '../internal/class-name';
import { corner, radius } from '../tokens/scales.stylex';
import { avatar } from './avatar.tokens.stylex';

/**
 * How much room the face takes. The letters and the glyph inside it follow from
 * this, so a caller states one fact rather than three that can disagree.
 */
export type AvatarSize = 'mini' | 'small' | 'medium' | 'large' | 'xlarge';

/**
 * What is being stood in for. A **person** is a circle, which is what a circle
 * has meant in every interface a person has used; a **thing** — a workspace, an
 * organisation, a repository — is a tile, because a circle around a logo is a
 * crop rather than a shape and the mark inside it was drawn square.
 */
export type AvatarShape = 'circle' | 'tile';

type RootBaseProps = ComponentProps<typeof BaseAvatar.Root>;
type ImageBaseProps = ComponentProps<typeof BaseAvatar.Image>;
type FallbackBaseProps = ComponentProps<typeof BaseAvatar.Fallback>;

export interface AvatarRootProps extends Omit<RootBaseProps, 'className'> {
  /** Defaults to `medium`. */
  size?: AvatarSize;
  /** Defaults to `circle`. */
  shape?: AvatarShape;
  className?: string;
}

export interface AvatarImageProps extends Omit<ImageBaseProps, 'className'> {
  className?: string;
}

export interface AvatarFallbackProps extends Omit<FallbackBaseProps, 'className' | 'style'> {
  children?: ReactNode;
  className?: string;
  /**
   * The identity colour of the thing this stands in for, where the surface has
   * one — a hue derived from a workspace name, so the same workspace is the
   * same colour on every screen. It is a plain object rather than Base UI's
   * state callback, because it is merged with the compiled style rather than
   * replacing it, and because which hue belongs to which name is a product fact
   * that no state of this component reports.
   */
  style?: CSSProperties;
}

/**
 * The rung the root chose, for the parts under it. A fallback's type step and
 * its glyph box are facts about the box around them, and Base UI's own state
 * carries the image's loading status rather than the size, so the size travels
 * here instead of being restated on every part.
 */
const AvatarSizeContext = createContext<AvatarSize>('medium');

const styles = stylex.create({
  /**
   * The box. It crops whatever is inside it — a photograph that is not square,
   * a letter that overhangs — which is the whole of what the root does beyond
   * choosing the shape.
   */
  root: {
    boxSizing: 'border-box',
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // An avatar states how much room it takes; it never gives any of it back to
    // a row that ran out. Every one of the deleted implementation's call sites
    // had reached for `shrink-0` to say so.
    flexShrink: 0,
    // …and it never takes more, either. A flex item's automatic minimum size is
    // its content's, so a 16px circle holding two initials is laid out 20px
    // wide and stops being a circle — which is what the board showed, and what
    // no unit test could: jsdom applies none of this CSS. The width is the
    // fact, and anything wider than it is cropped.
    minWidth: 0,
    overflow: 'hidden',
    cornerShape: corner.shape,
    userSelect: 'none',
  },
  /**
   * A person. `radius.full` takes `corner.round` by the rules: a squircle at
   * that radius is a superellipse, which turns a face into a rounded square.
   */
  circle: { borderRadius: radius.full, cornerShape: corner.round },
  mini: { width: avatar.sizeMini, height: avatar.sizeMini },
  small: { width: avatar.sizeSmall, height: avatar.sizeSmall },
  medium: { width: avatar.sizeMedium, height: avatar.sizeMedium },
  large: { width: avatar.sizeLarge, height: avatar.sizeLarge },
  xlarge: { width: avatar.sizeXlarge, height: avatar.sizeXlarge },
  tileMini: { borderRadius: avatar.tileRadiusMini },
  tileSmall: { borderRadius: avatar.tileRadiusSmall },
  tileMedium: { borderRadius: avatar.tileRadiusMedium },
  tileLarge: { borderRadius: avatar.tileRadiusLarge },
  tileXlarge: { borderRadius: avatar.tileRadiusXlarge },
  /**
   * The picture. It fills the box and is cropped to it rather than squashed
   * into it: an avatar arrives at whatever aspect its owner uploaded, and a
   * stretched face is worse than a cropped one.
   */
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    // The root already clips, but a rounded image inside a rounded box leaves
    // the corners of the crop showing during the load of the next one.
    borderRadius: 'inherit',
    display: 'block',
  },
  /** The letters, or the mark. */
  fallback: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    // The same automatic minimum, one level in: the fallback is a flex item of
    // the root, and without this the letters push it past the box they are in.
    minWidth: 0,
    borderRadius: 'inherit',
    backgroundColor: avatar.fallbackBackground,
    color: avatar.fallbackLabel,
    fontWeight: 500,
    // Two initials are two capitals, and a name in a script with no capitals is
    // one grapheme; neither should ever be hyphenated or wrapped.
    whiteSpace: 'nowrap',
    lineHeight: 1,
  },
  initialsMini: { fontSize: avatar.initialsMini },
  initialsSmall: { fontSize: avatar.initialsSmall },
  initialsMedium: { fontSize: avatar.initialsMedium },
  initialsLarge: { fontSize: avatar.initialsLarge },
  initialsXlarge: { fontSize: avatar.initialsXlarge },
  /** The box a caller's glyph is given, and fills. */
  glyph: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  glyphMini: { width: avatar.glyphMini, height: avatar.glyphMini },
  glyphSmall: { width: avatar.glyphSmall, height: avatar.glyphSmall },
  glyphMedium: { width: avatar.glyphMedium, height: avatar.glyphMedium },
  glyphLarge: { width: avatar.glyphLarge, height: avatar.glyphLarge },
  glyphXlarge: { width: avatar.glyphXlarge, height: avatar.glyphXlarge },
});

const BOXES = {
  mini: styles.mini,
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
  xlarge: styles.xlarge,
} as const;

const TILES = {
  mini: styles.tileMini,
  small: styles.tileSmall,
  medium: styles.tileMedium,
  large: styles.tileLarge,
  xlarge: styles.tileXlarge,
} as const;

const INITIALS = {
  mini: styles.initialsMini,
  small: styles.initialsSmall,
  medium: styles.initialsMedium,
  large: styles.initialsLarge,
  xlarge: styles.initialsXlarge,
} as const;

const GLYPHS = {
  mini: styles.glyphMini,
  small: styles.glyphSmall,
  medium: styles.glyphMedium,
  large: styles.glyphLarge,
  xlarge: styles.glyphXlarge,
} as const;

/**
 * The box a face goes in.
 *
 * It holds an `Avatar.Image` and an `Avatar.Fallback`, and Base UI decides
 * which of the two is on screen from the image's own loading status — so a
 * surface writes both and never writes the condition. That is the part the
 * deleted Radix wrapper also got right; what it did not have was a size, so the
 * box and the letters inside it were two classes at every call site.
 */
export const AvatarRoot = forwardRef<HTMLSpanElement, AvatarRootProps>(function AvatarRoot(
  { size = 'medium', shape = 'circle', className, ...rest },
  ref
) {
  const sx = stylex.props(
    styles.root,
    BOXES[size],
    shape === 'circle' ? styles.circle : TILES[size]
  );
  return (
    <AvatarSizeContext.Provider value={size}>
      <BaseAvatar.Root
        ref={ref}
        data-size={size}
        data-shape={shape}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    </AvatarSizeContext.Provider>
  );
});

/**
 * The picture. It is mounted only once it has loaded, which is Base UI's doing:
 * a broken URL leaves the letters standing rather than flashing a torn image
 * icon over them.
 */
export const AvatarImage = forwardRef<HTMLImageElement, AvatarImageProps>(function AvatarImage(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(styles.image);
  return (
    <BaseAvatar.Image
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * What stands in for the picture: initials, or a mark.
 *
 * The fill is a gray rather than a semantic colour, because a stand-in for a
 * face has no role in this interface — the same reading that gives `Skeleton`
 * its gray. A surface that has an identity colour of its own for the thing —
 * a hue derived from a workspace name, so the same workspace is the same colour
 * on every screen — states it as a `style`, since which colour belongs to which
 * name is a product fact and not a token.
 */
export const AvatarFallback = forwardRef<HTMLSpanElement, AvatarFallbackProps>(
  function AvatarFallback({ className, style, ...rest }, ref) {
    const size = useContext(AvatarSizeContext);
    const sx = stylex.props(styles.fallback, INITIALS[size]);
    return (
      <BaseAvatar.Fallback
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        // The one part of this package that merges a caller's `style` rather
        // than replacing it. Everywhere else `style` carries nothing a caller
        // has business setting, but the identity colour this fallback is
        // documented to take arrives that way — which hue belongs to which
        // workspace is a product fact, not a token — so dropping it would be
        // dropping the thing the prop is for.
        style={sx.style ? { ...sx.style, ...style } : style}
      />
    );
  }
);

/**
 * The box a mark inside a fallback is given, and fills.
 *
 * Every glyph in this package states 100% of whatever holds it, and StyleX has
 * no descendant selector to reach one with, so whatever holds a glyph draws its
 * box — a menu row's leading slot, a badge's, an icon-only Button's. A fallback
 * holding a person-shaped mark instead of letters is the same case, and the box
 * follows the rung rather than the icon library's default.
 */
export function AvatarGlyph({ children }: { children: ReactNode }) {
  const size = useContext(AvatarSizeContext);
  const sx = stylex.props(styles.glyph, GLYPHS[size]);
  return (
    <span aria-hidden="true" className={sx.className} style={sx.style}>
      {children}
    </span>
  );
}

export const Avatar = {
  Root: AvatarRoot,
  Image: AvatarImage,
  Fallback: AvatarFallback,
  Glyph: AvatarGlyph,
};
