import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  shell: {
    position: 'relative',
    height: '100%',
    width: '100%',
    overflow: 'hidden',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  content: {
    position: 'relative',
    height: '100%',
  },
});

export function AppThemeShell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const shellProps = stylex.props(styles.shell);
  return (
    <div {...shellProps} className={clsx(shellProps.className, className)}>
      <div {...stylex.props(styles.content)}>{children}</div>
    </div>
  );
}
