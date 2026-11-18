import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { MachineCatalogSettingsPort } from '@lody/shared';
import type { NativeMachineCatalogSource } from './native-machine-catalog-ipc';

const MachineCatalogSettingsContext = createContext<MachineCatalogSettingsPort | undefined>(
  undefined
);

/** Composition-only domain injection for both DesktopSettingsModal and routed
 * machine settings. No Repo/Flock or saved credential read method crosses it. */
export function MachineCatalogSettingsProvider({
  catalog,
  children,
}: {
  catalog: MachineCatalogSettingsPort;
  children: ReactNode;
}) {
  return (
    <MachineCatalogSettingsContext.Provider value={catalog}>
      {children}
    </MachineCatalogSettingsContext.Provider>
  );
}

export const useMachineCatalogSettings = () => useContext(MachineCatalogSettingsContext);

/** The composition owns start/close and the selected registration. Rendering
 * merely reads its immutable snapshot and never acquires another room. */
export function NativeMachineCatalogSettingsProvider({
  source,
  children,
}: {
  source: NativeMachineCatalogSource;
  children: ReactNode;
}) {
  const catalog = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return (
    <MachineCatalogSettingsProvider catalog={catalog}>{children}</MachineCatalogSettingsProvider>
  );
}
