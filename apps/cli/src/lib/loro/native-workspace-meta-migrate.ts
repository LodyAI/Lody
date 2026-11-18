import { migrateLocalFlockGroupLegacy } from './native-flock-group-migrate';
/** Whole-workspace Meta migration, independent of WF/MF/SR witnesses. */
export function migrateLocalWorkspaceMetaLegacy(
  input: unknown,
  options: { hostEntry: string; executable: string }
) {
  return migrateLocalFlockGroupLegacy(input, { ...options, domain: 'meta' });
}
