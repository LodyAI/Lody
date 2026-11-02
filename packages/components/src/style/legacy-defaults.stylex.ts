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
