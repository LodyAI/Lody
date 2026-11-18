import {
  NativeFlockRoomGroupMigrationLegacy,
  type NativeFlockRoomGroupMigrationOptions
} from './native-flock-room-group-migration'
import type { ProcessFacadeOptions } from '@lody/shared/node/process'
export type NativeScheduleRegistryMigrationOptions = Omit<
  NativeFlockRoomGroupMigrationOptions,
  'domain'
>
/** SR uses its own witness and helper DTO; it shares only process/cleanup ownership. */
export class NativeScheduleRegistryMigrationLegacy extends NativeFlockRoomGroupMigrationLegacy {
  constructor(options: NativeScheduleRegistryMigrationOptions, process: ProcessFacadeOptions = {}) {
    super({ ...options, domain: 'schedule' }, process)
  }
}
