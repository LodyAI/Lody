import * as stylex from '@stylexjs/stylex';
import { DocumentCaptureButton } from './document-selection-surface';
import type { ReactNode } from 'react';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 },
  toolbar: {
    display: 'flex',
    flex: '0 0 auto',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: space[1],
    paddingInline: space[2],
    paddingBlock: space[1],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
    backgroundColor: colors.background,
  },
  body: {
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 0,
    minWidth: 0,
    overflow: 'auto',
    backgroundColor: colors.secondaryBackground,
  },
  group: { display: 'inline-flex', alignItems: 'center', gap: space[1] },
  spacer: { flex: '1 1 auto' },
  zoom: { minWidth: '6rem' },
  label: { color: colors.secondaryLabel, fontSize: '0.75rem' },
});

export const officeFrameStyles = styles;

export function OfficeViewerFrame({
  label,
  toolbar,
  children,
}: {
  readonly label: string;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section {...stylex.props(styles.root)} aria-label={label}>
      {toolbar !== null ? (
        <div {...stylex.props(styles.toolbar)} data-document-toolbar>
          {toolbar}
          <span {...stylex.props(styles.spacer)} />
          <DocumentCaptureButton />
        </div>
      ) : null}
      <div {...stylex.props(styles.body)}>{children}</div>
    </section>
  );
}
