import { atom } from 'jotai';
import type { MachineCatalogSettingsPort } from '@lody/shared';
/** Safe domain observation only; it contains no saved launch configuration. */
export const nativeMachineCatalogSettingsAtom = atom<MachineCatalogSettingsPort | undefined>(
  undefined
);
