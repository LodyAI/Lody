import type { ReactNode } from 'react';

import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { useMobileSettingsFold } from './mobile-settings-fold-context';

/** Keep both panel subtrees mounted as the device folds or the keyboard appears. */
export function MobileSettingsFoldPanels({
  upper,
  lower,
  lowerClassName,
  lowerXstyle,
}: {
  upper: ReactNode;
  lower: ReactNode;
  lowerClassName?: string;
  lowerXstyle?: stylex.StyleXStyles;
}) {
  const fold = useMobileSettingsFold();
  const lowerProps = stylex.props(fold && styles.lower, fold && lowerXstyle);
  return (
    <div {...stylex.props(fold && styles.root)}>
      <div
        data-settings-fold-upper
        {...stylex.props(fold && styles.upper)}
        style={fold ? { flex: `0 0 ${fold.messageHeight}px` } : undefined}
      >
        {upper}
      </div>
      <div
        aria-hidden="true"
        style={fold ? { flex: `0 0 ${fold.gapHeight}px` } : { display: 'none' }}
      />
      <div
        data-settings-fold-lower
        {...lowerProps}
        className={clsx(lowerProps.className, fold && lowerClassName)}
      >
        {lower}
      </div>
    </div>
  );
}

const styles = stylex.create({
  root: { display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column' },
  upper: { minHeight: 0, overflowY: 'auto' },
  lower: { minHeight: 0, flex: '1 1 0%', overflowY: 'auto' },
});
