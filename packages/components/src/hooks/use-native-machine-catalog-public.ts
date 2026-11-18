import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '../atoms/runtime';
import { nativeMachineCatalogSettingsAtom } from '../atoms/native-machine-catalog';
import { readNativeMachineCatalogPublicView } from '../lib/native-machine-catalog-public';
/** Re-evaluate the domain view on every immutable safe snapshot/owner change. */
export function useNativeMachineCatalogPublicReader() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const snapshot = useAtomValue(nativeMachineCatalogSettingsAtom);
  return useCallback(
    (machineId: MachineId) => readNativeMachineCatalogPublicView(runtime, machineId),
    [runtime, snapshot]
  );
}
