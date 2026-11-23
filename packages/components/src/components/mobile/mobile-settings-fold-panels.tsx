import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useMobileSettingsFold } from './mobile-settings-fold-context';

/** Keep both panel subtrees mounted as the device folds or the keyboard appears. */
export function MobileSettingsFoldPanels({
  upper,
  lower,
  lowerClassName,
}: {
  upper: ReactNode;
  lower: ReactNode;
  lowerClassName?: string;
}) {
  const fold = useMobileSettingsFold();
  return (
    <div className={cn(fold && 'flex h-full min-h-0 flex-col')}>
      <div
        data-settings-fold-upper
        className={cn(fold && 'min-h-0 overflow-y-auto')}
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
        className={cn(fold && 'min-h-0 flex-1 overflow-y-auto', fold && lowerClassName)}
      >
        {lower}
      </div>
    </div>
  );
}
