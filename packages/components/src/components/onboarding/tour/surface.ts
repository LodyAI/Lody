import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../../../style/theme-scale.stylex';

/**
 * The tour window: the product's own look, reproduced at the size the tour
 * frames it.
 *
 * The tour is the real product in a smaller window, so its chrome is the
 * product's chrome — the app's background and foreground, the app's border
 * colour, the app's radii. Nothing here invents a colour.
 */
export const tourSurface = stylex.create({
  /** The window: a rounded card on the app's own background. */
  window: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.7)',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  /** The title bar across the top of the window. */
  chrome: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    height: themeSpace[9],
    paddingInline: themeSpace[4],
  },
  /** The three window buttons. */
  chromeDots: { display: 'flex', alignItems: 'center', gap: themeSpace[1.5] },
  /** One window button: a small filled circle. */
  chromeDot: {
    width: '11px',
    height: '11px',
    borderRadius: themeRadius.full,
  },
  /** The window's own red button. */
  chromeDotRed: { backgroundColor: '#ff5f57' },
  /** The window's own yellow button. */
  chromeDotYellow: { backgroundColor: '#febc2e' },
  /** The window's own green button. */
  chromeDotGreen: { backgroundColor: '#28c840' },
  /** The space the window's title would occupy. */
  chromeSpacer: { width: themeSpace[14] },
  /** The window's body: the sidebar beside the conversation. */
  body: { display: 'flex', minHeight: 0, flexGrow: 1 },
  /** The sidebar's own column, beside the conversation. */
  sidebarColumn: {
    height: '100%',
    width: '280px',
    flexShrink: 0,
    overflow: 'hidden',
  },
  /**
   * The sidebar's edge. The sidebar draws its own fill and height; the tour
   * only draws the rule that separates it from the conversation.
   */
  sidebar: {
    borderRightWidth: '0.5px',
    borderRightStyle: 'solid',
    borderRightColor: 'hsl(var(--sidebar-border) / 0.7)',
  },
  /** The conversation column beside the sidebar. */
  conversation: { minWidth: 0, flexGrow: 1 },
  /** The side panel's frame: the tour draws the product's right-hand panel. */
  sidePanel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: themeColors.background,
  },
  /** The side panel's open edge. */
  sidePanelOpen: {
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'hsl(var(--border) / 0.7)',
  },
  /** The panel's tab bar. */
  sidePanelTabs: {
    height: themeSpace[11],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.6)',
  },
  /** The side panel's body. */
  sidePanelBody: { position: 'relative', minHeight: 0, flexGrow: 1, overflow: 'hidden' },
  /** A box that fills its parent. */
  fullHeight: { height: '100%' },
  /** The permission card's own inset. */
  permissionSlot: {
    paddingInline: themeSpace[3],
    paddingBottom: themeSpace[2],
  },
  /**
   * The diff placeholder: the tour's plain diff, on the window's own
   * background at a low alpha, in the product's monospace face.
   */
  diffSurface: {
    height: '100%',
    overflow: 'hidden',
    backgroundColor: 'hsl(var(--background) / 0.4)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: '11.5px',
    lineHeight: 1.65,
  },
  /** One line of the diff. */
  diffLine: {
    whiteSpace: 'pre',
    borderRadius: '0.25rem',
    paddingInline: themeSpace[2],
  },
  /** The diff placeholder's own ink. */
  diffAdded: {
    backgroundColor: 'hsl(var(--code-added) / 0.15)',
    color: themeColors.codeAdded,
  },
  /** The diff placeholder's removed lines. */
  diffRemoved: {
    backgroundColor: 'hsl(var(--code-removed) / 0.15)',
    color: themeColors.codeRemoved,
  },
  /** A diff line that changed nothing. */
  diffContext: { color: themeColors.mutedForeground },
  /** The camera's viewport: the frame the tour's window is seen through. */
  cameraViewport: {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'clip',
  },
  /** The window the camera moves over. */
  cameraWindow: {
    position: 'absolute',
    left: 0,
    top: 0,
    transformOrigin: '0 0',
  },
  /** The debug overlay's own frame. */
  debugOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 100,
    pointerEvents: 'none',
  },
  /** One debug marker, over the anchor it names. */
  debugMarker: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: 'var(--radius-sm)',
    borderWidth: '1px',
    borderStyle: 'solid',
  },
  /** The marker of the anchor the camera is on. */
  debugMarkerActive: {
    borderColor: 'oklch(87.9% 0.169 91.605)',
    backgroundColor: 'color-mix(in srgb, oklch(87.9% 0.169 91.605) 15%, transparent)',
    boxShadow: '0 0 0 2px rgba(251,191,36,0.22)',
  },
  /** A marker of an anchor the camera is not on. */
  debugMarkerIdle: {
    borderColor: 'color-mix(in srgb, oklch(86.5% 0.127 207.078) 70%, transparent)',
    backgroundColor: 'color-mix(in srgb, oklch(86.5% 0.127 207.078) 5%, transparent)',
  },
  /** The marker's own label. */
  debugLabel: {
    position: 'absolute',
    top: '-1.25rem',
    left: 0,
    whiteSpace: 'nowrap',
    borderRadius: '0.25rem',
    paddingInline: themeSpace[1.5],
    paddingBlock: '0.125rem',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: '10px',
    lineHeight: 1,
  },
  /** The label over the anchor the camera is on. */
  debugLabelActive: {
    backgroundColor: 'oklch(87.9% 0.169 91.605)',
    color: 'oklch(12.9% 0.042 264.695)',
  },
  /** The label over any other anchor. */
  debugLabelIdle: {
    backgroundColor: 'oklch(86.5% 0.127 207.078)',
    color: 'oklch(12.9% 0.042 264.695)',
  },
});
