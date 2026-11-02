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
