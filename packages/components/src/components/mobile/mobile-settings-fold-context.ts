import { createContext, useContext } from 'react';
import type { useHorizontalFoldLayout } from './use-horizontal-fold-layout';

export const MobileSettingsFoldContext =
  createContext<ReturnType<typeof useHorizontalFoldLayout>>(null);
export const useMobileSettingsFold = () => useContext(MobileSettingsFoldContext);
