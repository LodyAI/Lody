import * as stylex from '@stylexjs/stylex';

function legacyClass(_classes: string | undefined): string {
  throw new Error('Legacy declaration bindings require the components build adapter');
}

const styles = stylex.create({
  dimmed: { opacity: 0.7 },
  container: { containerType: 'inline-size' },
  row: { display: 'flex' },
  fullWidth: { width: '100%' },
  centered: { alignItems: 'center' },
  minimum: { minWidth: 'calc(var(--spacing) * 0)' },
  remainder: { flex: 1 },
  clipped: { overflow: 'hidden' },
  positioned: { position: 'relative' },
  column: { flexDirection: 'column' },
  gapTwo: { gap: 'calc(var(--spacing) * 2)' },
  paddingTwo: { padding: 'calc(var(--spacing) * 2)' },
  minimumHeight: { minHeight: 'calc(var(--spacing) * 0)' },
  contextHeight: { height: 'calc(var(--spacing) * 10)' },
  contextMaximum: { maxWidth: '20rem' },
  contextCorner: { borderRadius: 'var(--radius-lg)' },
  contextMuted: { backgroundColor: 'hsl(var(--muted) / 1)' },
  nonShrinking: { flexShrink: 0 },
  sidebarHeightEight: { height: 'calc(var(--spacing) * 8)' },
  sidebarHeightSeven: { height: 'calc(var(--spacing) * 7)' },
  sidebarHeightTwelve: { height: 'calc(var(--spacing) * 12)' },
  sidebarHeightFive: { height: 'calc(var(--spacing) * 5)' },
  sidebarCornerMedium: { borderRadius: 'var(--radius-md)' },
  heightFull: { height: '100%' },
  acpHeightSix: { height: 'calc(var(--spacing) * 6)' },
  acpWidthSix: { width: 'calc(var(--spacing) * 6)' },
  acpWidthAuto: { width: 'auto' },
  acpCornerFour: { borderRadius: '4px' },
  acpInlineZero: { paddingInline: 'calc(var(--spacing) * 0)' },
  acpInlineOne: { paddingInline: 'calc(var(--spacing) * 1)' },
  acpInlineTwo: { paddingInline: 'calc(var(--spacing) * 2)' },
  acpGapOne: { gap: 'calc(var(--spacing) * 1)' },
  sidebarFill: { backgroundColor: 'hsl(var(--sidebar-background) / 1)' },
  pageFill: { backgroundColor: 'hsl(var(--background) / 1)' },
  inputFill: { backgroundColor: 'hsl(var(--input-field) / 1)' },
  sidebarInk: { color: 'hsl(var(--sidebar-foreground) / 1)' },
  paddingZero: { padding: 'calc(var(--spacing) * 0)' },
  centeredContent: { justifyContent: 'center' },
  squareAspect: { aspectRatio: '1 / 1' },
  ignorePointer: { pointerEvents: 'none' },
  projectBottomOne: { marginBottom: 'calc(var(--spacing) * 1)' },
  projectBlockZero: { paddingBlock: 'calc(var(--spacing) * 0)' },
  projectBlockOneHalf: { paddingBlock: 'calc(var(--spacing) * 1.5)' },
  projectItemsStart: { alignItems: 'flex-start' },
  composerMinimum120: { minHeight: '120px' },
  composerMinimum24: { minHeight: '24px' },
  composerMinimum48: { minHeight: '48px' },
  composerTransparent: { backgroundColor: 'transparent' },
  composerInlineTwoHalf: { paddingInline: 'calc(var(--spacing) * 2.5)' },
  composerInlineFour: { paddingInline: 'calc(var(--spacing) * 4)' },
  composerInlineFive: { paddingInline: 'calc(var(--spacing) * 5)' },
  composerBlockThree: { paddingBlock: 'calc(var(--spacing) * 3)' },
  composerCorner2xl: { borderRadius: 'var(--radius-2xl)' },
  composerRightSixteen: { paddingRight: 'calc(var(--spacing) * 16)' },
  composerMaximum85vh: { maxHeight: '85vh' },
  composerClearBorder: { borderColor: 'transparent' },
  composerInputInk: { color: 'hsl(var(--input-foreground) / 1)' },
  composerQuietInk: { color: 'hsl(var(--muted-foreground) / 1)' },
  loroRecoveryTop: { marginTop: 'calc(var(--spacing) * 3)' },
  loroFullCorner: { borderRadius: 'calc(infinity * 1px)' },
  loroSidebarBorder: { borderColor: 'hsl(var(--sidebar-border) / 1)' },
  loroInlineThree: { paddingInline: 'calc(var(--spacing) * 3)' },
  loroGapOneHalf: { gap: 'calc(var(--spacing) * 1.5)' },
  attachmentPointer: { cursor: 'pointer' },
  attachmentGapTwoHalf: { gap: 'calc(var(--spacing) * 2.5)' },
  attachmentBlockTwoHalf: { paddingBlock: 'calc(var(--spacing) * 2.5)' },
  attachmentIntrinsicWidth: { width: 'max-content' },
  messageRestOpacity: { opacity: '0%' },
  mediumWeight: {
    '--tw-font-weight': 'var(--font-weight-medium)',
    fontWeight: 'var(--font-weight-medium)',
  },
  windowsBorderBottom: { paddingBottom: '7px' },
  windowsBottom: { paddingBottom: 'calc(var(--spacing) * 2)' },
  macFrameBorderBottom: { paddingBottom: '5px' },
  macFrameBottom: { paddingBottom: '6px' },
  macBorderTop: { paddingTop: '3px' },
  macTop: { paddingTop: '2px' },
  dragFixed: { position: 'fixed' },
  dragAbsolute: { position: 'absolute' },
  dragInline: { insetInline: 'calc(var(--spacing) * 0)' },
  dragTop: { top: 'calc(var(--spacing) * 0)' },
  dragIndex: { zIndex: 10 },
  sidebarViewportInset: { insetBlock: 'calc(var(--spacing) * 0)' },
  sidebarHidden: { display: 'none' },
  sidebarVariableWidth: { width: 'var(--sidebar-width)' },
  sidebarLeftZero: { left: 'calc(var(--spacing) * 0)' },
  sidebarRightZero: { right: 'calc(var(--spacing) * 0)' },
  sidebarRailIndex: { zIndex: 20 },
  sidebarRailWidth: { width: 'calc(var(--spacing) * 4)' },
  commandDialogIndex: { zIndex: 'var(--z-command-palette,85)' },
  commandDialogMaximum: { maxWidth: '42rem' },
  commandDialogCorner: { borderRadius: 'var(--radius-xl)' },
  mentionCaretRaised: { zIndex: 30 },
  filterNoGap: { gap: 'calc(var(--spacing) * 0)' },
  usagePopupPadding: { padding: 'calc(var(--spacing) * 3)' },
  filterMinimum: { minWidth: 200 },
});

export const pickerSpinnerClass = legacyClass(stylex.props(styles.dimmed).className);
export const tabViewportClass = legacyClass(
  stylex.props(styles.minimum, styles.remainder, styles.clipped).className
);
export const tabContainerClass = legacyClass(stylex.props(styles.container).className);
export const tabStripClass = legacyClass(
  stylex.props(styles.row, styles.fullWidth, styles.centered).className
);
export const tabItemClass = legacyClass(stylex.props(styles.minimum, styles.clipped).className);

export const sidebarInsetLayoutClass = legacyClass(
  stylex.props(styles.positioned, styles.row, styles.fullWidth, styles.remainder, styles.column)
    .className
);
export const sidebarStackLayoutClass = legacyClass(
  stylex.props(styles.row, styles.column, styles.gapTwo, styles.paddingTwo).className
);
export const sidebarContentLayoutClass = legacyClass(
  stylex.props(styles.row, styles.minimumHeight, styles.remainder, styles.column, styles.gapTwo)
    .className
);
export const sidebarGroupLayoutClass = legacyClass(
  stylex.props(
    styles.positioned,
    styles.row,
    styles.fullWidth,
    styles.minimum,
    styles.column,
    styles.paddingTwo
  ).className
);
export const sidebarMenuLayoutClass = legacyClass(
  stylex.props(styles.row, styles.fullWidth, styles.minimum, styles.column).className
);

export const sidebarFlexClass = legacyClass(stylex.props(styles.row).className);
export const sidebarWidthClass = legacyClass(stylex.props(styles.fullWidth).className);
export const sidebarItemsCenterClass = legacyClass(stylex.props(styles.centered).className);
export const sidebarRelativeClass = legacyClass(stylex.props(styles.positioned).className);
export const sidebarMinWidthClass = legacyClass(stylex.props(styles.minimum).className);
export const sidebarColumnClass = legacyClass(stylex.props(styles.column).className);
export const sidebarGapClass = legacyClass(stylex.props(styles.gapTwo).className);
export const sidebarOverflowClass = legacyClass(stylex.props(styles.clipped).className);

export const workspaceCardLayoutClass = legacyClass(
  stylex.props(
    styles.row,
    styles.minimum,
    styles.fullWidth,
    styles.remainder,
    styles.column,
    styles.clipped
  ).className
);
export const sessionDropPositionClass = legacyClass(stylex.props(styles.positioned).className);
export const sessionDropClipClass = legacyClass(
  stylex.props(styles.minimumHeight, styles.clipped).className
);

export const sidebarMenuButtonLayoutClass = legacyClass(
  stylex.props(styles.row, styles.fullWidth, styles.centered, styles.gapTwo, styles.clipped)
    .className
);
export const sidebarPaddingClass = legacyClass(stylex.props(styles.paddingTwo).className);

export const contextWidthClass = legacyClass(stylex.props(styles.fullWidth).className);
export const contextRowClass = legacyClass(stylex.props(styles.row).className);
export const contextRemainderClass = legacyClass(stylex.props(styles.remainder).className);

export const contextHeightClass = legacyClass(stylex.props(styles.contextHeight).className);
export const contextMaximumClass = legacyClass(stylex.props(styles.contextMaximum).className);
export const contextCornerClass = legacyClass(stylex.props(styles.contextCorner).className);
export const contextMutedClass = legacyClass(stylex.props(styles.contextMuted).className);

export const sidebarLabelShrinkClass = legacyClass(stylex.props(styles.nonShrinking).className);

export const sidebarHeightEightClass = legacyClass(
  stylex.props(styles.sidebarHeightEight).className
);
export const sidebarHeightSevenClass = legacyClass(
  stylex.props(styles.sidebarHeightSeven).className
);
export const sidebarHeightTwelveClass = legacyClass(
  stylex.props(styles.sidebarHeightTwelve).className
);
export const sidebarHeightFiveClass = legacyClass(stylex.props(styles.sidebarHeightFive).className);
export const sidebarCornerMediumClass = legacyClass(
  stylex.props(styles.sidebarCornerMedium).className
);

export const editorHeightClass = legacyClass(stylex.props(styles.heightFull).className);
export const editorWidthClipClass = legacyClass(
  stylex.props(styles.fullWidth, styles.clipped).className
);
export const editorContainClass = legacyClass(
  stylex.props(styles.heightFull, styles.container).className
);

export const acpCompactIconClass = legacyClass(
  stylex.props(styles.acpHeightSix, styles.acpWidthSix, styles.acpCornerFour, styles.acpInlineZero)
    .className
);

export const acpCompactTextLeadClass = legacyClass(
  stylex.props(styles.acpHeightSix, styles.acpWidthAuto, styles.minimum).className
);

export const acpCompactTextTailClass = legacyClass(
  stylex.props(styles.acpCornerFour, styles.acpInlineTwo, styles.acpGapOne).className
);

export const acpMinimumClass = legacyClass(stylex.props(styles.minimum).className);

export const acpGapClass = legacyClass(stylex.props(styles.acpGapOne).className);

export const acpIconClass = legacyClass(
  stylex.props(styles.acpHeightSix, styles.acpWidthSix, styles.acpCornerFour).className
);

export const acpLabelClass = legacyClass(
  stylex.props(styles.sidebarHeightEight, styles.acpInlineTwo).className
);

export const acpPlainCornerClass = legacyClass(stylex.props(styles.sidebarCornerMedium).className);

export const acpPlainPaddingClass = legacyClass(stylex.props(styles.acpInlineOne).className);

export const sidebarSurfaceClass = legacyClass(
  stylex.props(styles.sidebarFill, styles.sidebarInk).className
);

export const sidebarPageFillClass = legacyClass(stylex.props(styles.pageFill).className);

export const sidebarFieldFillClass = legacyClass(stylex.props(styles.inputFill).className);

export const sidebarInkClass = legacyClass(stylex.props(styles.sidebarInk).className);

export const sidebarPaddingZeroClass = legacyClass(stylex.props(styles.paddingZero).className);

export const sidebarJustifyClass = legacyClass(stylex.props(styles.centeredContent).className);

export const sidebarSquareClass = legacyClass(stylex.props(styles.squareAspect).className);

export const sidebarPointerNoneClass = legacyClass(stylex.props(styles.ignorePointer).className);

export const projectInputLeadClass = legacyClass(
  stylex.props(styles.projectBottomOne, styles.sidebarHeightEight, styles.sidebarCornerMedium)
    .className
);

export const projectInputTailClass = legacyClass(
  stylex.props(styles.inputFill, styles.projectBlockZero).className
);

export const projectRowLayoutClass = legacyClass(
  stylex.props(styles.gapTwo, styles.projectBlockOneHalf).className
);

export const projectItemsStartClass = legacyClass(stylex.props(styles.projectItemsStart).className);

export const projectItemsCenterClass = legacyClass(stylex.props(styles.centered).className);

export const composerLandingMinimumClass = legacyClass(
  stylex.props(styles.composerMinimum120).className
);

export const composerLandingInsetClass = legacyClass(
  stylex.props(styles.composerTransparent, styles.acpInlineZero, styles.projectBlockZero).className
);

export const composerSessionInsetClass = legacyClass(
  stylex.props(styles.composerTransparent, styles.acpInlineOne, styles.projectBlockZero).className
);

export const composerMobileMinimumClass = legacyClass(
  stylex.props(styles.composerMinimum24).className
);

export const composerDesktopMinimumClass = legacyClass(
  stylex.props(styles.composerMinimum48).className
);

export const composerDialogInsetClass = legacyClass(
  stylex.props(styles.composerMinimum120, styles.composerInlineFour, styles.composerBlockThree)
    .className
);

export const composerDialogShapeClass = legacyClass(
  stylex.props(styles.fullWidth, styles.composerCorner2xl).className
);

export const composerTransparentClass = legacyClass(
  stylex.props(styles.composerTransparent).className
);

export const composerDialogActionClass = legacyClass(
  stylex.props(styles.contextHeight, styles.contextCorner, styles.composerInlineFive).className
);

export const composerLandingActionClass = legacyClass(
  stylex.props(styles.acpHeightSix, styles.acpCornerFour, styles.acpInlineTwo).className
);

export const composerSessionActionClass = legacyClass(
  stylex.props(styles.sidebarHeightSeven, styles.sidebarCornerMedium, styles.composerInlineTwoHalf)
    .className
);

export const composerLandingActionWidthClass = legacyClass(
  stylex.props(styles.acpWidthAuto, styles.nonShrinking).className
);

export const composerActionWidthClass = legacyClass(stylex.props(styles.acpWidthAuto).className);

export const composerHintInsetClass = legacyClass(
  stylex.props(styles.composerRightSixteen).className
);

export const composerPastedPaddingClass = legacyClass(stylex.props(styles.paddingZero).className);

export const composerPastedMaximumClass = legacyClass(
  stylex.props(styles.composerMaximum85vh).className
);

export const composerClearBorderClass = legacyClass(
  stylex.props(styles.composerClearBorder).className
);
export const composerInputInkClass = legacyClass(stylex.props(styles.composerInputInk).className);
export const composerSecondaryInkClass = legacyClass(
  stylex.props(styles.pageFill, styles.composerQuietInk).className
);

export const loroRecoveryFrameClass = legacyClass(
  stylex.props(
    styles.loroRecoveryTop,
    styles.loroFullCorner,
    styles.loroSidebarBorder,
    styles.sidebarFill,
    styles.loroInlineThree
  ).className
);

export const loroSwitcherGapClass = legacyClass(stylex.props(styles.loroGapOneHalf).className);

export const attachmentPointerClass = legacyClass(stylex.props(styles.attachmentPointer).className);

export const attachmentMobileRowClass = legacyClass(
  stylex.props(styles.attachmentGapTwoHalf, styles.attachmentBlockTwoHalf).className
);

export const attachmentMobileBlockClass = legacyClass(
  stylex.props(styles.attachmentBlockTwoHalf).className
);

export const attachmentIntrinsicWidthClass = legacyClass(
  stylex.props(styles.attachmentIntrinsicWidth).className
);

export const messageRestOpacityClass = legacyClass(
  stylex.props(styles.messageRestOpacity).className
);

export const messageFooterLayoutClass = legacyClass(
  stylex.props(styles.loroGapOneHalf, styles.sidebarCornerMedium, styles.loroInlineThree).className
);

export const acpMediumWeightClass = legacyClass(stylex.props(styles.mediumWeight).className);

export const windowWindowsBorderClass = legacyClass(
  stylex.props(styles.windowsBorderBottom).className
);
export const windowWindowsPlainClass = legacyClass(stylex.props(styles.windowsBottom).className);
export const windowMacFrameBorderClass = legacyClass(
  stylex.props(styles.macFrameBorderBottom).className
);
export const windowMacFramePlainClass = legacyClass(stylex.props(styles.macFrameBottom).className);
export const windowMacBorderClass = legacyClass(stylex.props(styles.macBorderTop).className);
export const windowMacPlainClass = legacyClass(stylex.props(styles.macTop).className);
export const windowFixedClass = legacyClass(stylex.props(styles.dragFixed).className);
export const windowAbsoluteClass = legacyClass(stylex.props(styles.dragAbsolute).className);
export const windowStripInsetsClass = legacyClass(
  stylex.props(styles.dragInline, styles.dragTop, styles.dragIndex).className
);

export const sidebarDockFrameClass = legacyClass(
  stylex.props(
    styles.dragFixed,
    styles.sidebarViewportInset,
    styles.dragIndex,
    styles.sidebarHidden
  ).className
);
export const sidebarLeadingZeroClass = legacyClass(stylex.props(styles.sidebarLeftZero).className);
export const sidebarTrailingZeroClass = legacyClass(
  stylex.props(styles.sidebarRightZero).className
);
export const sidebarUncollapsedGeometryClass = legacyClass(
  stylex.props(styles.heightFull, styles.sidebarVariableWidth).className
);
export const sidebarVariableWidthClass = legacyClass(
  stylex.props(styles.sidebarVariableWidth).className
);
export const sidebarRailGeometryClass = legacyClass(
  stylex.props(
    styles.dragAbsolute,
    styles.sidebarViewportInset,
    styles.sidebarRailIndex,
    styles.sidebarHidden,
    styles.sidebarRailWidth
  ).className
);

export const commandDialogFrameClass = legacyClass(
  stylex.props(styles.commandDialogIndex, styles.commandDialogMaximum, styles.composerTransparent)
    .className
);
export const commandDialogBackdropClass = legacyClass(
  stylex.props(styles.commandDialogIndex).className
);
export const commandDialogCornerClass = legacyClass(
  stylex.props(styles.commandDialogCorner).className
);

export const mentionLabelBlockClass = legacyClass(
  stylex.props(styles.projectBlockOneHalf).className
);
export const mentionInputFlowClass = legacyClass(
  stylex.props(styles.row, styles.fullWidth).className
);
export const mentionRaisedCaretClass = legacyClass(
  stylex.props(styles.mentionCaretRaised).className
);
export const mentionRestCaretClass = legacyClass(stylex.props(styles.dragIndex).className);

export const sidebarInputGeometryClass = legacyClass(
  stylex.props(styles.sidebarHeightEight, styles.fullWidth).className
);
export const sidebarMenuSkeletonLayoutClass = legacyClass(
  stylex.props(
    styles.row,
    styles.sidebarHeightEight,
    styles.centered,
    styles.gapTwo,
    styles.sidebarCornerMedium,
    styles.acpInlineTwo
  ).className
);

export const sidebarFilterNoGapClass = legacyClass(stylex.props(styles.filterNoGap).className);

export const usagePopupPaddingClass = legacyClass(stylex.props(styles.usagePopupPadding).className);

export const sidebarFilterMinimumClass = legacyClass(stylex.props(styles.filterMinimum).className);
