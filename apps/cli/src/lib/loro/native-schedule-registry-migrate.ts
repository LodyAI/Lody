import { migrateLocalFlockGroupLegacy } from './native-flock-group-migrate';
/** Exact whole SR room migration; its own all-window witness is required. */
export function migrateLocalScheduleRegistryLegacy(
  input: unknown,
  options: { hostEntry: string; executable: string }
) {
  return migrateLocalFlockGroupLegacy(input, { ...options, domain: 'schedule' });
}
