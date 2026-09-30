import lodyLogo from '@/assets/lody-icon.png';
import * as stylex from '@stylexjs/stylex';
import { Avatar } from '@lody/ui/avatar';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';

const WIDE = '@media (min-width: 640px)';

const styles = stylex.create({
  identity: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: space[2],
    paddingInlineStart: space[1],
  },
  name: {
    display: { default: 'none', [WIDE]: 'block' },
    minWidth: 0,
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  brand: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1.5],
    paddingInline: space[1.5],
    paddingBlock: space[1],
    borderRadius: radius.small,
    cornerShape: corner.shape,
    color: colors.label,
    textDecoration: 'none',
  },
  brandLink: {
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /**
   * The icon's own black tile, whatever the appearance. The hairline is the
   * label at 10%: ink on black in the light palette, where the tile needs no
   * edge, and white on black in the dark one, where it does.
   */
  tile: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: '6px',
    cornerShape: corner.shape,
    backgroundColor: '#0d0d0f',
    boxShadow: `0 0 0 1px color-mix(in oklab, transparent, ${colors.label} 10%)`,
  },
  logo: { width: '18px', height: '18px', objectFit: 'contain' },
  wordmark: {
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    letterSpacing: '-0.025em',
  },
});

/**
 * Who is looking at this share, as far as the reader can tell.
 *
 * The reader never authenticates: it holds no workspace credential and, in
 * production, is served from its own origin, so it cannot read the app's
 * session cookie. The host supplies this when it can establish an identity;
 * `signed-out` is the honest default and the only state the isolated share
 * origin can reach today.
 */
export type ShareViewer =
  | { status: 'signed-out' }
  | { status: 'signed-in'; name: string; imageUrl?: string | null };

/** The app origin to send a visitor to, or null when it cannot be established. */
export function resolveShareAppOrigin(): string | null {
  const configured = import.meta.env.VITE_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* Fall through to the address the visitor is already on. */
    }
  }
  if (typeof window === 'undefined') return null;
  const { hostname, protocol, port } = window.location;
  // A dedicated share subdomain has no sign-in page of its own.
  if (hostname.startsWith('share.') && hostname.split('.').length > 2) {
    return `${protocol}//${hostname.slice('share.'.length)}${port ? `:${port}` : ''}`;
  }
  return window.location.origin;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts.at(-1)![0]!)
    .toUpperCase()
    .slice(0, 2);
}

/** Top-right identity slot, empty for anonymous visitors. */
export function ShareViewerIdentity({ viewer }: { viewer: ShareViewer }) {
  if (viewer.status === 'signed-in')
    return (
      <div {...stylex.props(styles.identity)}>
        <span {...stylex.props(styles.name)}>{viewer.name}</span>
        <Avatar.Root size="medium">
          {viewer.imageUrl ? <Avatar.Image src={viewer.imageUrl} alt="" /> : null}
          <Avatar.Fallback>{initialsOf(viewer.name)}</Avatar.Fallback>
        </Avatar.Root>
      </div>
    );
  return null;
}

/**
 * The product mark, leading the reader header and pointing back at Lody.
 *
 * The tile is the packaged app icon's own black square rather than a theme
 * surface: a brand mark should not repaint with the reader's appearance. Dark
 * mode only adds a hairline so the tile still has an edge against the canvas.
 */
export function ShareBrandLink({ appOrigin }: { appOrigin: string | null }) {
  const mark = (
    <>
      <span {...stylex.props(styles.tile)}>
        <img src={lodyLogo} alt="" aria-hidden draggable={false} {...stylex.props(styles.logo)} />
      </span>
      <span {...stylex.props(styles.wordmark)}>Lody</span>
    </>
  );
  const surface = stylex.props(styles.brand, !!appOrigin && styles.brandLink);
  if (!appOrigin) return <span {...surface}>{mark}</span>;
  // A new tab: a visitor reading a share must not lose it to the marketing site.
  return (
    <a href={appOrigin} target="_blank" rel="noopener noreferrer" {...surface}>
      {mark}
    </a>
  );
}
